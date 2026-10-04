import path from 'node:path';
import { Pool, type PoolConfig } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { closeDb } from './client';
import { loadDbConfig } from './config';

/**
 * Advisory-lock key shared by every migration runner of this service.
 *
 * Replicas boot together. Drizzle reads the applied-migration list BEFORE it
 * opens its transaction, so two unlocked runners can both decide a migration is
 * pending and the second fails (or re-applies). Same pattern as aggregator-dpg's
 * apps/api/src/db/migrate.ts.
 */
const MIGRATION_LOCK_SQL_KEY = "hashtext('notification-service:migrations')";

/** drizzle/ at the repo root — three levels up from both src/lib/db and dist/lib/db. */
export const MIGRATIONS_FOLDER = path.resolve(__dirname, '../../../drizzle');

export async function migrateWithLock(
  db: NodePgDatabase,
  pool: Pool,
  migrationsFolder: string,
): Promise<void> {
  const lockClient = await pool.connect();
  let broken: Error | undefined;
  try {
    await lockClient.query(`SELECT pg_advisory_lock(${MIGRATION_LOCK_SQL_KEY})`);
    try {
      await migrate(db, {
        migrationsFolder,
        migrationsTable: process.env.NS_MIGRATIONS_TABLE ?? '__drizzle_migrations',
      });
    } finally {
      try {
        await lockClient.query(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_SQL_KEY})`);
      } catch (err) {
        // The server drops a session lock with its connection; discard this one
        // rather than return a connection in an unknown state.
        broken = err as Error;
      }
    }
  } finally {
    lockClient.release(broken);
  }
}

/** loadDbConfig without statement/query timeouts; two connections (lock session + migrator). */
export function migrationPoolConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const { statement_timeout: _s, query_timeout: _q, ...config } = loadDbConfig(env);
  return { ...config, max: 2 };
}

/**
 * Apply pending migrations from MIGRATIONS_FOLDER under the lock.
 *
 * Runs on a dedicated, short-lived pool with NO statement/query timeout: the
 * service pool's 5s bounds would abort a long DDL (or partman's partition
 * creation) half-way. The advisory-lock wait is therefore unbounded too, which
 * is intended — a replica waits for the one migrating. Connect timeout stays.
 */
export async function runMigrations(): Promise<void> {
  console.log('Applying database migrations from', MIGRATIONS_FOLDER);
  const pool = new Pool(migrationPoolConfig());
  pool.on('error', (err) => console.error('Postgres migration pool error:', err.message));
  try {
    await migrateWithLock(drizzle(pool), pool, MIGRATIONS_FOLDER);
  } finally {
    await pool.end();
  }
  console.log('Database migrations applied');
}

if (require.main === module) {
  runMigrations()
    .then(() => closeDb())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error('Migration failed:', err);
      await closeDb().catch(() => undefined);
      process.exit(1);
    });
}
