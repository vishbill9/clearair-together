import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface DbHandle {
  db: Db;
  sql: postgres.Sql;
  close(): Promise<void>;
}

export function createDb(databaseUrl: string): DbHandle {
  // Parameterized queries only: postgres.js sends values separately from the SQL text.
  const sql = postgres(databaseUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    onnotice: () => {},
  });
  return { db: drizzle(sql, { schema }), sql, close: () => sql.end({ timeout: 5 }) };
}
