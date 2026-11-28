import { loadConfig, ConfigError } from './config.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { buildApp } from './app.js';

async function main() {
  let config;
  try {
    config = loadConfig(process.env, (m) => console.warn(`[config] ${m}`));
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`Configuration error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
  const dbh = config.databaseUrl ? createDb(config.databaseUrl) : null;
  if (dbh && config.databaseUrl && process.env.RUN_MIGRATIONS_ON_START === 'true')
    await runMigrations(config.databaseUrl);
  const { app } = await buildApp({ config, dbh });
  const stop = async (sig: string) => {
    app.log.info({ sig }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((e: unknown) => {
  console.error('Fatal startup error:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
