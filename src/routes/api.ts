import type { FastifyInstance } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { audit, ensureUser, requireDb, requireUser, type AppContext } from '../context.js';
import { AppError, notConfigured, notFound } from '../errors.js';
import { ok } from '../envelope.js';
import {
  airQualitySnapshots,
  communityChallenges,
  communityParticipation,
  householdConstraints,
  householdMembers,
  households,
  recommendations,
} from '../db/schema.js';
import { currentQuerySchema, forecastQuerySchema, locationKey, roundCoordinate } from '../google/request.js';
import { buildDailyPlan, type PlanHousehold } from '../domain/plan.js';
import { compareRoutines, type CommuteMode } from '../domain/impact.js';
import { overallSeverity } from '../google/severity.js';
import { assistantRequestSchema } from '../ai/schema.js';
import { isEmergencyMessage } from '../ai/emergency.js';
import { AiProviderError } from '../ai/provider.js';
import type { HouseholdContext } from '../ai/assistant.js';
import {
  challengeSummary,
  getOwnedHousehold,
  getOwnedRecommendation,
  recordFeedback,
  savePlanItems,
} from '../repo.js';
import { CSRF_COOKIE } from '../security/session.js';
import { parse, uuidParam } from './validate.js';

const COMMUTE = ['walk', 'cycle', 'bus', 'metro', 'car', 'two_wheeler', 'rideshare', 'unknown'] as const;
const constraintsSchema = z
  .object({
    commuteMode: z.enum(COMMUTE).default('unknown'),
    canWorkFromHome: z.boolean().default(false),
    hasAirPurifier: z.boolean().default(false),
    hasPets: z.boolean().default(false),
    cookingFuel: z
      .enum(['lpg', 'electric', 'induction', 'piped_gas', 'biomass', 'unknown'])
      .default('unknown'),
    budgetLevel: z.enum(['low', 'medium', 'high', 'unknown']).default('unknown'),
    timeFlexibility: z.enum(['fixed', 'some', 'high', 'unknown']).default('unknown'),
  })
  .strict();

const householdCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    approximateLabel: z.string().trim().max(120).optional(),
    countryCode: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    languageCode: z
      .string()
      .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/)
      .default('en'),
    members: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(40),
            ageGroup: z.enum(['child', 'adult', 'older_adult']),
            needsExtraCaution: z.boolean().default(false),
          })
          .strict(),
      )
      .max(12)
      .default([]),
    constraints: constraintsSchema.default(() => constraintsSchema.parse({})),
  })
  .strict();

const feedbackSchema = z
  .object({
    eventType: z.enum(['helpful', 'not_helpful', 'done', 'not_feasible']),
    note: z.string().trim().max(280).optional(),
  })
  .strict();

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
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
  })
  .strict()
  .refine((v) => Date.parse(v.endsAt) > Date.parse(v.startsAt), {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  });

const compareSchema = z
  .object({
    householdId: z.string().uuid(),
    candidates: z
      .array(z.enum(['work_from_home', 'walk', 'cycle', 'bus', 'metro', 'car', 'two_wheeler', 'rideshare']))
      .min(1)
      .max(8),
  })
  .strict();

const planBodySchema = z.object({}).strict();
const MAX_HOUSEHOLDS_PER_USER = 5;

export async function registerApi(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const cfg = ctx.config;
  const heavy = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  app.get('/health', async (req) => {
    let database: 'ok' | 'down' | 'not_configured' = 'not_configured';
    if (ctx.dbh) {
      try {
        await ctx.dbh.sql`select 1`;
        database = 'ok';
      } catch {
        database = 'down';
      }
    }
    return ok(req.id, {
      status: database === 'down' ? 'degraded' : 'ok',
      time: ctx.now().toISOString(),
      database,
      integrations: cfg.integrations,
    });
  });

  app.get('/api/v1/config', async (req) =>
    ok(req.id, {
      integrations: cfg.integrations,
      maxForecastHours: cfg.airQuality.maxForecastHours,
      cacheTtlSeconds: cfg.airQuality.cacheTtlSeconds,
      environment: cfg.env,
    }),
  );

  app.get('/api/v1/session', async (req) => {
    const token = req.cookies[CSRF_COOKIE] ?? null;
    let authenticated = false;
    if (ctx.dbh) {
      try {
        await requireUser(ctx, req);
        authenticated = true;
      } catch {
        authenticated = false;
      }
    }
    return ok(req.id, { csrfToken: token, authenticated });
  });

  // ---- Air quality (Google only) ------------------------------------------------------------------
  app.get('/api/v1/air-quality', async (req) => {
    const q = parse(currentQuerySchema, req.query);
    const r = await ctx.aq.getCurrent({ lat: q.lat, lng: q.lng, languageCode: q.languageCode });
    return ok(req.id, {
      status: r.status,
      reason: r.reason ?? null,
      snapshot: r.snapshot,
      severity: r.snapshot ? overallSeverity(r.snapshot) : 'unknown',
      attribution: 'Air-quality data: Google Air Quality API',
    });
  });

  app.get('/api/v1/air-quality/forecast', async (req) => {
    const q = parse(forecastQuerySchema(cfg.airQuality.maxForecastHours, ctx.now), req.query);
    const now = ctx.now();
    const start = q.start ?? new Date(Math.ceil(now.getTime() / 3_600_000) * 3_600_000).toISOString();
    const end =
      q.end ??
      new Date(Date.parse(start) + Math.min(24, cfg.airQuality.maxForecastHours) * 3_600_000).toISOString();
    const r = await ctx.aq.getForecast({ lat: q.lat, lng: q.lng, languageCode: q.languageCode }, start, end);
    return ok(req.id, {
      status: r.status,
      reason: r.reason ?? null,
      forecast: r.forecast,
      window: { start, end },
      attribution: 'Air-quality data: Google Air Quality API',
    });
  });

  // ---- Households ---------------------------------------------------------------------------------
  app.post('/api/v1/households', heavy, async (req, reply) => {
    const body = parse(householdCreateSchema, req.body);
    const db = requireDb(ctx);
    const userId = await ensureUser(ctx, req, reply);
    const [{ n } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(households)
      .where(eq(households.ownerUserId, userId));
    if (n >= MAX_HOUSEHOLDS_PER_USER)
      throw new AppError(
        'conflict',
        409,
        `A maximum of ${MAX_HOUSEHOLDS_PER_USER} households is allowed per account.`,
      );

    const created = await db.transaction(async (tx) => {
      const [h] = await tx
        .insert(households)
        .values({
          ownerUserId: userId,
          name: body.name,
          latitude: roundCoordinate(body.lat),
          longitude: roundCoordinate(body.lng),
          approximateLabel: body.approximateLabel ?? null,
          countryCode: body.countryCode ?? null,
          languageCode: body.languageCode,
        })
        .returning();
      if (!h) throw new AppError('internal_error', 500, 'Could not create household.');
      if (body.members.length)
        await tx.insert(householdMembers).values(body.members.map((m) => ({ ...m, householdId: h.id })));
      await tx.insert(householdConstraints).values({ householdId: h.id, ...body.constraints });
      return h;
    });
    await audit(ctx, req, {
      userId,
      type: 'household.create',
      resourceType: 'household',
      resourceId: created.id,
    });
    reply.code(201);
    return ok(req.id, publicHousehold((await getOwnedHousehold(db, userId, created.id))!));
  });

  app.get('/api/v1/households/:id', async (req) => {
    const { id } = parse(uuidParam, req.params);
    const db = requireDb(ctx);
    const userId = await requireUser(ctx, req);
    const h = await getOwnedHousehold(db, userId, id);
    if (!h) throw notFound('Household');
    return ok(req.id, publicHousehold(h));
  });

  app.put('/api/v1/households/:id/constraints', async (req) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(constraintsSchema, req.body);
    const db = requireDb(ctx);
    const userId = await requireUser(ctx, req);
    const h = await getOwnedHousehold(db, userId, id);
    if (!h) throw notFound('Household');
    await db
      .insert(householdConstraints)
      .values({ householdId: id, ...body })
      .onConflictDoUpdate({
        target: householdConstraints.householdId,
        set: { ...body, updatedAt: ctx.now() },
      });
    await audit(ctx, req, {
      userId,
      type: 'household.constraints.update',
      resourceType: 'household',
      resourceId: id,
    });
    return ok(req.id, publicHousehold((await getOwnedHousehold(db, userId, id))!));
  });

  app.post('/api/v1/households/:id/daily-plan', heavy, async (req) => {
    const { id } = parse(uuidParam, req.params);
    parse(planBodySchema, req.body ?? {});
    const db = requireDb(ctx);
    const userId = await requireUser(ctx, req);
    const h = await getOwnedHousehold(db, userId, id);
    if (!h) throw notFound('Household');
    const aq = await ctx.aq.getCurrent({
      lat: h.household.latitude,
      lng: h.household.longitude,
      languageCode: h.household.languageCode,
    });
    const plan = buildDailyPlan(aq, toPlanHousehold(h));
    const planDate = ctx.now().toISOString().slice(0, 10);

    let snapshotId: string | null = null;
    if (aq.snapshot) {
      const key = locationKey(h.household.latitude, h.household.longitude, h.household.languageCode);
      const [s] = await db
        .select({ id: airQualitySnapshots.id })
        .from(airQualitySnapshots)
        .where(eq(airQualitySnapshots.locationKey, key))
        .orderBy(desc(airQualitySnapshots.fetchedAt))
        .limit(1);
      snapshotId = s?.id ?? null;
    }
    const existing = await db
      .select()
      .from(recommendations)
      .where(and(eq(recommendations.householdId, id), eq(recommendations.planDate, planDate)));
    const byTitle = new Map(existing.map((r) => [r.title, r.id]));
    const all = [...plan.items, ...plan.indoorQuickWins];
    const fresh = all.filter((i) => !byTitle.has(i.title));
    const saved = await savePlanItems(db, id, snapshotId, planDate, fresh);
    for (const r of saved) byTitle.set(r.title, r.id);
    const withIds = (xs: typeof all) => xs.map((i) => ({ ...i, id: byTitle.get(i.title) ?? null }));
    return ok(req.id, {
      ...plan,
      items: withIds(plan.items),
      indoorQuickWins: withIds(plan.indoorQuickWins),
      planDate,
    });
  });

  // ---- Assistant ----------------------------------------------------------------------------------
  app.post(
    '/api/v1/assistant/messages',
    { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } },
    async (req) => {
      const body = parse(assistantRequestSchema, req.body);
      const emergency = isEmergencyMessage(body.message);
      if (!emergency && !ctx.assistant.configured) throw notConfigured('The assistant');

      let hh: HouseholdContext | null = null;
      let lat = body.lat;
      let lng = body.lng;
      let language = body.languageCode;
      let userId: string | null = null;
      if (body.householdId) {
        const db = requireDb(ctx);
        userId = await requireUser(ctx, req);
        const h = await getOwnedHousehold(db, userId, body.householdId);
        if (!h) throw notFound('Household');
        const ph = toPlanHousehold(h);
        hh = { members: ph.members, constraints: ph.constraints, countryCode: h.household.countryCode };
        lat = h.household.latitude;
        lng = h.household.longitude;
        language = h.household.languageCode;
      }

      let aq: Awaited<ReturnType<typeof ctx.aq.getCurrent>> = {
        snapshot: null,
        status: 'unavailable',
        reason: 'No location provided.',
      };
      if (!emergency && lat !== undefined && lng !== undefined) {
        aq = await ctx.aq.getCurrent({ lat, lng, languageCode: language });
      }
      try {
        const result = await ctx.assistant.answer({ message: body.message, aq, household: hh });
        await audit(ctx, req, {
          userId,
          type:
            result.kind === 'emergency'
              ? 'assistant.emergency'
              : result.blocked
                ? 'assistant.blocked'
                : 'assistant.answer',
          metadata: result.kind === 'answer' && result.blocked ? { rules: result.violations } : {},
        });
        return ok(req.id, result);
      } catch (e) {
        if (e instanceof AiProviderError) {
          if (e.kind === 'bad_response')
            throw new AppError(
              'ai_bad_output',
              502,
              'The assistant returned an unusable answer. Please try again.',
            );
          throw new AppError('ai_unavailable', 503, 'The assistant is temporarily unavailable.');
        }
        throw e;
      }
    },
  );

  // ---- Scenarios ----------------------------------------------------------------------------------
  app.post('/api/v1/scenarios/compare', heavy, async (req) => {
    const body = parse(compareSchema, req.body);
    const db = requireDb(ctx);
    const userId = await requireUser(ctx, req);
    const h = await getOwnedHousehold(db, userId, body.householdId);
    if (!h) throw notFound('Household');
    const aq = await ctx.aq.getCurrent({
      lat: h.household.latitude,
      lng: h.household.longitude,
      languageCode: h.household.languageCode,
    });
    const severity = aq.snapshot ? overallSeverity(aq.snapshot) : 'unknown';
    const current = (h.constraints?.commuteMode ?? 'unknown') as CommuteMode;
    const options = compareRoutines({
      current,
      candidates: body.candidates,
      severity,
      canWorkFromHome: Boolean(h.constraints?.canWorkFromHome),
    });
    return ok(req.id, {
      status: aq.status,
      reason: aq.reason ?? null,
      currentRoutine: current,
      severity,
      options,
      note: 'Exposure and emissions are shown separately. Effects are qualitative and based on general rules, not measurements.',
    });
  });

  // ---- Feedback -----------------------------------------------------------------------------------
  app.post('/api/v1/recommendations/:id/feedback', async (req, reply) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(feedbackSchema, req.body);
    const db = requireDb(ctx);
    const userId = await requireUser(ctx, req);
    const rec = await getOwnedRecommendation(db, userId, id);
    if (!rec) throw notFound('Recommendation');
    await recordFeedback(db, id, userId, body.eventType, body.note ?? null);
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

  // ---- Community (aggregate only) -----------------------------------------------------------------
  app.post('/api/v1/community/challenges', heavy, async (req, reply) => {
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
    const summary = await challengeSummary(db, id);
    if (!summary) throw notFound('Challenge');
    await db.insert(communityParticipation).values({ challengeId: id, userId }).onConflictDoNothing();
    return ok(req.id, await challengeSummary(db, id));
  });

  app.post('/api/v1/community/challenges/:id/actions', async (req) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ actionKey: z.enum(ACTION_KEYS) }).strict(), req.body);
    const db = requireDb(ctx);
    const userId = await requireUser(ctx, req);
    const updated = await db
      .update(communityParticipation)
      .set({
        completedActionKeys: sql`(select array(select distinct unnest(${communityParticipation.completedActionKeys} || ${body.actionKey}::text)))`,
      })
      .where(and(eq(communityParticipation.challengeId, id), eq(communityParticipation.userId, userId)))
      .returning({ id: communityParticipation.id });
    if (!updated[0]) throw notFound('Challenge participation');
    return ok(req.id, await challengeSummary(db, id));
  });

  // Aggregate-only and k-anonymised; the unguessable id is the capability for sharing a challenge link.
  app.get('/api/v1/community/challenges/:id/summary', async (req) => {
    const { id } = parse(uuidParam, req.params);
    const db = requireDb(ctx);
    const s = await challengeSummary(db, id);
    if (!s) throw notFound('Challenge');
    return ok(req.id, s);
  });
}

function toPlanHousehold(h: NonNullable<Awaited<ReturnType<typeof getOwnedHousehold>>>): PlanHousehold {
  return {
    members: h.members.map((m) => ({ ageGroup: m.ageGroup, needsExtraCaution: m.needsExtraCaution })),
    constraints: h.constraints
      ? {
          commuteMode: h.constraints.commuteMode,
          canWorkFromHome: h.constraints.canWorkFromHome,
          hasAirPurifier: h.constraints.hasAirPurifier,
          hasPets: h.constraints.hasPets,
          cookingFuel: h.constraints.cookingFuel,
          budgetLevel: h.constraints.budgetLevel,
          timeFlexibility: h.constraints.timeFlexibility,
        }
      : null,
  };
}

function publicHousehold(h: NonNullable<Awaited<ReturnType<typeof getOwnedHousehold>>>) {
  const ph = toPlanHousehold(h);
  return {
    id: h.household.id,
    name: h.household.name,
    location: {
      latitude: h.household.latitude,
      longitude: h.household.longitude,
      approximateLabel: h.household.approximateLabel,
    },
    countryCode: h.household.countryCode,
    languageCode: h.household.languageCode,
    members: h.members.map((m) => ({
      id: m.id,
      label: m.label,
      ageGroup: m.ageGroup,
      needsExtraCaution: m.needsExtraCaution,
    })),
    constraints: ph.constraints,
    createdAt: h.household.createdAt.toISOString(),
  };
}
