import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gt, lt } from 'drizzle-orm';
import { z } from 'zod';
import { requireDb, requireUser, type AppContext } from '../context.js';
import { AppError, notFound } from '../errors.js';
import { ok } from '../envelope.js';
import { indoorSensorReadings } from '../db/schema.js';
import { getOwnedHousehold } from '../repo.js';
import {
  buildIndoorStatus,
  checkReadingTime,
  sensorReadingSchema,
  MAX_READING_AGE_MS,
} from '../indoor/sensor.js';
import { parse } from './validate.js';

export async function registerIndoor(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post(
    '/api/v1/indoor/sensor-reading',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = parse(sensorReadingSchema, req.body);
      const db = requireDb(ctx);
      const userId = await requireUser(ctx, req);
      const hh = await getOwnedHousehold(db, userId, body.householdId);
      if (!hh) throw notFound('Household');
      const measuredAt = new Date(body.measuredAt);
      const timeErr = checkReadingTime(measuredAt, ctx.now());
      if (timeErr)
        throw new AppError('validation_error', 400, 'The request was not valid.', [
          { path: 'measuredAt', message: timeErr },
        ]);
      const [row] = await db
        .insert(indoorSensorReadings)
        .values({
          householdId: body.householdId,
          deviceId: body.deviceId,
          deviceLabel: body.deviceLabel ?? null,
          pollutant: body.pollutant,
          unit: body.unit,
          value: body.value,
          measuredAt,
          calibratedAt: body.calibratedAt ? new Date(body.calibratedAt) : null,
        })
        .returning({ id: indoorSensorReadings.id });
      reply.code(201);
      return ok(req.id, { id: row?.id });
    },
  );

  app.get('/api/v1/indoor/status', async (req) => {
    const q = parse(z.object({ householdId: z.string().uuid() }).strict(), req.query);
    const db = requireDb(ctx);
    const userId = await requireUser(ctx, req);
    const hh = await getOwnedHousehold(db, userId, q.householdId);
    if (!hh) throw notFound('Household');
    const since = new Date(ctx.now().getTime() - MAX_READING_AGE_MS);
    const rows = await db
      .select()
      .from(indoorSensorReadings)
      .where(
        and(eq(indoorSensorReadings.householdId, q.householdId), gt(indoorSensorReadings.measuredAt, since)),
      )
      .orderBy(desc(indoorSensorReadings.measuredAt))
      .limit(200);
    return ok(req.id, buildIndoorStatus(rows, ctx.now()));
  });
}

/** Deletes old sensor readings. Intended to run on a timer and from tests. */
export async function purgeExpired(ctx: AppContext): Promise<{ readings: number }> {
  const db = requireDb(ctx);
  const now = ctx.now();
  const rd = await db
    .delete(indoorSensorReadings)
    .where(lt(indoorSensorReadings.receivedAt, new Date(now.getTime() - 30 * 86_400_000)))
    .returning({ id: indoorSensorReadings.id });
  return { readings: rd.length };
}
