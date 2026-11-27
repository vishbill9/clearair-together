import { z } from 'zod';

/** Allowed pollutant/unit pairs with plausible physical ranges. Anything else is rejected as invalid input. */
export const SENSOR_SPECS = {
  pm25: { units: ['ug/m3'], max: 2000 },
  pm10: { units: ['ug/m3'], max: 3000 },
  co2: { units: ['ppm'], max: 10000 },
  tvoc: { units: ['ppb'], max: 60000 },
  co: { units: ['ppm'], max: 1000 },
  humidity: { units: ['percent'], max: 100 },
} as const;
export type SensorPollutant = keyof typeof SENSOR_SPECS;

export const MAX_READING_AGE_MS = 24 * 3_600_000;
export const FUTURE_SKEW_MS = 5 * 60_000;
export const RECENT_WINDOW_MS = 30 * 60_000;

export const sensorReadingSchema = z
  .object({
    householdId: z.string().uuid(),
    deviceId: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9._:-]+$/),
    deviceLabel: z.string().trim().max(60).optional(),
    pollutant: z.enum(Object.keys(SENSOR_SPECS) as [SensorPollutant, ...SensorPollutant[]]),
    unit: z.string().max(12),
    value: z.number().finite().min(0),
    measuredAt: z.string().datetime(),
    calibratedAt: z.string().datetime().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const spec = SENSOR_SPECS[v.pollutant];
    if (!(spec.units as readonly string[]).includes(v.unit))
      ctx.addIssue({
        code: 'custom',
        path: ['unit'],
        message: `unit for ${v.pollutant} must be one of ${spec.units.join(', ')}`,
      });
    if (v.value > spec.max)
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: `value exceeds the plausible range for ${v.pollutant}`,
      });
  });

export function checkReadingTime(measuredAt: Date, now: Date): string | null {
  const t = measuredAt.getTime();
  if (t > now.getTime() + FUTURE_SKEW_MS) return 'measuredAt cannot be in the future';
  if (t < now.getTime() - MAX_READING_AGE_MS) return 'measuredAt is too old (maximum 24 hours)';
  return null;
}

/** WHO 2021 air quality guideline values (24-hour mean). Used only as a reference line, never as an AQI. */
export const WHO_24H_GUIDELINE: Partial<Record<SensorPollutant, { value: number; unit: string }>> = {
  pm25: { value: 15, unit: 'µg/m³' },
  pm10: { value: 45, unit: 'µg/m³' },
};

export interface IndoorStatus {
  status: 'measured' | 'no_recent_sensor_data';
  /** Measured values only exist when a real, recent, sensor-backed reading exists. */
  measuredAqi: null;
  readings: Array<{
    pollutant: string;
    value: number;
    unit: string;
    measuredAt: string;
    deviceId: string;
    calibrated: boolean;
    reference?: { guideline: string; relation: 'above' | 'at_or_below' };
  }>;
  message: string;
}

export function buildIndoorStatus(
  rows: Array<{
    pollutant: string;
    value: number;
    unit: string;
    measuredAt: Date;
    deviceId: string;
    calibratedAt: Date | null;
  }>,
  now: Date,
): IndoorStatus {
  const recent = rows.filter((r) => now.getTime() - r.measuredAt.getTime() <= RECENT_WINDOW_MS);
  if (recent.length === 0) {
    return {
      status: 'no_recent_sensor_data',
      measuredAqi: null,
      readings: [],
      message: 'No recent sensor reading. Indoor air quality is not measured.',
    };
  }
  const latest = new Map<string, (typeof recent)[number]>();
  for (const r of recent) {
    const k = `${r.deviceId}|${r.pollutant}`;
    const cur = latest.get(k);
    if (!cur || r.measuredAt > cur.measuredAt) latest.set(k, r);
  }
  return {
    status: 'measured',
    measuredAqi: null,
    message: 'Readings come from your own sensor. They are shown as measured concentrations, not as an AQI.',
    readings: [...latest.values()].map((r) => {
      const g = WHO_24H_GUIDELINE[r.pollutant as SensorPollutant];
      return {
        pollutant: r.pollutant,
        value: r.value,
        unit: r.unit,
        measuredAt: r.measuredAt.toISOString(),
        deviceId: r.deviceId,
        calibrated: r.calibratedAt !== null,
        ...(g && r.unit === 'ug/m3'
          ? {
              reference: {
                guideline: `WHO 2021 24-hour guideline ${g.value} ${g.unit}`,
                relation: r.value > g.value ? ('above' as const) : ('at_or_below' as const),
              },
            }
          : {}),
      };
    }),
  };
}
