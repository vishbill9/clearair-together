import type { FastifyInstance, FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { audit, requireDb, requireUser, type AppContext } from '../context.js';
import { AppError, notConfigured, notFound, unauthorized } from '../errors.js';
import { ok } from '../envelope.js';
import { getOwnedHousehold } from '../repo.js';
import { toPlanHousehold } from '../routes/shared.js';
import { parse } from '../routes/validate.js';
import { allowedOrigins } from '../security/plugin.js';
import { CSRF_COOKIE, csrfCheck, SESSION_COOKIE, verifySession } from '../security/session.js';
import {
  GEMINI_LIVE_URL,
  liveQuerySchema,
  MAX_CLIENT_MSG_BYTES,
  MAX_SESSIONS_PER_HOUR,
  sendJson,
  type LiveQuery,
  type Socket,
} from './protocol.js';
import { LiveSession, type LiveContext } from './session.js';

export type UpstreamFactory = (apiKey: string) => WebSocket;
export const defaultUpstream: UpstreamFactory = (apiKey) =>
  new WebSocket(`${GEMINI_LIVE_URL}?key=${encodeURIComponent(apiKey)}`, {
    handshakeTimeout: 10_000,
    maxPayload: 4 * 1024 * 1024,
  });

const HOUR_MS = 3_600_000;

/** Per-user limits: one active session at a time and a cap on sessions per hour. */
class SessionLimits {
  readonly active = new Map<string, LiveSession>();
  private readonly history = new Map<string, number[]>();

  admit(userId: string, now = Date.now()): void {
    if (this.active.has(userId)) throw new AppError('conflict', 409, 'A voice session is already active.');
    const recent = (this.history.get(userId) ?? []).filter((t) => now - t < HOUR_MS);
    if (recent.length >= MAX_SESSIONS_PER_HOUR) {
      throw new AppError('rate_limited', 429, 'Too many voice sessions. Please try again later.');
    }
    this.history.set(userId, [...recent, now]);
  }
}

/** Runs before the HTTP upgrade, so a rejected client never gets a socket. */
async function admit(ctx: AppContext, req: FastifyRequest, origins: Set<string>, limits: SessionLimits) {
  const cfg = ctx.config;
  const origin = req.headers.origin;
  if (!origin || !origins.has(origin)) throw new AppError('csrf_failed', 403, 'Origin not allowed.');
  const { csrf } = req.query as { csrf?: string };
  if (!csrfCheck(cfg.sessionSecret, req.cookies[CSRF_COOKIE], csrf)) {
    throw new AppError('csrf_failed', 403, 'Missing or invalid token.');
  }
  const userId = verifySession(cfg.sessionSecret, req.cookies[SESSION_COOKIE]);
  if (!userId) throw unauthorized();
  await requireUser(ctx, req);
  limits.admit(userId);
}

/** Builds the verified context; returns null when the requested household is not the user's. */
async function liveContext(ctx: AppContext, userId: string, q: LiveQuery): Promise<LiveContext | null> {
  let place = { lat: q.lat, lng: q.lng, languageCode: q.languageCode };
  let household: LiveContext['household'] = null;
  let regionCode: string | null = null;
  if (q.householdId) {
    const hh = await getOwnedHousehold(requireDb(ctx), userId, q.householdId);
    if (!hh) return null;
    const ph = toPlanHousehold(hh);
    household = { members: ph.members, constraints: ph.constraints, countryCode: hh.household.countryCode };
    regionCode = hh.household.countryCode;
    place = {
      lat: hh.household.latitude,
      lng: hh.household.longitude,
      languageCode: hh.household.languageCode,
    };
  }
  const aq =
    place.lat !== undefined && place.lng !== undefined
      ? await ctx.aq.getCurrent({ lat: place.lat, lng: place.lng, languageCode: place.languageCode })
      : { snapshot: null, status: 'unavailable' as const, reason: 'No location provided.' };
  return { aq, household, regionCode: regionCode ?? aq.snapshot?.regionCode ?? null };
}

function reject(client: Socket, code: number, error: { code: string; message: string }, reason: string) {
  sendJson(client, { type: 'error', ...error });
  client.close(code, reason);
}

/** How to reach Gemini Live, or null when voice is not fully configured. */
function liveConnector(cfg: AppContext['config'], upstream: UpstreamFactory | null) {
  const { enabled, geminiApiKey, liveModel } = cfg.live;
  if (!enabled || !cfg.integrations.live || !upstream || !geminiApiKey || !liveModel) return null;
  return { model: liveModel, open: () => upstream(geminiApiKey) };
}

const SETUP_FAILED = { code: 'internal_error', message: 'Could not start the session.' };

type Connector = NonNullable<ReturnType<typeof liveConnector>>;

/** Builds the verified context and starts the proxied session; problems close the socket with a reason. */
async function startSession(
  ctx: AppContext,
  live: { connector: Connector | null; limits: SessionLimits },
  client: Socket,
  req: FastifyRequest,
): Promise<void> {
  // Both were checked in preValidation; re-reading them here keeps the types honest.
  const userId = verifySession(ctx.config.sessionSecret, req.cookies[SESSION_COOKIE]);
  const { connector, limits } = live;
  if (!userId || !connector) {
    reject(client, 1011, SETUP_FAILED, 'setup failed');
    return;
  }
  let context: LiveContext | null;
  try {
    context = await liveContext(ctx, userId, parse(liveQuerySchema, req.query));
  } catch (e) {
    req.log.warn({ err: { name: e instanceof Error ? e.name : 'unknown' } }, 'live voice setup failed');
    reject(client, 1011, SETUP_FAILED, 'setup failed');
    return;
  }
  if (!context) {
    reject(client, 1008, { code: 'not_found', message: 'Household not found.' }, 'not found');
    return;
  }
  const session = new LiveSession({
    ctx,
    req,
    userId,
    client,
    upstream: connector.open(),
    model: connector.model,
    context,
    onClose: () => limits.active.delete(userId),
  });
  limits.active.set(userId, session);
  void audit(ctx, req, { userId, type: 'live.start' });
}

/** Optional voice conversation through a server-side Gemini Live proxy; the API key never reaches the browser. */
export async function registerLive(
  app: FastifyInstance,
  ctx: AppContext,
  upstream: UpstreamFactory | null,
): Promise<void> {
  const limits = new SessionLimits();
  const origins = allowedOrigins(ctx.config);
  const connector = liveConnector(ctx.config, upstream);

  await app.register(websocket, { options: { maxPayload: MAX_CLIENT_MSG_BYTES + 1024 } });

  app.get(
    '/api/v1/live/voice',
    {
      websocket: true,
      preValidation: async (req) => {
        if (!connector) throw notConfigured('Live voice');
        await admit(ctx, req, origins, limits);
      },
    },
    (socket, req) => startSession(ctx, { connector, limits }, socket, req),
  );

  app.post('/api/v1/live/voice/stop', async (req) => {
    const userId = await requireUser(ctx, req);
    const s = limits.active.get(userId);
    if (!s) throw notFound('Voice session');
    s.finish('stopped_by_user');
    return ok(req.id, { stopped: true });
  });
}
