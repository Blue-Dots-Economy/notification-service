import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { loadDbConfig } from './config';

let pool: Pool | undefined;
let db: NodePgDatabase | undefined;

/** The process-wide pg pool. Created on first use. */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool(loadDbConfig());
    // An idle client erroring (server restart, network blip) emits on the pool;
    // unhandled, that kills the process. Log and let the pool reconnect.
    pool.on('error', (err) => console.error('Postgres pool error:', err.message));
  }
  return pool;
}

/** The process-wide Drizzle client over getPool(). */
export function getDb(): NodePgDatabase {
  if (!db) db = drizzle(getPool());
  return db;
}

/** Close the pool. Idempotent. */
export async function closeDb(): Promise<void> {
  const p = pool;
  pool = undefined;
  db = undefined;
  if (p) await p.end();
}
