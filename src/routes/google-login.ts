import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
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
  type OAuthTransaction,
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

interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

/** A sign-in step failed. `reason` is audited; `error` is the short code shown to the user. */
class SignInFailure extends Error {
  constructor(
    readonly reason: string,
    readonly error = 'google',
  ) {
    super(reason);
  }
}

/** Exchanges the one-time code (with the PKCE verifier) for an id_token at Google's token endpoint. */
async function exchangeCode(
  fetchImpl: OAuthFetch,
  client: GoogleClient,
  grant: { code: string; verifier: string; redirectUri: string },
): Promise<string> {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: grant.code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: grant.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: grant.verifier,
    }).toString(),
    signal: AbortSignal.timeout(8000),
    redirect: 'error',
  });
  if (!res.ok) throw new SignInFailure(`token_${res.status}`);
  return tokenResponse.parse(JSON.parse(await res.text())).id_token;
}

/** Checks the callback query against the browser's sealed transaction and returns the code and PKCE data. */
function validateCallback(ctx: AppContext, query: unknown, cookie: string | undefined) {
  const q = callbackQuery.safeParse(query);
  if (!q.success) throw new SignInFailure('bad_query');
  const { code, state, error } = q.data;
  if (error)
    throw new SignInFailure(`provider_${error}`, error === 'access_denied' ? 'google_denied' : 'google');
  const txn = openTransaction(ctx.config.sessionSecret, cookie);
  if (!txn || !code || !state || !sameSecret(state, txn.state)) throw new SignInFailure('bad_state');
  return { code, txn };
}

/**
 * Finds the account for these Google claims. A known Google id signs in; a matching verified email with no
 * Google id is linked; otherwise this browser's anonymous user is upgraded in place, keeping its data.
 */
async function resolveUser(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  c: GoogleClaims,
): Promise<string> {
  const db = requireDb(ctx);
  const [bySub] = await db.select({ id: users.id }).from(users).where(eq(users.googleSub, c.sub));
  if (bySub) return bySub.id;

  const email = c.email.toLowerCase();
  const [byEmail] = await db
    .select({ id: users.id, sub: users.googleSub })
    .from(users)
    .where(eq(users.email, email));
  if (byEmail) {
    if (byEmail.sub) throw new SignInFailure('sub_mismatch');
    await db.update(users).set({ googleSub: c.sub }).where(eq(users.id, byEmail.id));
    return byEmail.id;
  }

  const userId = await ensureUser(ctx, req, reply);
  const [cur] = await db.select({ kind: users.kind }).from(users).where(eq(users.id, userId));
  if (cur?.kind === 'registered') throw new SignInFailure('already_signed_in', 'google_signed_in');
  const displayName = (c.given_name ?? c.name ?? '').trim().slice(0, 60) || null;
  await db
    .update(users)
    .set({ kind: 'registered', email, googleSub: c.sub, displayName })
    .where(eq(users.id, userId));
  return userId;
}

/** Google's consent screen URL for this transaction (PKCE S256, state and nonce). */
function authorizationUrl(clientId: string, redirectUri: string, t: OAuthTransaction): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: t.state,
    nonce: t.nonce,
    code_challenge: challengeFor(t.verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${AUTH_URL}?${q.toString()}`;
}

const home = (error?: string) => `/${error ? `?auth_error=${error}` : ''}#/today`;

/** "Sign in with Google": OAuth authorization code flow with PKCE, state and nonce. */
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
  const client = (): GoogleClient => {
    const cfg = ctx.config.googleLogin;
    if (!cfg) throw notConfigured('Google sign-in');
    return cfg;
  };

  app.get('/api/v1/auth/google/start', async (_req, reply) => {
    const { clientId } = client();
    const t = newTransaction();
    reply.setCookie(OAUTH_COOKIE, sealTransaction(ctx.config.sessionSecret, t), {
      ...cookieBase,
      maxAge: OAUTH_MAX_AGE_SECONDS,
    });
    return reply.redirect(authorizationUrl(clientId, redirectUri, t));
  });

  app.get(CALLBACK_PATH, async (req, reply) => {
    const cfg = client();
    reply.clearCookie(OAUTH_COOKIE, cookieBase);
    try {
      const { code, txn } = validateCallback(ctx, req.query, req.cookies[OAUTH_COOKIE]);
      const claims = await verifiedClaims(
        fetchImpl,
        cfg,
        { code, verifier: txn.verifier, redirectUri },
        (idToken) =>
          readIdToken(idToken, { clientId: cfg.clientId, nonce: txn.nonce, now: ctx.now().getTime() }),
      );
      const userId = await resolveUser(ctx, req, reply, claims);
      await requireDb(ctx).update(users).set({ lastSeenAt: ctx.now() }).where(eq(users.id, userId));
      reply.setCookie(
        SESSION_COOKIE,
        signSession(ctx.config.sessionSecret, userId),
        cookieOptions(ctx, true),
      );
      await audit(ctx, req, { userId, type: 'auth.google_login' });
      return reply.redirect(home());
    } catch (e) {
      if (!(e instanceof SignInFailure)) throw e;
      await audit(ctx, req, { type: 'auth.google_failed', metadata: { reason: e.reason } });
      return reply.redirect(home(e.error));
    }
  });
}

/** Token exchange plus id_token checks; any failure becomes a `verify_*` sign-in failure. */
async function verifiedClaims(
  fetchImpl: OAuthFetch,
  client: GoogleClient,
  grant: { code: string; verifier: string; redirectUri: string },
  read: (idToken: string) => GoogleClaims,
): Promise<GoogleClaims> {
  try {
    return read(await exchangeCode(fetchImpl, client, grant));
  } catch (e) {
    if (e instanceof SignInFailure) throw e;
    throw new SignInFailure(`verify_${(e as Error).message.slice(0, 40)}`);
  }
}
