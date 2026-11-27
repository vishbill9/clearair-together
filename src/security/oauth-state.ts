import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

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

export function openTransaction(
  secret: string,
  cookie: string | undefined,
  now = Date.now(),
): OAuthTransaction | null {
  if (!cookie || cookie.length > 1000) return null;
  const [body, sig, extra] = cookie.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(mac(secret, body));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<OAuthTransaction> & {
      exp?: number;
    };
    if (typeof v.exp !== 'number' || v.exp * 1000 < now) return null;
    if (typeof v.state !== 'string' || typeof v.nonce !== 'string' || typeof v.verifier !== 'string')
      return null;
    return { state: v.state, nonce: v.nonce, verifier: v.verifier };
  } catch {
    return null;
  }
}

export const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
