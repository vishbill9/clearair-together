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
export function registerApi(app: FastifyInstance, ctx: AppContext): void {
  registerSystemRoutes(app, ctx);
  registerAirQualityRoutes(app, ctx);
  registerHouseholdRoutes(app, ctx);
  registerAssistantRoutes(app, ctx);
  registerRoutineRoutes(app, ctx);
  registerFeedbackRoutes(app, ctx);
  registerCommunityRoutes(app, ctx);
}
