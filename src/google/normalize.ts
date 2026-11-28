import { z } from 'zod';
import type { AirQualityIndex, AirQualitySnapshot, ForecastHour, Pollutant } from './types.js';
import { roundCoordinate } from './request.js';

/** Google returned a body that does not match the documented response shape. */
export class MalformedResponseError extends Error {}

const concentration = z.object({ value: z.number().optional(), units: z.string().optional() }).loose();

const indexSchema = z
  .object({
    code: z.string().min(1).max(40),
    displayName: z.string().max(120).optional(),
    aqi: z.number().optional(),
    aqiDisplay: z.string().max(20).optional(),
    category: z.string().max(120).optional(),
    dominantPollutant: z.string().max(20).optional(),
  })
  .loose();

const pollutantSchema = z
  .object({
    code: z.string().min(1).max(20),
    displayName: z.string().max(60).optional(),
    fullName: z.string().max(120).optional(),
    concentration: concentration.optional(),
  })
  .loose();

const hourSchema = z
  .object({
    dateTime: z.string().min(10).max(40),
    regionCode: z.string().max(8).optional(),
    indexes: z.array(indexSchema).max(20).optional(),
    pollutants: z.array(pollutantSchema).max(30).optional(),
    healthRecommendations: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

const currentResponseSchema = hourSchema;

export const forecastResponseSchema = z
  .object({
    hourlyForecasts: z.array(hourSchema).max(1000).optional(),
    regionCode: z.string().max(8).optional(),
    nextPageToken: z.string().max(4096).optional(),
  })
  .loose();

const UNIT_LABELS: Record<string, string> = {
  MICROGRAMS_PER_CUBIC_METER: 'µg/m³',
  PARTS_PER_BILLION: 'ppb',
  PARTS_PER_MILLION: 'ppm',
};

function toUtcIso(value: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms))
    throw new MalformedResponseError(`Unparseable timestamp from upstream: ${value.slice(0, 40)}`);
  return new Date(ms).toISOString();
}

/** The numeric AQI, falling back to the number in the display string. Never invents a value. */
function indexValue(i: z.infer<typeof indexSchema>): number | undefined {
  const fromDisplay = i.aqiDisplay ? /\d+(\.\d+)?/.exec(i.aqiDisplay)?.[0] : undefined;
  const aqi = i.aqi ?? (fromDisplay === undefined ? undefined : Number(fromDisplay));
  return aqi !== undefined && Number.isFinite(aqi) ? aqi : undefined;
}

function normalizeIndexes(raw: z.infer<typeof indexSchema>[] | undefined): AirQualityIndex[] {
  return (raw ?? []).flatMap((i) => {
    const aqi = indexValue(i);
    if (aqi === undefined) return [];
    const entry: AirQualityIndex = {
      code: i.code,
      displayName: i.displayName ?? i.code,
      aqi,
      category: i.category ?? 'Unknown',
    };
    if (i.dominantPollutant) entry.dominantPollutant = i.dominantPollutant;
    return [entry];
  });
}

function normalizePollutants(raw: z.infer<typeof pollutantSchema>[] | undefined): Pollutant[] {
  const out: Pollutant[] = [];
  for (const p of raw ?? []) {
    const value = p.concentration?.value;
    const units = p.concentration?.units;
    if (value === undefined || !units) continue;
    out.push({
      code: p.code,
      displayName: p.displayName ?? p.fullName ?? p.code,
      value,
      units: UNIT_LABELS[units] ?? units,
    });
  }
  return out;
}

function normalizeHealth(raw: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 1000);
  }
  return Object.keys(out).length ? out : undefined;
}

/** Validates a current-conditions response and maps it to our snapshot type; throws if malformed. */
export function normalizeCurrent(
  body: unknown,
  ctx: { latitude: number; longitude: number; fetchedAt: Date; approximateLabel?: string },
): AirQualitySnapshot {
  const parsed = currentResponseSchema.safeParse(body);
  if (!parsed.success)
    throw new MalformedResponseError('Current-conditions response did not match the expected shape.');
  const r = parsed.data;
  const indexes = normalizeIndexes(r.indexes);
  const pollutants = normalizePollutants(r.pollutants);
  if (indexes.length === 0 && pollutants.length === 0) {
    throw new MalformedResponseError(
      'Current-conditions response contained no usable index or pollutant values.',
    );
  }
  const snapshot: AirQualitySnapshot = {
    source: 'google_air_quality',
    location: { latitude: roundCoordinate(ctx.latitude), longitude: roundCoordinate(ctx.longitude) },
    observedAt: toUtcIso(r.dateTime),
    fetchedAt: ctx.fetchedAt.toISOString(),
    indexes,
    pollutants,
    freshness: 'fresh',
  };
  if (ctx.approximateLabel) snapshot.location.approximateLabel = ctx.approximateLabel;
  const regionCode = r.regionCode;
  if (regionCode) snapshot.regionCode = regionCode.toUpperCase();
  const health = normalizeHealth(r.healthRecommendations);
  if (health) snapshot.healthRecommendations = health;
  return snapshot;
}

/** Maps one forecast hour; null when it carries no index or pollutant data. */
export function normalizeForecastHour(raw: z.infer<typeof hourSchema>): ForecastHour | null {
  const indexes = normalizeIndexes(raw.indexes);
  const pollutants = normalizePollutants(raw.pollutants);
  if (indexes.length === 0 && pollutants.length === 0) return null;
  const hour: ForecastHour = { forecastAt: toUtcIso(raw.dateTime), indexes, pollutants };
  const health = normalizeHealth(raw.healthRecommendations);
  if (health) hour.healthRecommendations = health;
  return hour;
}
