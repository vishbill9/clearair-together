import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { createDb, type DbHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

const ADMIN = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5544/clearair_test';

export interface TestDb extends DbHandle {
  url: string;
  drop(): Promise<void>;
}

/** Creates an isolated, fully migrated database on real Postgres for one test file. */
export async function createTestDb(): Promise<TestDb> {
  const name = `t_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const admin = postgres(ADMIN, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(ADMIN);
  u.pathname = `/${name}`;
  const url = u.toString();
  await runMigrations(url);
  const handle = createDb(url);
  return {
    ...handle,
    url,
    async drop() {
      await handle.close();
      const a = postgres(ADMIN, { max: 1, onnotice: () => undefined });
      await a.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}
