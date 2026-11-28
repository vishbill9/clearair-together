import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { audit, ensureUser, requireDb, requireUser, type AppContext } from '../context.js';
import { communityChallenges, communityParticipation } from '../db/schema.js';
import { AppError, notFound } from '../errors.js';
import { ok } from '../envelope.js';
import { challengeSummary } from '../repo.js';
import { HEAVY } from './shared.js';
import { parse, uuidParam } from './validate.js';

const ACTION_KEYS = [
  'shift_exercise',
  'close_windows_peak',
  'run_purifier',
  'cooking_exhaust',
  'no_indoor_smoke',
  'low_emission_trip',
] as const;

const challengeSchema = z
  .object({
    title: z.string().trim().min(3).max(100),
    description: z.string().trim().max(500).default(''),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
  })
  .strict()
  .refine((v) => Date.parse(v.endsAt) > Date.parse(v.startsAt), {
    error: 'endsAt must be after startsAt',
    path: ['endsAt'],
  });

const actionSchema = z.object({ actionKey: z.enum(ACTION_KEYS) }).strict();

/** Community challenges. Responses are aggregate-only and k-anonymised (see `challengeSummary`). */
export function registerCommunityRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/v1/community/challenges', HEAVY, async (req, reply) => {
    const body = parse(challengeSchema, req.body);
    const db = requireDb(ctx);
    const userId = await ensureUser(ctx, req, reply);
    const [c] = await db
      .insert(communityChallenges)
      .values({
        createdBy: userId,
        title: body.title,
        description: body.description,
        startsAt: new Date(body.startsAt),
        endsAt: new Date(body.endsAt),
      })
      .returning();
    if (!c) throw new AppError('internal_error', 500, 'Could not create challenge.');
    await db.insert(communityParticipation).values({ challengeId: c.id, userId });
    await audit(ctx, req, { userId, type: 'challenge.create', resourceType: 'challenge', resourceId: c.id });
    reply.code(201);
    return ok(req.id, await challengeSummary(db, c.id));
  });

  app.post('/api/v1/community/challenges/:id/join', async (req, reply) => {
    const { id } = parse(uuidParam, req.params);
    const db = requireDb(ctx);
    const userId = await ensureUser(ctx, req, reply);
    if (!(await challengeSummary(db, id))) throw notFound('Challenge');
    await db.insert(communityParticipation).values({ challengeId: id, userId }).onConflictDoNothing();
    return ok(req.id, await challengeSummary(db, id));
  });

  app.post('/api/v1/community/challenges/:id/actions', async (req) => {
    const { id } = parse(uuidParam, req.params);
    const { actionKey } = parse(actionSchema, req.body);
    const db = requireDb(ctx);
    const userId = await requireUser(ctx, req);
    const keys = communityParticipation.completedActionKeys;
    const updated = await db
      .update(communityParticipation)
      .set({
        completedActionKeys: sql`(select array(select distinct unnest(${keys} || ${actionKey}::text)))`,
      })
      .where(and(eq(communityParticipation.challengeId, id), eq(communityParticipation.userId, userId)))
      .returning({ id: communityParticipation.id });
    if (!updated[0]) throw notFound('Challenge participation');
    return ok(req.id, await challengeSummary(db, id));
  });

  // The unguessable id is the capability for sharing a challenge link.
  app.get('/api/v1/community/challenges/:id/summary', async (req) => {
    const { id } = parse(uuidParam, req.params);
    const s = await challengeSummary(requireDb(ctx), id);
    if (!s) throw notFound('Challenge');
    return ok(req.id, s);
  });
}
