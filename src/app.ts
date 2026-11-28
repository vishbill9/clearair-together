import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import type { DbHandle } from './db/client.js';
import { registerErrorHandlers } from './error-handler.js';
import { createLogger } from './logger.js';
import { AssistantService } from './ai/assistant.js';
import type { AiProvider } from './ai/provider.js';
import { assistantProvider, plantChatProvider } from './ai/providers.js';
import { GoogleAirQualityClient, type FetchLike } from './google/client.js';
import { AirQualityService } from './google/service.js';
import { defaultUpstream, registerLive, type UpstreamFactory } from './live/voice.js';
import { registerApi } from './routes/api.js';
import { registerAuth } from './routes/auth.js';
import { registerGoogleLogin, type OAuthFetch } from './routes/google-login.js';
import { registerPlants } from './routes/plants.js';
import { registerSecurity } from './security/plugin.js';

export interface AppDeps {
  config: Config;
  dbh: DbHandle | null;
  /** Test seams. In production these are built from config. */
  googleFetch?: FetchLike;
  oauthFetch?: OAuthFetch;
  aiProvider?: AiProvider | null;
  plantProvider?: AiProvider | null;
  liveUpstream?: UpstreamFactory | null;
  logDestination?: NodeJS.WritableStream;
  now?: () => Date;
}

/** A test seam wins when given (even `null`); otherwise the production value is built. */
const seam = <T>(override: T | undefined, build: () => T): T => (override !== undefined ? override : build());

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function createServer(config: Config, logDestination?: NodeJS.WritableStream): FastifyInstance {
  const logger: FastifyBaseLogger = createLogger(config.logLevel, logDestination);
  return Fastify({
    loggerInstance: logger,
    genReqId: () => randomUUID(), // never trust a client-supplied id
    requestIdHeader: false,
    bodyLimit: 64 * 1024,
    requestTimeout: 30_000,
    connectionTimeout: 30_000,
    trustProxy: config.trustProxy,
    ajv: { customOptions: { removeAdditional: false } },
  });
}

function createContext(deps: AppDeps, provider: AiProvider | null): AppContext {
  const { config } = deps;
  const now = deps.now ?? (() => new Date());
  const google = config.google.apiKey
    ? GoogleAirQualityClient.fromConfig(config, deps.googleFetch ? { fetchImpl: deps.googleFetch } : {})
    : null;
  const aq = new AirQualityService({
    client: google,
    db: deps.dbh?.db ?? null,
    cacheTtlSeconds: config.airQuality.cacheTtlSeconds,
    staleMaxSeconds: config.airQuality.staleMaxSeconds,
    now,
  });
  return { config, dbh: deps.dbh, aq, assistant: new AssistantService(provider, { now }), now };
}

/**
 * HTML, CSS and JS revalidate on every load (ETag), so a deploy never pairs a page with old styles or
 * scripts. Fonts are versioned by file name and cached for a year.
 */
async function registerStatic(app: FastifyInstance): Promise<void> {
  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: '/',
    index: ['index.html'],
    wildcard: false,
    decorateReply: false,
    dotfiles: 'deny',
    setHeaders: (res, filePath) => {
      res.header(
        'cache-control',
        filePath.includes('/fonts/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    },
  });
}

/** Composition root: builds every service from config (or test seams) and registers all routes. */
export async function buildApp(deps: AppDeps): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const { config } = deps;
  const app = createServer(config, deps.logDestination);
  const provider = seam(deps.aiProvider, () => assistantProvider(config));
  const ctx = createContext(deps, provider);
  const plantProvider = seam(deps.plantProvider, () =>
    plantChatProvider(config, provider, (e) =>
      app.log.warn({ kind: e.kind, detail: e.detail }, 'plant chat falling back to assistant model'),
    ),
  );
  const upstream = seam(deps.liveUpstream, () => (config.live.enabled ? defaultUpstream : null));

  await registerSecurity(app, config);
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });
  registerErrorHandlers(app);
  registerApi(app, ctx);
  registerPlants(app, ctx, plantProvider);
  registerAuth(app, ctx);
  registerGoogleLogin(app, ctx, deps.oauthFetch);
  await registerLive(app, ctx, upstream);
  await registerStatic(app);
  app.addHook('onClose', async () => {
    await deps.dbh?.close();
  });
  return { app, ctx };
}
