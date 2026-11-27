import type { FastifyInstance } from 'fastify';
import { audit, type AppContext } from '../context.js';
import { AppError, notConfigured } from '../errors.js';
import { ok } from '../envelope.js';
import { AiProviderError, type AiProvider } from '../ai/provider.js';
import { PLANTS } from '../plants/catalog.js';
import { answerPlantQuestion, isIngestionConcern, plantChatInput, URGENT } from '../plants/chat.js';
import { parse } from './validate.js';

const heavy = { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } };

export async function registerPlants(
  app: FastifyInstance,
  ctx: AppContext,
  provider: AiProvider | null,
): Promise<void> {
  app.get('/api/v1/plants', async (req) =>
    ok(req.id, {
      plants: PLANTS,
      note: 'Houseplants change indoor air quality very little in real rooms. They are suggested for greenery and wellbeing, not to clean air.',
    }),
  );

  app.post('/api/v1/plants/chat', heavy, async (req) => {
    const body = parse(plantChatInput, req.body);
    // A pet or child that has eaten a plant never waits on a model call or on configuration.
    if (isIngestionConcern(body.question)) {
      await audit(ctx, req, { type: 'plants.urgent' });
      return ok(req.id, URGENT);
    }
    if (!provider || !ctx.config.integrations.plantChat) throw notConfigured('Plant chat');
    try {
      const result = await answerPlantQuestion(provider, body, undefined, (rules) =>
        req.log.warn({ rules }, 'plant chat answer blocked'),
      );
      await audit(ctx, req, { type: result.blocked ? 'plants.blocked' : 'plants.answer' });
      return ok(req.id, result);
    } catch (e) {
      if (e instanceof AiProviderError) {
        req.log.warn({ kind: e.kind, detail: e.detail }, 'plant chat provider failure');
        if (e.kind === 'bad_response') {
          throw new AppError(
            'ai_bad_output',
            502,
            'The plant guide returned an unusable answer. Please try again.',
          );
        }
        throw new AppError('ai_unavailable', 503, 'The plant guide is temporarily unavailable.');
      }
      throw e;
    }
  });
}
