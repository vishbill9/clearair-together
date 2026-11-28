import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SESSION_COOKIE = 'ca_sid';
export const CSRF_COOKIE = 'ca_csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const mac = (secret: string, purpose: string, value: string) =>
  createHmac('sha256', secret).update(`${purpose}:${value}`).digest('base64url');

const safeEqual = (a: string, b: string) => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

/** Signed, expiring session cookie value: `userId.expiry.hmac`. */
export function signSession(secret: string, userId: string, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + SESSION_MAX_AGE_SECONDS;
  const body = `${userId}.${exp}`;
  return `${body}.${mac(secret, 'session', body)}`;
}

/** Returns the user id for a valid, unexpired cookie; otherwise null. */
export function verifySession(secret: string, cookie: string | undefined, now = Date.now()): string | null {
  if (!cookie || cookie.length > 200) return null;
  const parts = cookie.split('.');
  if (parts.length !== 3) return null;
  const [userId, exp, sig] = parts as [string, string, string];
  if (!UUID.test(userId) || !/^\d{1,12}$/.test(exp)) return null;
  if (!safeEqual(sig, mac(secret, 'session', `${userId}.${exp}`))) return null;
  if (Number(exp) * 1000 < now) return null;
  return userId;
}

/** Double-submit token: random nonce plus an HMAC so a sibling origin cannot mint one. */
export function newCsrfToken(secret: string): string {
  const nonce = randomBytes(18).toString('base64url');
  return `${nonce}.${mac(secret, 'csrf', nonce)}`;
}

function csrfTokenValid(secret: string, token: string | undefined): boolean {
  if (!token || token.length > 120) return false;
  const [nonce, sig, extra] = token.split('.');
  if (!nonce || !sig || extra !== undefined) return false;
  return safeEqual(sig, mac(secret, 'csrf', nonce));
}

/** Double-submit check: the header must equal the cookie, and the cookie must carry a valid signature. */
export function csrfCheck(secret: string, cookie: string | undefined, header: string | undefined): boolean {
  if (!cookie || !header) return false;
  return safeEqual(cookie, header) && csrfTokenValid(secret, cookie);
}
