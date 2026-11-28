import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit, type AppContext } from '../context.js';
import { AppError, notConfigured } from '../errors.js';
import { ok } from '../envelope.js';
import type { AssistantResult, HouseholdContext } from '../ai/assistant.js';
import { isEmergencyMessage } from '../ai/emergency.js';
import { AiProviderError } from '../ai/provider.js';
import { assistantRequestSchema, type AssistantRequest } from '../ai/schema.js';
import type { AirQualityResult } from '../google/service.js';
import { loadOwnedHousehold, toPlanHousehold } from './shared.js';
import { parse } from './validate.js';

interface AskContext {
  userId: string | null;
  household: HouseholdContext | null;
  lat?: number;
  lng?: number;
  languageCode: string;
}

const NO_LOCATION: AirQualityResult = {
  snapshot: null,
  status: 'unavailable',
  reason: 'No location provided.',
};

/** A household id makes the household's location and needs the context; otherwise the posted location is used. */
async function resolveContext(
  ctx: AppContext,
  req: FastifyRequest,
  body: AssistantRequest,
): Promise<AskContext> {
  if (!body.householdId) {
    return { userId: null, household: null, lat: body.lat, lng: body.lng, languageCode: body.languageCode };
  }
  const { userId, household: h } = await loadOwnedHousehold(ctx, req, body.householdId);
  const ph = toPlanHousehold(h);
  return {
    userId,
    household: { members: ph.members, constraints: ph.constraints, countryCode: h.household.countryCode },
    lat: h.household.latitude,
    lng: h.household.longitude,
    languageCode: h.household.languageCode,
  };
}

/** The verified reading for the question's place, or an honest "no location" result. */
function airQualityFor(ctx: AppContext, c: AskContext): Promise<AirQualityResult> {
  if (c.lat === undefined || c.lng === undefined) return Promise.resolve(NO_LOCATION);
  return ctx.aq.getCurrent({ lat: c.lat, lng: c.lng, languageCode: c.languageCode });
}

function auditType(result: AssistantResult): string {
  if (result.kind === 'emergency') return 'assistant.emergency';
  return result.blocked ? 'assistant.blocked' : 'assistant.answer';
}

function toPublicError(e: AiProviderError): AppError {
  if (e.kind === 'bad_response') {
    return new AppError('ai_bad_output', 502, 'The assistant returned an unusable answer. Please try again.');
  }
  return new AppError('ai_unavailable', 503, 'The assistant is temporarily unavailable.');
}

/** Plain-language guidance. Urgent symptoms are answered with fixed guidance and never reach the model. */
export function registerAssistantRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    '/api/v1/assistant/messages',
    { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } },
    async (req) => {
      const body = parse(assistantRequestSchema, req.body);
      const emergency = isEmergencyMessage(body.message);
      if (!emergency && !ctx.assistant.configured) throw notConfigured('The assistant');

      const c = await resolveContext(ctx, req, body);
      const aq = emergency ? NO_LOCATION : await airQualityFor(ctx, c);
      try {
        const result = await ctx.assistant.answer({ message: body.message, aq, household: c.household });
        await audit(ctx, req, {
          userId: c.userId,
          type: auditType(result),
          metadata: result.kind === 'answer' && result.blocked ? { rules: result.violations } : {},
        });
        return ok(req.id, result);
      } catch (e) {
        throw e instanceof AiProviderError ? toPublicError(e) : e;
      }
    },
  );
}
