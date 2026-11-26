import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { and, desc, eq, gt, lt } from 'drizzle-orm';
import { z } from 'zod';
import { audit, requireDb, requireUser, type AppContext } from '../context.js';
import { AppError, notConfigured, notFound } from '../errors.js';
import { ok } from '../envelope.js';
import { indoorImages, indoorSensorReadings } from '../db/schema.js';
import { getOwnedHousehold } from '../repo.js';
import { normalizeImage } from '../indoor/image.js';
import { seal } from '../indoor/crypto.js';
import {
  buildIndoorStatus,
  checkReadingTime,
  sensorReadingSchema,
  MAX_READING_AGE_MS,
} from '../indoor/sensor.js';
import {
  VISION_SYSTEM,
  VISUAL_DISCLAIMER,
  purifierAdvice,
  validateVisualOutput,
  type IndoorVisualAssessment,
} from '../indoor/visual.js';
import type { VisionProvider } from '../indoor/gemini-vision.js';
import { AiProviderError } from '../ai/provider.js';
import { parse, uuidParam } from './validate.js';

const numField = (max: number) => z.coerce.number().positive().max(max).optional();
const visualFieldsSchema = z
  .object({
    householdId: z.string().uuid(),
    storeImage: z.enum(['true', 'false']).default('false'),
    consent: z.enum(['true', 'false']).default('false'),
    roomAreaM2: numField(1000),
    ceilingHeightM: numField(10),
    cadrM3h: numField(5000),
  })
  .strict();

export async function registerIndoor(
  app: FastifyInstance,
  ctx: AppContext,
  vision: VisionProvider | null,
): Promise<void> {
  const cfg = ctx.config;

  await app.register(async (scope) => {
    await scope.register(multipart, {
      limits: {
        fileSize: cfg.images.maxBytes,
        files: 1,
        fields: 8,
        fieldSize: 256,
        fieldNameSize: 40,
        parts: 10,
      },
      throwFileSizeLimit: true,
    });

    scope.post(
      '/api/v1/indoor/visual-assessment',
      { config: { rateLimit: { max: cfg.images.visionRateLimitPerMinute, timeWindow: '1 minute' } } },
      async (req, reply) => {
        if (!vision || !cfg.integrations.vision) throw notConfigured('Camera assessment');
        const db = requireDb(ctx);
        const userId = await requireUser(ctx, req);

        const fields: Record<string, string> = {};
        let file: { data: Buffer; mime: string } | null = null;
        try {
          for await (const part of req.parts()) {
            if (part.type === 'file') {
              if (part.fieldname !== 'image' || file)
                throw new AppError('validation_error', 400, 'Send exactly one file in the "image" field.');
              file = { data: await part.toBuffer(), mime: part.mimetype };
            } else {
              fields[part.fieldname] = String(part.value);
            }
          }
        } catch (e) {
          if (e instanceof AppError) throw e;
          if ((e as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE')
            throw new AppError('payload_too_large', 413, 'The image is too large.');
          throw new AppError('validation_error', 400, 'The upload could not be read.');
        }
        if (!file) throw new AppError('validation_error', 400, 'An image is required.');
        const f = parse(visualFieldsSchema, fields);

        const hh = await getOwnedHousehold(db, userId, f.householdId);
        if (!hh) throw notFound('Household');

        const img = await normalizeImage(file.data, file.mime, {
          maxBytes: cfg.images.maxBytes,
          maxDimension: cfg.images.maxDimension,
        });

        let raw: string;
        try {
          raw = await vision.assess({
            image: img.data,
            mimeType: img.mimeType,
            system: VISION_SYSTEM,
            timeoutMs: 25_000,
            prompt:
              'Describe possible household air-quality factors visible in this room photo, following the rules. Return JSON only.',
          });
        } catch (e) {
          if (e instanceof AiProviderError)
            throw new AppError('ai_unavailable', 503, 'Camera assessment is temporarily unavailable.');
          throw e;
        }
        let out;
        try {
          out = validateVisualOutput(raw);
        } catch {
          await audit(ctx, req, {
            userId,
            type: 'visual.blocked',
            resourceType: 'household',
            resourceId: f.householdId,
          });
          throw new AppError(
            'ai_bad_output',
            502,
            'The camera assessment could not be validated and was withheld.',
          );
        }

        // Ephemeral by default. Storage requires explicit consent AND a configured encryption key.
        let imageId: string | null = null;
        if (f.storeImage === 'true') {
          if (f.consent !== 'true')
            throw new AppError('validation_error', 400, 'Storing an image requires explicit consent.');
          if (!cfg.images.encryptionKey) throw notConfigured('Encrypted image storage');
          const now = ctx.now();
          const sealed = seal(cfg.images.encryptionKey, img.data, f.householdId);
          const [row] = await db
            .insert(indoorImages)
            .values({
              householdId: f.householdId,
              userId,
              mimeType: img.mimeType,
              ciphertext: sealed.ciphertext,
              iv: sealed.iv,
              authTag: sealed.authTag,
              consentedAt: now,
              expiresAt: new Date(now.getTime() + cfg.images.retentionDays * 86_400_000),
            })
            .returning({ id: indoorImages.id });
          imageId = row?.id ?? null;
        }
        await audit(ctx, req, {
          userId,
          type: 'visual.assess',
          resourceType: 'household',
          resourceId: f.householdId,
          metadata: { stored: imageId !== null, confidence: out.confidence },
        });

        const result: IndoorVisualAssessment = {
          ...out,
          plants: { ...out.plants, optional: true },
          purifier: purifierAdvice({
            roomAreaM2: f.roomAreaM2,
            ceilingHeightM: f.ceilingHeightM,
            cadrM3h: f.cadrM3h,
          }),
          disclaimer: VISUAL_DISCLAIMER,
          stored: imageId !== null,
          imageId,
        };
        reply.code(200);
        return ok(req.id, result);
      },
    );
  });

  app.delete('/api/v1/indoor/images/:id', async (req, reply) => {
    const { id } = parse(uuidParam, req.params);
    const db = requireDb(ctx);
    const userId = await requireUser(ctx, req);
    const del = await db
      .delete(indoorImages)
      .where(and(eq(indoorImages.id, id), eq(indoorImages.userId, userId)))
      .returning({ id: indoorImages.id });
    if (!del[0]) throw notFound('Image');
    await audit(ctx, req, { userId, type: 'visual.image.delete', resourceType: 'image', resourceId: id });
    reply.code(200);
    return ok(req.id, { deleted: true });
  });

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

/** Deletes expired images and old sensor readings. Intended to run on a timer and from tests. */
export async function purgeExpired(ctx: AppContext): Promise<{ images: number; readings: number }> {
  const db = requireDb(ctx);
  const now = ctx.now();
  const imgs = await db
    .delete(indoorImages)
    .where(lt(indoorImages.expiresAt, now))
    .returning({ id: indoorImages.id });
  const rd = await db
    .delete(indoorSensorReadings)
    .where(lt(indoorSensorReadings.receivedAt, new Date(now.getTime() - 30 * 86_400_000)))
    .returning({ id: indoorSensorReadings.id });
  return { images: imgs.length, readings: rd.length };
}
