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

export async function registerSecurity(app: FastifyInstance, config: Config): Promise<void> {
  const origins = allowedOrigins(config);
  await app.register(cookie);

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
    frameguard: false, // superseded by CSP frame-ancestors, which supports an allowlist for the preview
    hsts: config.isProduction ? { maxAge: 31536000, includeSubDomains: true, preload: false } : false,
    referrerPolicy: { policy: 'no-referrer' },
    xContentTypeOptions: true,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    xPoweredBy: false,
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header(
      'permissions-policy',
      'camera=(), microphone=(self), geolocation=(self), payment=(), usb=(), bluetooth=(), serial=(), display-capture=(), interest-cohort=()',
    );
    if (_req.url.startsWith('/api/') || _req.url === '/health') reply.header('cache-control', 'no-store');
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, false); // same-origin or non-browser; no CORS headers needed
      cb(null, origins.has(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', CSRF_HEADER],
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: true,
    // Only API traffic is limited; static assets are cheap and must never be starved by API bursts.
    allowList: (req) => !req.url.startsWith('/api/') && req.url !== '/health',
    max: 120,
    timeWindow: '1 minute',
    // Authenticated users are limited per user as well as per IP, so shared NATs cannot starve each other.
    keyGenerator: (req) => verifySession(config.sessionSecret, req.cookies?.[SESSION_COOKIE]) ?? req.ip,
    errorResponseBuilder: () =>
      new AppError('rate_limited', 429, 'Too many requests. Please slow down and try again shortly.'),
  });

  // Issue a CSRF cookie to every client that lacks a valid one.
  app.addHook('onRequest', async (req, reply) => {
    const c = req.cookies?.[CSRF_COOKIE];
    if (!c || !csrfCheck(config.sessionSecret, c, c)) {
      const token = newCsrfToken(config.sessionSecret);
      req.cookies[CSRF_COOKIE] = token;
      reply.setCookie(CSRF_COOKIE, token, {
        path: '/',
        httpOnly: false,
        secure: config.isProduction,
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 30,
      });
    }
  });

  app.addHook('preHandler', async (req) => {
    if (!MUTATING.has(req.method) || !req.url.startsWith('/api/')) return;
    const origin = req.headers.origin;
    if (origin && !origins.has(origin))
      throw new AppError('csrf_failed', 403, 'Cross-origin request rejected.');
    const header = req.headers[CSRF_HEADER];
    if (
      !csrfCheck(
        config.sessionSecret,
        req.cookies?.[CSRF_COOKIE],
        typeof header === 'string' ? header : undefined,
      )
    ) {
      throw new AppError('csrf_failed', 403, 'Missing or invalid CSRF token.');
    }
  });
}
