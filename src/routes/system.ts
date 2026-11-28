import type { FastifyInstance } from 'fastify';
import { requireUser, type AppContext } from '../context.js';
import { ok } from '../envelope.js';
import { CSRF_COOKIE } from '../security/session.js';

type DatabaseState = 'ok' | 'down' | 'not_configured';

async function databaseState(ctx: AppContext): Promise<DatabaseState> {
  if (!ctx.dbh) return 'not_configured';
  try {
    await ctx.dbh.sql`select 1`;
    return 'ok';
  } catch {
    return 'down';
  }
}

async function isAuthenticated(ctx: AppContext, req: Parameters<typeof requireUser>[1]): Promise<boolean> {
  if (!ctx.dbh) return false;
  try {
    await requireUser(ctx, req);
    return true;
  } catch {
    return false;
  }
}

/** Liveness, public feature flags and the CSRF/session bootstrap. */
export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  const cfg = ctx.config;

  app.get('/health', async (req) => {
    const database = await databaseState(ctx);
    return ok(req.id, {
      status: database === 'down' ? 'degraded' : 'ok',
      time: ctx.now().toISOString(),
      database,
      integrations: cfg.integrations,
    });
  });

  app.get('/api/v1/config', (req, reply) =>
    reply.send(
      ok(req.id, {
        integrations: cfg.integrations,
        maxForecastHours: cfg.airQuality.maxForecastHours,
        cacheTtlSeconds: cfg.airQuality.cacheTtlSeconds,
        environment: cfg.env,
      }),
    ),
  );

  app.get('/api/v1/session', async (req) =>
    ok(req.id, {
      csrfToken: req.cookies[CSRF_COOKIE] ?? null,
      authenticated: await isAuthenticated(ctx, req),
    }),
  );
}
