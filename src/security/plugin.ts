import type { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  csrfCheck,
  newCsrfToken,
  verifySession,
} from './session.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function allowedOrigins(c: Config): Set<string> {
  return new Set([new URL(c.appOrigin).origin, ...c.corsAllowedOrigins]);
}

const PERMISSIONS_POLICY =
  'camera=(), microphone=(self), geolocation=(self), payment=(), usb=(), bluetooth=(), serial=(), display-capture=(), interest-cohort=()';
const CSRF_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
const isApi = (url: string) => url.startsWith('/api/') || url === '/health';

/** Strict CSP (no inline script or style), HSTS in production, and no caching of API responses. */
async function registerHeaders(app: FastifyInstance, config: Config): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'media-src': ["'self'", 'blob:'],
        'font-src': ["'self'"],
        'connect-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'self'"],
        // Clickjacking protection: only self (and any explicitly allowlisted preview hosts) may frame the app.
        'frame-ancestors': ["'self'", ...config.frameAncestors],
        ...(config.isProduction ? { 'upgrade-insecure-requests': [] } : {}),
      },
    },
    frameguard: false, // superseded by CSP frame-ancestors, which supports an allowlist
    hsts: config.isProduction ? { maxAge: 31536000, includeSubDomains: true, preload: false } : false,
    referrerPolicy: { policy: 'no-referrer' },
    xContentTypeOptions: true,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    xPoweredBy: false,
  });
  app.addHook('onSend', async (req, reply) => {
    reply.header('permissions-policy', PERMISSIONS_POLICY);
    if (isApi(req.url)) reply.header('cache-control', 'no-store');
  });
}

async function registerCors(app: FastifyInstance, origins: Set<string>): Promise<void> {
  await app.register(cors, {
    // No origin means same-origin or non-browser; no CORS headers are needed.
    origin: (origin, cb) => cb(null, Boolean(origin) && origins.has(origin!)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', CSRF_HEADER],
    maxAge: 600,
  });
}

/** API traffic only; signed-in users are limited per user, so a shared NAT cannot starve others. */
async function registerRateLimit(app: FastifyInstance, config: Config): Promise<void> {
  await app.register(rateLimit, {
    global: true,
    allowList: (req) => !isApi(req.url),
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (req) => verifySession(config.sessionSecret, req.cookies?.[SESSION_COOKIE]) ?? req.ip,
    errorResponseBuilder: () =>
      new AppError('rate_limited', 429, 'Too many requests. Please slow down and try again shortly.'),
  });
}

/** Double-submit CSRF: every client gets a signed token cookie; API writes must echo it in a header. */
function registerCsrf(app: FastifyInstance, config: Config, origins: Set<string>): void {
  const secret = config.sessionSecret;
  app.addHook('onRequest', async (req, reply) => {
    const c = req.cookies?.[CSRF_COOKIE];
    if (c && csrfCheck(secret, c, c)) return;
    const token = newCsrfToken(secret);
    req.cookies[CSRF_COOKIE] = token;
    reply.setCookie(CSRF_COOKIE, token, {
      path: '/',
      httpOnly: false,
      secure: config.isProduction,
      sameSite: 'lax',
      maxAge: CSRF_COOKIE_MAX_AGE,
    });
  });

  app.addHook('preHandler', async (req) => {
    if (!MUTATING.has(req.method) || !req.url.startsWith('/api/')) return;
    const origin = req.headers.origin;
    if (origin && !origins.has(origin))
      throw new AppError('csrf_failed', 403, 'Cross-origin request rejected.');
    const header = req.headers[CSRF_HEADER];
    if (!csrfCheck(secret, req.cookies?.[CSRF_COOKIE], typeof header === 'string' ? header : undefined)) {
      throw new AppError('csrf_failed', 403, 'Missing or invalid CSRF token.');
    }
  });
}

/** Security headers, CORS, rate limiting and CSRF protection for every route. */
export async function registerSecurity(app: FastifyInstance, config: Config): Promise<void> {
  const origins = allowedOrigins(config);
  await app.register(cookie);
  await registerHeaders(app, config);
  await registerCors(app, origins);
  await registerRateLimit(app, config);
  registerCsrf(app, config, origins);
}
