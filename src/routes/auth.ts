import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { audit, cookieOptions, ensureUser, requireDb, requireUser, type AppContext } from '../context.js';
import { AppError } from '../errors.js';
import { ok } from '../envelope.js';
import { households, users } from '../db/schema.js';
import { SESSION_COOKIE, signSession } from '../security/session.js';
import { hashPassword, verifyPassword } from '../security/password.js';
import { parse } from './validate.js';

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'Enter a valid email address.');
const password = z.string().min(10, 'Use at least 10 characters.').max(128);
const registerSchema = z
  .object({
    email,
    password,
    displayName: z.string().trim().min(1).max(60).optional(),
  })
  .strict();
const loginSchema = z.object({ email, password: z.string().min(1).max(128) }).strict();

const strict = {
  config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: (r: { ip: string }) => r.ip } },
};

export async function registerAuth(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const setSession = (reply: Parameters<typeof ensureUser>[2], userId: string) =>
    reply.setCookie(SESSION_COOKIE, signSession(ctx.config.sessionSecret, userId), cookieOptions(ctx, true));

  app.get('/api/v1/auth/me', async (req) => {
    if (!ctx.dbh) return ok(req.id, { kind: 'none' as const });
    let id: string;
    try {
      id = await requireUser(ctx, req);
    } catch {
      return ok(req.id, { kind: 'none' as const });
    }
    const [u] = await ctx.dbh.db
      .select({ kind: users.kind, email: users.email, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, id));
    // The latest saved household lets a returning user pick up where they left off on any device.
    const [hh] = await ctx.dbh.db
      .select({ id: households.id, lat: households.latitude, lng: households.longitude })
      .from(households)
      .where(eq(households.ownerUserId, id))
      .orderBy(desc(households.createdAt))
      .limit(1);
    return ok(req.id, {
      kind: u?.kind ?? 'none',
      email: u?.email ?? null,
      displayName: u?.displayName ?? null,
      household: hh ?? null,
    });
  });

  // Turns the current anonymous session into an account, so anything already saved is kept.
  app.post('/api/v1/auth/register', strict, async (req, reply) => {
    const body = parse(registerSchema, req.body);
    const db = requireDb(ctx);
    const userId = await ensureUser(ctx, req, reply);
    const [cur] = await db.select({ kind: users.kind }).from(users).where(eq(users.id, userId));
    if (cur?.kind === 'registered') {
      throw new AppError('conflict', 409, 'You are already signed in. Sign out to create another account.');
    }
    const hash = await hashPassword(body.password);
    try {
      await db
        .update(users)
        .set({
          kind: 'registered',
          email: body.email,
          passwordHash: hash,
          displayName: body.displayName ?? null,
        })
        .where(eq(users.id, userId));
    } catch (e) {
      if (
        /users_email_unique|duplicate key/i.test(
          (e as Error).message + String((e as { cause?: unknown }).cause),
        )
      ) {
        throw new AppError('conflict', 409, 'An account with this email already exists. Try signing in.');
      }
      throw e;
    }
    setSession(reply, userId);
    await audit(ctx, req, { userId, type: 'auth.register' });
    return ok(req.id, { kind: 'registered', email: body.email, displayName: body.displayName ?? null });
  });

  app.post('/api/v1/auth/login', strict, async (req, reply) => {
    const body = parse(loginSchema, req.body);
    const db = requireDb(ctx);
    const [u] = await db
      .select({ id: users.id, hash: users.passwordHash, displayName: users.displayName })
      .from(users)
      .where(eq(users.email, body.email));
    const good = await verifyPassword(body.password, u?.hash);
    if (!u || !good) {
      await audit(ctx, req, { type: 'auth.login_failed' });
      throw new AppError('unauthorized', 401, 'That email and password do not match.');
    }
    await db.update(users).set({ lastSeenAt: ctx.now() }).where(eq(users.id, u.id));
    setSession(reply, u.id);
    await audit(ctx, req, { userId: u.id, type: 'auth.login' });
    return ok(req.id, { kind: 'registered', email: body.email, displayName: u.displayName });
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    let userId: string | null = null;
    try {
      userId = await requireUser(ctx, req);
    } catch {
      /* already signed out */
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    if (userId) await audit(ctx, req, { userId, type: 'auth.logout' });
    return ok(req.id, { signedOut: true });
  });
}
