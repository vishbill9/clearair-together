import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { registerAirQualityRoutes } from './air-quality.js';
import { registerAssistantRoutes } from './assistant.js';
import { registerCommunityRoutes } from './community.js';
import { registerFeedbackRoutes } from './feedback.js';
import { registerHouseholdRoutes } from './households.js';
import { registerRoutineRoutes } from './routines.js';
import { registerSystemRoutes } from './system.js';

/** Registers the public JSON API, one module per feature. */
export async function registerApi(app: FastifyInstance, ctx: AppContext): Promise<void> {
  await registerSystemRoutes(app, ctx);
  await registerAirQualityRoutes(app, ctx);
  await registerHouseholdRoutes(app, ctx);
  await registerAssistantRoutes(app, ctx);
  await registerRoutineRoutes(app, ctx);
  await registerFeedbackRoutes(app, ctx);
  await registerCommunityRoutes(app, ctx);
}
