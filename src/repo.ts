import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './db/client.js';
import {
  communityChallenges,
  communityParticipation,
  householdConstraints,
  householdMembers,
  households,
  recommendationEvents,
  recommendations,
} from './db/schema.js';
import type { PlanItem } from './domain/plan.js';

/** Every household query is scoped by owner in SQL, so another user's id is indistinguishable from a missing one. */
export async function getOwnedHousehold(db: Db, userId: string, householdId: string) {
  const [h] = await db
    .select()
    .from(households)
    .where(and(eq(households.id, householdId), eq(households.ownerUserId, userId)))
    .limit(1);
  if (!h) return null;
  const members = await db.select().from(householdMembers).where(eq(householdMembers.householdId, h.id));
  const [constraints] = await db
    .select()
    .from(householdConstraints)
    .where(eq(householdConstraints.householdId, h.id))
    .limit(1);
  return { household: h, members, constraints: constraints ?? null };
}

export async function getOwnedRecommendation(db: Db, userId: string, recommendationId: string) {
  const [r] = await db
    .select({ rec: recommendations })
    .from(recommendations)
    .innerJoin(households, eq(households.id, recommendations.householdId))
    .where(and(eq(recommendations.id, recommendationId), eq(households.ownerUserId, userId)))
    .limit(1);
  return r?.rec ?? null;
}

export interface PlanItemsToSave {
  householdId: string;
  snapshotId: string | null;
  planDate: string;
  items: PlanItem[];
}

export async function savePlanItems(db: Db, { householdId, snapshotId, planDate, items }: PlanItemsToSave) {
  if (items.length === 0) return [];
  return db
    .insert(recommendations)
    .values(
      items.map((i) => ({
        householdId,
        snapshotId,
        planDate,
        category: i.category,
        title: i.title,
        body: i.body,
        effort: i.effort,
        exposureEffect: i.exposureEffect,
        emissionsEffect: i.emissionsEffect,
        origin: 'rules' as const,
      })),
    )
    .returning();
}

export interface FeedbackEvent {
  recommendationId: string;
  userId: string;
  eventType: string;
  note: string | null;
}

export async function recordFeedback(db: Db, { recommendationId, userId, eventType, note }: FeedbackEvent) {
  await db
    .insert(recommendationEvents)
    .values({ recommendationId, userId, eventType, note })
    .onConflictDoUpdate({
      target: [
        recommendationEvents.recommendationId,
        recommendationEvents.userId,
        recommendationEvents.eventType,
      ],
      set: { note, createdAt: sql`now()` },
    });
}

const K_ANONYMITY = 5;

/** Aggregates only. Counts below k are suppressed so no individual's participation or actions can be inferred. */
export async function challengeSummary(db: Db, challengeId: string) {
  const [c] = await db
    .select()
    .from(communityChallenges)
    .where(eq(communityChallenges.id, challengeId))
    .limit(1);
  if (!c) return null;
  const rows = await db
    .select({ keys: communityParticipation.completedActionKeys })
    .from(communityParticipation)
    .where(eq(communityParticipation.challengeId, challengeId));
  const participants = rows.length;
  const base = {
    id: c.id,
    title: c.title,
    description: c.description,
    startsAt: c.startsAt.toISOString(),
    endsAt: c.endsAt.toISOString(),
    minGroupSize: K_ANONYMITY,
  };
  if (participants < K_ANONYMITY) {
    return {
      ...base,
      participantCount: null,
      participantCountLabel: `Fewer than ${K_ANONYMITY} participants so far`,
      actionCounts: null,
      suppressed: true,
    };
  }
  const counts: Record<string, number> = {};
  for (const r of rows) for (const k of new Set(r.keys)) counts[k] = (counts[k] ?? 0) + 1;
  const actionCounts = Object.fromEntries(Object.entries(counts).filter(([, n]) => n >= K_ANONYMITY));
  return {
    ...base,
    participantCount: participants,
    participantCountLabel: `${participants} participants`,
    actionCounts,
    suppressed: false,
  };
}
