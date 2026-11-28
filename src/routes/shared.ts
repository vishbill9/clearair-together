import type { FastifyRequest } from 'fastify';
import { requireDb, requireUser, type AppContext } from '../context.js';
import { notFound } from '../errors.js';
import { getOwnedHousehold } from '../repo.js';
import type { PlanHousehold } from '../domain/plan.js';
import type { AirQualityResult } from '../google/service.js';

/** Stricter per-IP limit for endpoints that write data or call an upstream service. */
export const HEAVY = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } } as const;

export const ATTRIBUTION = 'Air-quality data: Google Air Quality API';

export type OwnedHousehold = NonNullable<Awaited<ReturnType<typeof getOwnedHousehold>>>;

/** Loads a household the signed-in user owns, or throws 401/404. */
export async function loadOwnedHousehold(
  ctx: AppContext,
  req: FastifyRequest,
  householdId: string,
): Promise<{ userId: string; household: OwnedHousehold }> {
  const db = requireDb(ctx);
  const userId = await requireUser(ctx, req);
  const household = await getOwnedHousehold(db, userId, householdId);
  if (!household) throw notFound('Household');
  return { userId, household };
}

/** Current verified air quality at the household's stored (rounded) location. */
export function currentAirFor(ctx: AppContext, h: OwnedHousehold): Promise<AirQualityResult> {
  return ctx.aq.getCurrent({
    lat: h.household.latitude,
    lng: h.household.longitude,
    languageCode: h.household.languageCode,
  });
}

/** The parts of a household the plan rules need: age groups, cautions and constraints. */
export function toPlanHousehold(h: OwnedHousehold): PlanHousehold {
  const c = h.constraints;
  return {
    members: h.members.map((m) => ({ ageGroup: m.ageGroup, needsExtraCaution: m.needsExtraCaution })),
    constraints: c
      ? {
          commuteMode: c.commuteMode,
          canWorkFromHome: c.canWorkFromHome,
          hasAirPurifier: c.hasAirPurifier,
          hasPets: c.hasPets,
          cookingFuel: c.cookingFuel,
          budgetLevel: c.budgetLevel,
          timeFlexibility: c.timeFlexibility,
        }
      : null,
  };
}

/** The household as returned by the API: no owner id, rounded coordinates only. */
export function publicHousehold(h: OwnedHousehold) {
  const { household } = h;
  return {
    id: household.id,
    name: household.name,
    location: {
      latitude: household.latitude,
      longitude: household.longitude,
      approximateLabel: household.approximateLabel,
    },
    countryCode: household.countryCode,
    languageCode: household.languageCode,
    members: h.members.map((m) => ({
      id: m.id,
      label: m.label,
      ageGroup: m.ageGroup,
      needsExtraCaution: m.needsExtraCaution,
    })),
    constraints: toPlanHousehold(h).constraints,
    createdAt: household.createdAt.toISOString(),
  };
}
