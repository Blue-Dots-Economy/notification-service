import path from 'node:path';
import type { Pool } from 'pg';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { closeDb, getDb, getPool } from './client';

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

/** Apply pending migrations from MIGRATIONS_FOLDER under the lock. */
export async function runMigrations(): Promise<void> {
  console.log('Applying database migrations from', MIGRATIONS_FOLDER);
  await migrateWithLock(getDb(), getPool(), MIGRATIONS_FOLDER);
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
