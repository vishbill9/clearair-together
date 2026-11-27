import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import type { DbHandle } from './db/client.js';
import { AppError } from './errors.js';
import { fail } from './envelope.js';
import { createLogger } from './logger.js';
import { GoogleAirQualityClient, type FetchLike } from './google/client.js';
import { AirQualityService } from './google/service.js';
import { AnthropicProvider } from './ai/anthropic.js';
import { OllamaProvider } from './ai/ollama.js';
import type { AiProvider } from './ai/provider.js';
import { AssistantService } from './ai/assistant.js';
import { registerSecurity } from './security/plugin.js';
import { registerApi } from './routes/api.js';
import { registerAuth } from './routes/auth.js';
import { registerPlants } from './routes/plants.js';
import { GeminiTextProvider } from './ai/gemini-text.js';
import { registerGoogleLogin, type OAuthFetch } from './routes/google-login.js';
import { registerIndoor } from './routes/indoor.js';
import { registerLive, defaultUpstream, type UpstreamFactory } from './live/voice.js';
import { GeminiVisionProvider, type VisionProvider } from './indoor/gemini-vision.js';
import type { AppContext } from './context.js';

export interface AppDeps {
  config: Config;
  dbh: DbHandle | null;
  /** Test seams. In production these are built from config. */
  googleFetch?: FetchLike;
  oauthFetch?: OAuthFetch;
  aiProvider?: AiProvider | null;
  visionProvider?: VisionProvider | null;
  plantProvider?: AiProvider | null;
  liveUpstream?: UpstreamFactory | null;
  logDestination?: NodeJS.WritableStream;
  now?: () => Date;
}

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export async function buildApp(deps: AppDeps): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const { config } = deps;
  const now = deps.now ?? (() => new Date());
  const logger = createLogger(config.logLevel, deps.logDestination);

  const app = Fastify({
    loggerInstance: logger,
    genReqId: () => randomUUID(), // never trust a client-supplied id
    requestIdHeader: false,
    bodyLimit: 64 * 1024,
    requestTimeout: 30_000,
    connectionTimeout: 30_000,
    trustProxy: config.trustProxy,
    ajv: { customOptions: { removeAdditional: false } },
  }) as unknown as FastifyInstance;

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
  const provider: AiProvider | null =
    deps.aiProvider !== undefined
      ? deps.aiProvider
      : config.aiProvider === 'ollama' && config.ollama.apiKey
        ? new OllamaProvider({
            apiKey: config.ollama.apiKey,
            model: config.ollama.model,
            baseUrl: config.ollama.baseUrl,
          })
        : config.aiProvider === 'anthropic' && config.anthropicApiKey
          ? new AnthropicProvider({ apiKey: config.anthropicApiKey, model: config.aiModel })
          : null;
  const assistant = new AssistantService(provider, { now });
  const ctx: AppContext = { config, dbh: deps.dbh, aq, assistant, now };

  await registerSecurity(app, config);

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.status >= 500) req.log.error({ code: err.code }, err.message);
      return reply.code(err.status).send(
        fail(req.id, {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        }),
      );
    }
    if (err instanceof ZodError) {
      return reply
        .code(400)
        .send(fail(req.id, { code: 'validation_error', message: 'The request was not valid.' }));
    }
    const e = err as { statusCode?: number; code?: string };
    const status = e.statusCode ?? 500;
    if (status === 429)
      return reply.code(429).send(
        fail(req.id, {
          code: 'rate_limited',
          message: 'Too many requests. Please slow down and try again shortly.',
        }),
      );
    if (status === 413 || e.code === 'FST_ERR_CTP_BODY_TOO_LARGE')
      return reply
        .code(413)
        .send(fail(req.id, { code: 'payload_too_large', message: 'The request body is too large.' }));
    if (status === 415)
      return reply
        .code(415)
        .send(fail(req.id, { code: 'unsupported_media_type', message: 'Unsupported content type.' }));
    if (status >= 400 && status < 500)
      return reply
        .code(status)
        .send(fail(req.id, { code: 'validation_error', message: 'The request could not be processed.' }));
    // Unknown error: log internally, never leak details.
    req.log.error({ err: { message: (err as Error).message, name: (err as Error).name } }, 'unhandled error');
    return reply
      .code(500)
      .send(fail(req.id, { code: 'internal_error', message: 'Something went wrong on our side.' }));
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/'))
      return reply.code(404).send(fail(req.id, { code: 'not_found', message: 'Not found.' }));
    return reply.code(404).type('text/plain').send('Not found');
  });

  const vision: VisionProvider | null =
    deps.visionProvider !== undefined
      ? deps.visionProvider
      : config.live.geminiApiKey && config.live.visionModel
        ? new GeminiVisionProvider({ apiKey: config.live.geminiApiKey, model: config.live.visionModel })
        : null;
  const plantProvider: AiProvider | null =
    deps.plantProvider !== undefined
      ? deps.plantProvider
      : config.live.geminiApiKey && config.live.chatModel
        ? new GeminiTextProvider({ apiKey: config.live.geminiApiKey, model: config.live.chatModel })
        : null;
  await registerApi(app, ctx);
  await registerPlants(app, ctx, plantProvider);
  await registerAuth(app, ctx);
  await registerGoogleLogin(app, ctx, deps.oauthFetch);
  await registerIndoor(app, ctx, vision);
  await registerLive(
    app,
    ctx,
    deps.liveUpstream !== undefined ? deps.liveUpstream : config.live.enabled ? defaultUpstream : null,
  );

  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: '/',
    index: ['index.html'],
    wildcard: false,
    decorateReply: false,
    // HTML/CSS/JS revalidate on every load (ETag), so a deploy can never leave a page paired with old
    // styles or scripts. Fonts are versioned by file name and cached for a year.
    setHeaders: (res, filePath) => {
      res.header(
        'cache-control',
        filePath.includes('/fonts/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    },
    dotfiles: 'deny',
  });

  app.addHook('onClose', async () => {
    await deps.dbh?.close();
  });

  return { app, ctx };
}
