import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { ok } from '../envelope.js';
import { currentQuerySchema, forecastQuerySchema } from '../google/request.js';
import { overallSeverity } from '../google/severity.js';
import { ATTRIBUTION } from './shared.js';
import { parse } from './validate.js';

const HOUR_MS = 3_600_000;

/** Default forecast window: from the next full hour, up to 24 hours (or the configured maximum). */
export function forecastWindow(now: Date, maxHours: number, start?: string, end?: string) {
  const from = start ?? new Date(Math.ceil(now.getTime() / HOUR_MS) * HOUR_MS).toISOString();
  const to = end ?? new Date(Date.parse(from) + Math.min(24, maxHours) * HOUR_MS).toISOString();
  return { start: from, end: to };
}

/** Google Air Quality data only; every response says whether real data is available. */
export async function registerAirQualityRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const maxHours = ctx.config.airQuality.maxForecastHours;

  app.get('/api/v1/air-quality', async (req) => {
    const q = parse(currentQuerySchema, req.query);
    const r = await ctx.aq.getCurrent({ lat: q.lat, lng: q.lng, languageCode: q.languageCode });
    return ok(req.id, {
      status: r.status,
      reason: r.reason ?? null,
      snapshot: r.snapshot,
      severity: r.snapshot ? overallSeverity(r.snapshot) : 'unknown',
      attribution: ATTRIBUTION,
    });
  });

  app.get('/api/v1/air-quality/forecast', async (req) => {
    const q = parse(forecastQuerySchema(maxHours, ctx.now), req.query);
    const window = forecastWindow(ctx.now(), maxHours, q.start, q.end);
    const r = await ctx.aq.getForecast(
      { lat: q.lat, lng: q.lng, languageCode: q.languageCode },
      window.start,
      window.end,
    );
    return ok(req.id, {
      status: r.status,
      reason: r.reason ?? null,
      forecast: r.forecast,
      window,
      attribution: ATTRIBUTION,
    });
  });
}
