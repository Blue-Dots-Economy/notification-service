import type { Pool } from 'pg';
import { getPool } from './client';
import { describeDbError } from './errors';

/**
 * pg_partman maintenance, driven by NS rather than pg_partman's background
 * worker (which needs shared_preload_libraries — a cluster-wide RDS parameter
 * change for one tenant). Pre-makes future monthly partitions and moves rows
 * out of the default partition. Retention (dropping old partitions) is not
 * configured until #65, so this never drops anything today.
 *
 * Every replica runs the loop; a try-lock makes all but one skip each round.
 */
const PARTMAN_LOCK_SQL_KEY = "hashtext('notification-service:partman')";
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

export async function runPartitionMaintenance(pool: Pool = getPool()): Promise<boolean> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`SELECT pg_try_advisory_lock(${PARTMAN_LOCK_SQL_KEY}) AS got`);
    if (!rows[0].got) return false;
    try {
      await client.query(`CALL partman.run_maintenance_proc()`);
      return true;
    } finally {
      await client.query(`SELECT pg_advisory_unlock(${PARTMAN_LOCK_SQL_KEY})`);
    }
  } finally {
    client.release();
  }
}

/** Run once now, then on an interval. Failures are logged, never thrown. */
export function startPartitionMaintenance(
  intervalMs = Number(process.env.PARTITION_MAINTENANCE_INTERVAL_MS) || DEFAULT_INTERVAL_MS,
): NodeJS.Timeout {
  const tick = () =>
    runPartitionMaintenance().catch((err) =>
      console.error('Partition maintenance failed:', describeDbError(err)),
    );
  void tick();
  return setInterval(tick, intervalMs).unref();
}
