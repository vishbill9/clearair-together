import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../db/client.js';
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

type Reply = Parameters<typeof ensureUser>[2];
const NO_ACCOUNT = { kind: 'none' as const };

/** The signed-in user id, or null when there is no valid session. */
async function optionalUserId(ctx: AppContext, req: FastifyRequest): Promise<string | null> {
  if (!ctx.dbh) return null;
  try {
    return await requireUser(ctx, req);
  } catch {
    return null;
  }
}

/** Account summary plus the latest household, so a returning user picks up where they left off. */
async function accountSummary(db: Db, userId: string) {
  const [u] = await db
    .select({ kind: users.kind, email: users.email, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId));
  const [hh] = await db
    .select({ id: households.id, lat: households.latitude, lng: households.longitude })
    .from(households)
    .where(eq(households.ownerUserId, userId))
    .orderBy(desc(households.createdAt))
    .limit(1);
  return {
    kind: u?.kind ?? 'none',
    email: u?.email ?? null,
    displayName: u?.displayName ?? null,
    household: hh ?? null,
  };
}

const isDuplicateEmail = (e: unknown) =>
  /users_email_unique|duplicate key/i.test((e as Error).message + String((e as { cause?: unknown }).cause));

/** Turns an anonymous user into a registered one in place, so anything already saved is kept. */
async function upgradeToRegistered(
  db: Db,
  userId: string,
  body: z.infer<typeof registerSchema>,
): Promise<void> {
  const [cur] = await db.select({ kind: users.kind }).from(users).where(eq(users.id, userId));
  if (cur?.kind === 'registered') {
    throw new AppError('conflict', 409, 'You are already signed in. Sign out to create another account.');
  }
  const passwordHash = await hashPassword(body.password);
  try {
    await db
      .update(users)
      .set({ kind: 'registered', email: body.email, passwordHash, displayName: body.displayName ?? null })
      .where(eq(users.id, userId));
  } catch (e) {
    if (isDuplicateEmail(e)) {
      throw new AppError('conflict', 409, 'An account with this email already exists. Try signing in.');
    }
    throw e;
  }
}

/** Email and password accounts. Passwords are hashed with scrypt and compared in constant time. */
export function registerAuth(app: FastifyInstance, ctx: AppContext): void {
  const setSession = (reply: Reply, userId: string) =>
    reply.setCookie(SESSION_COOKIE, signSession(ctx.config.sessionSecret, userId), cookieOptions(ctx, true));

  app.get('/api/v1/auth/me', async (req) => {
    const userId = await optionalUserId(ctx, req);
    if (!userId || !ctx.dbh) return ok(req.id, NO_ACCOUNT);
    return ok(req.id, await accountSummary(ctx.dbh.db, userId));
  });

  app.post('/api/v1/auth/register', strict, async (req, reply) => {
    const body = parse(registerSchema, req.body);
    const userId = await ensureUser(ctx, req, reply);
    await upgradeToRegistered(requireDb(ctx), userId, body);
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
    // verifyPassword runs even for unknown emails, so timing does not reveal which accounts exist.
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
    const userId = await optionalUserId(ctx, req);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    if (userId) await audit(ctx, req, { userId, type: 'auth.logout' });
    return ok(req.id, { signedOut: true });
  });
}
