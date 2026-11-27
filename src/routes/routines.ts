import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { ok } from '../envelope.js';
import { compareRoutines, type CommuteMode } from '../domain/impact.js';
import { overallSeverity } from '../google/severity.js';
import { currentAirFor, HEAVY, loadOwnedHousehold } from './shared.js';
import { parse } from './validate.js';

const ROUTINES = [
  'work_from_home',
  'walk',
  'cycle',
  'bus',
  'metro',
  'car',
  'two_wheeler',
  'rideshare',
] as const;

const compareSchema = z
  .object({
    householdId: z.string().uuid(),
    candidates: z.array(z.enum(ROUTINES)).min(1).max(8),
  })
  .strict();

/** Compares routines against the household's usual commute; exposure and emissions stay separate. */
export async function registerRoutineRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/api/v1/scenarios/compare', HEAVY, async (req) => {
    const body = parse(compareSchema, req.body);
    const { household } = await loadOwnedHousehold(ctx, req, body.householdId);
    const aq = await currentAirFor(ctx, household);
    const severity = aq.snapshot ? overallSeverity(aq.snapshot) : 'unknown';
    const current = (household.constraints?.commuteMode ?? 'unknown') as CommuteMode;
    return ok(req.id, {
      status: aq.status,
      reason: aq.reason ?? null,
      currentRoutine: current,
      severity,
      options: compareRoutines({
        current,
        candidates: body.candidates,
        severity,
        canWorkFromHome: Boolean(household.constraints?.canWorkFromHome),
      }),
      note: 'Exposure and emissions are shown separately. Effects are qualitative and based on general rules, not measurements.',
    });
  });
}
