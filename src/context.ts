import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import type { Config } from './config.js';
import type { DbHandle } from './db/client.js';
import { users, auditEvents } from './db/schema.js';
import { AppError, notConfigured, unauthorized } from './errors.js';
import type { AirQualityService } from './google/service.js';
import type { AssistantService } from './ai/assistant.js';
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, signSession, verifySession } from './security/session.js';

export interface AppContext {
  config: Config;
  dbh: DbHandle | null;
  aq: AirQualityService;
  assistant: AssistantService;
  now: () => Date;
}

export const requireDb = (ctx: AppContext) => {
  if (!ctx.dbh) throw notConfigured('The database');
  return ctx.dbh.db;
};

export function cookieOptions(ctx: AppContext, httpOnly: boolean) {
  return {
    path: '/',
    httpOnly,
    secure: ctx.config.isProduction,
    sameSite: 'lax' as const,
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

/** Returns the authenticated user's id or throws 401. Does not create anything. */
export async function requireUser(ctx: AppContext, req: FastifyRequest): Promise<string> {
  const id = verifySession(ctx.config.sessionSecret, req.cookies[SESSION_COOKIE]);
  if (!id) throw unauthorized();
  const db = requireDb(ctx);
  const rows = await db
    .update(users)
    .set({ lastSeenAt: ctx.now() })
    .where(eq(users.id, id))
    .returning({ id: users.id });
  if (!rows[0]) throw unauthorized();
  return id;
}

/** Returns the current user, creating an anonymous account and session cookie if there is none. */
export async function ensureUser(ctx: AppContext, req: FastifyRequest, reply: FastifyReply): Promise<string> {
  const existing = verifySession(ctx.config.sessionSecret, req.cookies[SESSION_COOKIE]);
  if (existing) {
    try {
      return await requireUser(ctx, req);
    } catch (e) {
      if (!(e instanceof AppError) || e.code !== 'unauthorized') throw e;
    }
  }
  const db = requireDb(ctx);
  const [row] = await db.insert(users).values({ kind: 'anonymous' }).returning({ id: users.id });
  if (!row) throw new AppError('internal_error', 500, 'Could not start a session.');
  reply.setCookie(SESSION_COOKIE, signSession(ctx.config.sessionSecret, row.id), cookieOptions(ctx, true));
  return row.id;
}

function clientHash(ctx: AppContext, ip: string): string {
  return createHash('sha256').update(`${ctx.config.sessionSecret}:${ip}`).digest('hex').slice(0, 16);
}

export async function audit(
  ctx: AppContext,
  req: FastifyRequest,
  e: {
    userId?: string | null;
    type: string;
    resourceType?: string;
    resourceId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  if (!ctx.dbh) return;
  try {
    await ctx.dbh.db.insert(auditEvents).values({
      userId: e.userId ?? null,
      eventType: e.type,
      resourceType: e.resourceType ?? null,
      resourceId: e.resourceId ?? null,
      requestId: req.id,
      clientHash: clientHash(ctx, req.ip),
      metadata: e.metadata ?? {},
    });
  } catch (err) {
    req.log.warn({ err: (err as Error).message }, 'audit write failed');
  }
}
