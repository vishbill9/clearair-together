import type { FastifyInstance } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { audit, ensureUser, requireDb, type AppContext } from '../context.js';
import type { Db } from '../db/client.js';
import {
  airQualitySnapshots,
  householdConstraints,
  householdMembers,
  households,
  recommendations,
} from '../db/schema.js';
import { buildDailyPlan, type DailyPlan } from '../domain/plan.js';
import { AppError } from '../errors.js';
import { ok } from '../envelope.js';
import { locationKey, roundCoordinate } from '../google/request.js';
import { getOwnedHousehold, savePlanItems } from '../repo.js';
import {
  currentAirFor,
  HEAVY,
  loadOwnedHousehold,
  publicHousehold,
  toPlanHousehold,
  type OwnedHousehold,
} from './shared.js';
import { parse, uuidParam } from './validate.js';

const COMMUTE = ['walk', 'cycle', 'bus', 'metro', 'car', 'two_wheeler', 'rideshare', 'unknown'] as const;
const MAX_HOUSEHOLDS_PER_USER = 5;

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

const memberSchema = z
  .object({
    label: z.string().trim().min(1).max(40),
    ageGroup: z.enum(['child', 'adult', 'older_adult']),
    needsExtraCaution: z.boolean().default(false),
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
    members: z.array(memberSchema).max(12).default([]),
    constraints: constraintsSchema.default(() => constraintsSchema.parse({})),
  })
  .strict();

type HouseholdInput = z.infer<typeof householdCreateSchema>;

async function assertUnderHouseholdLimit(db: Db, userId: string): Promise<void> {
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(households)
    .where(eq(households.ownerUserId, userId));
  if (n >= MAX_HOUSEHOLDS_PER_USER) {
    throw new AppError(
      'conflict',
      409,
      `A maximum of ${MAX_HOUSEHOLDS_PER_USER} households is allowed per account.`,
    );
  }
}

/** Creates the household, its members and its constraints in one transaction. */
function insertHousehold(db: Db, userId: string, body: HouseholdInput) {
  return db.transaction(async (tx) => {
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
    if (body.members.length) {
      await tx.insert(householdMembers).values(body.members.map((m) => ({ ...m, householdId: h.id })));
    }
    await tx.insert(householdConstraints).values({ householdId: h.id, ...body.constraints });
    return h;
  });
}

async function latestSnapshotId(db: Db, h: OwnedHousehold): Promise<string | null> {
  const key = locationKey(h.household.latitude, h.household.longitude, h.household.languageCode);
  const [s] = await db
    .select({ id: airQualitySnapshots.id })
    .from(airQualitySnapshots)
    .where(eq(airQualitySnapshots.locationKey, key))
    .orderBy(desc(airQualitySnapshots.fetchedAt))
    .limit(1);
  return s?.id ?? null;
}

interface PlanTarget {
  householdId: string;
  snapshotId: string | null;
  planDate: string;
}

/** Saves plan items not yet stored for the day and returns the plan with stable recommendation ids. */
async function persistPlan(db: Db, target: PlanTarget, plan: DailyPlan) {
  const existing = await db
    .select({ id: recommendations.id, title: recommendations.title })
    .from(recommendations)
    .where(
      and(eq(recommendations.householdId, target.householdId), eq(recommendations.planDate, target.planDate)),
    );
  const idByTitle = new Map(existing.map((r) => [r.title, r.id]));
  const all = [...plan.items, ...plan.indoorQuickWins];
  const saved = await savePlanItems(db, { ...target, items: all.filter((i) => !idByTitle.has(i.title)) });
  for (const r of saved) idByTitle.set(r.title, r.id);
  const withIds = (xs: typeof all) => xs.map((i) => ({ ...i, id: idByTitle.get(i.title) ?? null }));
  return {
    ...plan,
    items: withIds(plan.items),
    indoorQuickWins: withIds(plan.indoorQuickWins),
    planDate: target.planDate,
  };
}

/** Households the signed-in (or anonymous) user owns, their constraints and daily plans. */
export async function registerHouseholdRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/api/v1/households', HEAVY, async (req, reply) => {
    const body = parse(householdCreateSchema, req.body);
    const db = requireDb(ctx);
    const userId = await ensureUser(ctx, req, reply);
    await assertUnderHouseholdLimit(db, userId);
    const created = await insertHousehold(db, userId, body);
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
    const { household } = await loadOwnedHousehold(ctx, req, id);
    return ok(req.id, publicHousehold(household));
  });

  app.put('/api/v1/households/:id/constraints', async (req) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(constraintsSchema, req.body);
    const { userId } = await loadOwnedHousehold(ctx, req, id);
    const db = requireDb(ctx);
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

  app.post('/api/v1/households/:id/daily-plan', HEAVY, async (req) => {
    const { id } = parse(uuidParam, req.params);
    parse(z.object({}).strict(), req.body ?? {});
    const { household } = await loadOwnedHousehold(ctx, req, id);
    const db = requireDb(ctx);
    const aq = await currentAirFor(ctx, household);
    const plan = buildDailyPlan(aq, toPlanHousehold(household));
    const snapshotId = aq.snapshot ? await latestSnapshotId(db, household) : null;
    const planDate = ctx.now().toISOString().slice(0, 10);
    return ok(req.id, await persistPlan(db, { householdId: id, snapshotId, planDate }, plan));
  });
}
