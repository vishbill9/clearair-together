import { z } from 'zod';

/** Extra computations we allow ourselves to ask Google for. Nothing else is ever sent upstream. */
const ALLOWED_EXTRA_COMPUTATIONS = [
  'HEALTH_RECOMMENDATIONS',
  'DOMINANT_POLLUTANT_CONCENTRATION',
  'POLLUTANT_CONCENTRATION',
  'LOCAL_AQI',
  'POLLUTANT_ADDITIONAL_INFO',
] as const;

const FORECAST_HORIZON_HOURS = 96;
const HOUR_MS = 3_600_000;
const COORDINATE_DECIMALS = 2;

const languageCodeSchema = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/, 'languageCode must be a BCP-47 tag such as "en" or "hi-IN"');

const latitudeSchema = z.coerce.number().refine((n) => Number.isFinite(n) && n >= -90 && n <= 90, {
  message: 'latitude must be between -90 and 90',
});
const longitudeSchema = z.coerce.number().refine((n) => Number.isFinite(n) && n >= -180 && n <= 180, {
  message: 'longitude must be between -180 and 180',
});

/** Coordinates are rounded (about 1 km) for privacy, caching and consistent upstream calls. */
export function roundCoordinate(value: number): number {
  const f = 10 ** COORDINATE_DECIMALS;
  const r = Math.round(value * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

export function locationKey(lat: number, lng: number, languageCode: string): string {
  return `${roundCoordinate(lat).toFixed(COORDINATE_DECIMALS)},${roundCoordinate(lng).toFixed(COORDINATE_DECIMALS)}|${languageCode}`;
}

export const currentQuerySchema = z
  .object({
    lat: latitudeSchema,
    lng: longitudeSchema,
    languageCode: languageCodeSchema.default('en'),
  })
  .strict();

const isoInstant = z
  .string()
  .max(40)
  .refine(
    (v) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v) &&
      !Number.isNaN(Date.parse(v)),
    {
      message: 'must be an RFC 3339 timestamp with a timezone, for example 2026-11-01T06:00:00Z',
    },
  )
  .transform((v) => new Date(v).toISOString());

export function forecastQuerySchema(maxHours: number, now: () => Date = () => new Date()) {
  return z
    .object({
      lat: latitudeSchema,
      lng: longitudeSchema,
      languageCode: languageCodeSchema.default('en'),
      start: isoInstant.optional(),
      end: isoInstant.optional(),
    })
    .strict()
    .superRefine((v, ctx) => {
      if (Boolean(v.start) !== Boolean(v.end)) {
        ctx.addIssue({ code: 'custom', message: 'start and end must be provided together', path: ['end'] });
        return;
      }
      if (!v.start || !v.end) return;
      for (const issue of windowIssues(Date.parse(v.start), Date.parse(v.end), maxHours, now().getTime())) {
        ctx.addIssue({ code: 'custom', ...issue });
      }
    });
}

/** Problems with a requested forecast window, as messages tied to the field to fix. */
function windowIssues(start: number, end: number, maxHours: number, now: number) {
  const issues: Array<{ message: string; path: string[] }> = [];
  if (end <= start) issues.push({ message: 'end must be after start', path: ['end'] });
  if ((end - start) / HOUR_MS > maxHours) {
    issues.push({ message: `the window may not exceed ${maxHours} hours`, path: ['end'] });
  }
  if (end > now + FORECAST_HORIZON_HOURS * HOUR_MS) {
    issues.push({ message: `forecasts reach at most ${FORECAST_HORIZON_HOURS} hours ahead`, path: ['end'] });
  }
  if (start < now - HOUR_MS) issues.push({ message: 'start may not be in the past', path: ['start'] });
  return issues;
}

export interface CurrentConditionsRequest {
  location: { latitude: number; longitude: number };
  extraComputations: string[];
  universalAqi: true;
  languageCode: string;
}

export interface ForecastRequest extends CurrentConditionsRequest {
  period: { startTime: string; endTime: string };
  pageSize: number;
  pageToken?: string;
}

const PAGE_TOKEN = /^[A-Za-z0-9_\-=+/.]{1,2048}$/;
export const isValidPageToken = (t: unknown): t is string => typeof t === 'string' && PAGE_TOKEN.test(t);

export function buildCurrentRequest(q: {
  lat: number;
  lng: number;
  languageCode: string;
}): CurrentConditionsRequest {
  return {
    location: { latitude: roundCoordinate(q.lat), longitude: roundCoordinate(q.lng) },
    extraComputations: [...ALLOWED_EXTRA_COMPUTATIONS],
    universalAqi: true,
    languageCode: q.languageCode,
  };
}

export function buildForecastRequest(
  q: { lat: number; lng: number; languageCode: string },
  startIso: string,
  endIso: string,
  pageToken?: string,
): ForecastRequest {
  if (pageToken !== undefined && !isValidPageToken(pageToken)) throw new Error('Invalid page token.');
  const hours = Math.max(
    1,
    Math.min(FORECAST_HORIZON_HOURS, Math.ceil((Date.parse(endIso) - Date.parse(startIso)) / 3_600_000)),
  );
  const req: ForecastRequest = {
    ...buildCurrentRequest(q),
    period: { startTime: startIso, endTime: endIso },
    pageSize: Math.min(hours, 168),
  };
  if (pageToken) req.pageToken = pageToken;
  return req;
}
