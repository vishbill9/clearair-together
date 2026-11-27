import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const OAUTH_COOKIE = 'ca_oauth';
export const OAUTH_MAX_AGE_SECONDS = 600;

export interface OAuthTransaction {
  state: string;
  nonce: string;
  verifier: string;
}

const mac = (secret: string, body: string) =>
  createHmac('sha256', secret).update(`oauth:${body}`).digest('base64url');

export const newTransaction = (): OAuthTransaction => ({
  state: randomBytes(24).toString('base64url'),
  nonce: randomBytes(24).toString('base64url'),
  verifier: randomBytes(48).toString('base64url'),
});

/** PKCE S256 challenge for a code verifier. */
export const challengeFor = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

/** Signed, short-lived cookie value binding the browser that started sign-in to its callback. */
export function sealTransaction(secret: string, t: OAuthTransaction, now = Date.now()): string {
  const body = Buffer.from(
    JSON.stringify({ ...t, exp: Math.floor(now / 1000) + OAUTH_MAX_AGE_SECONDS }),
  ).toString('base64url');
  return `${body}.${mac(secret, body)}`;
}

const sealedSchema = z.object({
  state: z.string(),
  nonce: z.string(),
  verifier: z.string(),
  exp: z.number(),
});

/** Returns the cookie body when its signature is valid, otherwise null. */
function verifiedBody(secret: string, cookie: string | undefined): string | null {
  if (!cookie || cookie.length > 1000) return null;
  const [body, sig, extra] = cookie.split('.');
  if (!body || !sig || extra !== undefined) return null;
  return sameSecret(sig, mac(secret, body)) ? body : null;
}

/** Reads a sealed transaction; null when the cookie is missing, tampered with, malformed or expired. */
export function openTransaction(
  secret: string,
  cookie: string | undefined,
  now = Date.now(),
): OAuthTransaction | null {
  const body = verifiedBody(secret, cookie);
  if (!body) return null;
  try {
    const v = sealedSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
    return v.exp * 1000 < now ? null : { state: v.state, nonce: v.nonce, verifier: v.verifier };
  } catch {
    return null;
  }
}

/** Constant-time string comparison. */
export const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
