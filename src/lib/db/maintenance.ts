import type { Pool, PoolClient } from 'pg';
import { getPool } from './client';
import * as metrics from '../metrics';
import { describeDbError } from './errors';

/**
 * pg_partman maintenance, driven by NS rather than pg_partman's background
 * worker (which needs shared_preload_libraries — a cluster-wide RDS parameter
 * change for one tenant). Pre-makes future monthly partitions. It does NOT
 * move rows out of the default partition: a row sitting in the default for a
 * range that a new partition would cover makes run_maintenance skip that
 * partition set, so each tick also runs partman.check_default() and reports
 * non-empty defaults (warning log + ns_partition_default_rows{parent}).
 * Moving them is a manual partman.partition_data_proc(). Retention (dropping
 * old partitions) is not configured until #65, so this never drops anything.
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
      await checkDefaultPartitions(client);
      return true;
    } finally {
      await client.query(`SELECT pg_advisory_unlock(${PARTMAN_LOCK_SQL_KEY})`);
    }
  } finally {
    client.release();
  }
}

/**
 * Report rows in each partitioned table's default partition. With
 * p_exact_count := false partman stops at the first row, so the value is 1 for
 * "non-empty" and 0 for empty — cheap, and enough to alert on.
 */
export async function checkDefaultPartitions(client: PoolClient): Promise<Record<string, number>> {
  const { rows } = await client.query<{ parent: string; n: string }>(
    `SELECT pc.parent_table AS parent, COALESCE(cd.count, 0) AS n
       FROM partman.part_config pc
       LEFT JOIN partman.check_default(p_exact_count := false) cd
         ON cd.default_table = pc.parent_table || '_default'`,
  );
  const out: Record<string, number> = {};
  for (const { parent, n } of rows) {
    const count = Number(n);
    out[parent] = count;
    await metrics.setGauge('ns_partition_default_rows', count, { parent });
    if (count > 0) {
      console.warn(
        `Partition default for ${parent} has rows; pg_partman will not pre-make partitions over that range ` +
          `until they are moved (partman.partition_data_proc)`,
      );
    }
  }
  return out;
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
