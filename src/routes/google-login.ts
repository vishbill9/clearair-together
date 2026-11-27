import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { audit, cookieOptions, ensureUser, requireDb, type AppContext } from '../context.js';
import { notConfigured } from '../errors.js';
import { users } from '../db/schema.js';
import { SESSION_COOKIE, signSession } from '../security/session.js';
import {
  OAUTH_COOKIE,
  OAUTH_MAX_AGE_SECONDS,
  challengeFor,
  newTransaction,
  openTransaction,
  sameSecret,
  sealTransaction,
} from '../security/oauth-state.js';

export type OAuthFetch = (url: string, init: RequestInit) => Promise<Response>;

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const CALLBACK_PATH = '/api/v1/auth/google/callback';
const COOKIE_PATH = '/api/v1/auth/google';

const callbackQuery = z.object({
  code: z.string().min(1).max(2048).optional(),
  state: z.string().min(1).max(256).optional(),
  error: z.string().max(100).optional(),
});

const tokenResponse = z.object({ id_token: z.string().min(10).max(8192) });

const claims = z.object({
  iss: z.string(),
  aud: z.string(),
  sub: z.string().min(1).max(255),
  exp: z.number(),
  nonce: z.string().optional(),
  email: z.string().email().max(254),
  email_verified: z.union([z.boolean(), z.literal('true')]),
  name: z.string().max(200).optional(),
  given_name: z.string().max(100).optional(),
});

export type GoogleClaims = z.infer<typeof claims>;

/**
 * The id_token comes straight from Google's token endpoint over TLS in exchange for a one-time code,
 * so its signature need not be re-verified (Google's documented approach); every claim that matters is.
 */
export function readIdToken(
  idToken: string,
  opts: { clientId: string; nonce: string; now: number },
): GoogleClaims {
  const parts = idToken.split('.');
  if (parts.length !== 3 || !parts[1]) throw new Error('malformed id_token');
  const c = claims.parse(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
  if (!ISSUERS.has(c.iss)) throw new Error('bad issuer');
  if (c.aud !== opts.clientId) throw new Error('bad audience');
  if (c.exp * 1000 < opts.now) throw new Error('expired');
  if (!c.nonce || !sameSecret(c.nonce, opts.nonce)) throw new Error('bad nonce');
  if (c.email_verified !== true && c.email_verified !== 'true') throw new Error('email not verified');
  return c;
}

export async function registerGoogleLogin(
  app: FastifyInstance,
  ctx: AppContext,
  fetchImpl: OAuthFetch = (u, i) => fetch(u, i),
): Promise<void> {
  const redirectUri = `${ctx.config.appOrigin}${CALLBACK_PATH}`;
  const cookieBase = {
    path: COOKIE_PATH,
    httpOnly: true,
    secure: ctx.config.isProduction,
    sameSite: 'lax' as const,
  };
  const home = (error?: string) => `/${error ? `?auth_error=${error}` : ''}#/today`;

  app.get('/api/v1/auth/google/start', async (req, reply) => {
    const cfg = ctx.config.googleLogin;
    if (!cfg) throw notConfigured('Google sign-in');
    const t = newTransaction();
    reply.setCookie(OAUTH_COOKIE, sealTransaction(ctx.config.sessionSecret, t), {
      ...cookieBase,
      maxAge: OAUTH_MAX_AGE_SECONDS,
    });
    const q = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state: t.state,
      nonce: t.nonce,
      code_challenge: challengeFor(t.verifier),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    return reply.redirect(`${AUTH_URL}?${q.toString()}`);
  });

  app.get(CALLBACK_PATH, async (req, reply) => {
    const cfg = ctx.config.googleLogin;
    if (!cfg) throw notConfigured('Google sign-in');
    reply.clearCookie(OAUTH_COOKIE, cookieBase);
    const fail = async (reason: string, error = 'google') => {
      await audit(ctx, req, { type: 'auth.google_failed', metadata: { reason } });
      return reply.redirect(home(error));
    };

    const q = callbackQuery.safeParse(req.query);
    if (!q.success) return fail('bad_query');
    if (q.data.error)
      return fail(`provider_${q.data.error}`, q.data.error === 'access_denied' ? 'google_denied' : 'google');
    const txn = openTransaction(ctx.config.sessionSecret, req.cookies[OAUTH_COOKIE]);
    if (!txn || !q.data.code || !q.data.state || !sameSecret(q.data.state, txn.state))
      return fail('bad_state');

    let claimsOk: GoogleClaims;
    try {
      const res = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: q.data.code,
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          code_verifier: txn.verifier,
        }).toString(),
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
      });
      if (!res.ok) return await fail(`token_${res.status}`);
      const body = tokenResponse.parse(JSON.parse(await res.text()));
      claimsOk = readIdToken(body.id_token, {
        clientId: cfg.clientId,
        nonce: txn.nonce,
        now: ctx.now().getTime(),
      });
    } catch (e) {
      return fail(`verify_${(e as Error).message.slice(0, 40)}`);
    }

    const db = requireDb(ctx);
    const display = (claimsOk.given_name ?? claimsOk.name ?? '').trim().slice(0, 60) || null;
    const email = claimsOk.email.toLowerCase();
    const [bySub] = await db.select({ id: users.id }).from(users).where(eq(users.googleSub, claimsOk.sub));
    let userId: string;
    if (bySub) {
      userId = bySub.id;
    } else {
      const [byEmail] = await db
        .select({ id: users.id, sub: users.googleSub })
        .from(users)
        .where(eq(users.email, email));
      if (byEmail) {
        // Same verified email as an existing account: link it so the person keeps their data.
        if (byEmail.sub) return fail('sub_mismatch');
        await db.update(users).set({ googleSub: claimsOk.sub }).where(eq(users.id, byEmail.id));
        userId = byEmail.id;
      } else {
        // New to us: upgrade this browser's anonymous user in place, keeping anything already saved.
        userId = await ensureUser(ctx, req, reply);
        const [cur] = await db.select({ kind: users.kind }).from(users).where(eq(users.id, userId));
        if (cur?.kind === 'registered') return fail('already_signed_in', 'google_signed_in');
        await db
          .update(users)
          .set({ kind: 'registered', email, googleSub: claimsOk.sub, displayName: display })
          .where(eq(users.id, userId));
      }
    }
    await db.update(users).set({ lastSeenAt: ctx.now() }).where(eq(users.id, userId));
    reply.setCookie(SESSION_COOKIE, signSession(ctx.config.sessionSecret, userId), cookieOptions(ctx, true));
    await audit(ctx, req, { userId, type: 'auth.google_login' });
    return reply.redirect(home());
  });
}
