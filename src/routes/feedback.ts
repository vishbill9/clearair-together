import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, requireDb, requireUser, type AppContext } from '../context.js';
import { notFound } from '../errors.js';
import { ok } from '../envelope.js';
import { getOwnedRecommendation, recordFeedback } from '../repo.js';
import { parse, uuidParam } from './validate.js';

const feedbackSchema = z
  .object({
    eventType: z.enum(['helpful', 'not_helpful', 'done', 'not_feasible']),
    note: z.string().trim().max(280).optional(),
  })
  .strict();

/** Feedback on a recommendation the user owns. */
export async function registerFeedbackRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/api/v1/recommendations/:id/feedback', async (req, reply) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(feedbackSchema, req.body);
    const db = requireDb(ctx);
    const userId = await requireUser(ctx, req);
    if (!(await getOwnedRecommendation(db, userId, id))) throw notFound('Recommendation');
    await recordFeedback(db, {
      recommendationId: id,
      userId,
      eventType: body.eventType,
      note: body.note ?? null,
    });
    await audit(ctx, req, {
      userId,
      type: 'recommendation.feedback',
      resourceType: 'recommendation',
      resourceId: id,
      metadata: { eventType: body.eventType },
    });
    reply.code(201);
    return ok(req.id, { recommendationId: id, eventType: body.eventType });
  });
}
