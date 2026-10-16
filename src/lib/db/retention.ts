import type { Pool } from 'pg';

/**
 * Audit retention (NS_AUDIT_RETENTION_DAYS) for the partitioned audit tables.
 *
 * Migration 0005 set retention = '90 days' in partman.part_config. This makes
 * the window deployment config: at boot, after migrations, the configured value
 * is written to part_config (only where it differs), and the regular
 * maintenance run (maintenance.ts) drops partitions outside it.
 *
 * Partitions are MONTHLY, and pg_partman drops a whole partition only once its
 * upper bound is older than the window. A row therefore lives between N and
 * about N + 31 days. Below one partition width the number stops describing
 * what happens (N = 7 would keep rows for up to ~38 days), so the minimum is
 * 31. The maximum, 3650 (ten years), only catches typos.
 */
export const AUDIT_PARENT_TABLES = ['public.notification_event', 'public.delivery_attempt'] as const;

export const DEFAULT_AUDIT_RETENTION_DAYS = 90;
export const MIN_AUDIT_RETENTION_DAYS = 31;
export const MAX_AUDIT_RETENTION_DAYS = 3650;

/** Parse NS_AUDIT_RETENTION_DAYS; throws on anything but an integer in range. */
export function auditRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.NS_AUDIT_RETENTION_DAYS;
  if (raw === undefined) return DEFAULT_AUDIT_RETENTION_DAYS;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < MIN_AUDIT_RETENTION_DAYS || n > MAX_AUDIT_RETENTION_DAYS) {
    throw new Error(
      `NS_AUDIT_RETENTION_DAYS must be an integer from ${MIN_AUDIT_RETENTION_DAYS} to ` +
        `${MAX_AUDIT_RETENTION_DAYS} (days), got '${raw}'`,
    );
  }
  return n;
}

export interface AppliedRetention {
  /** The part_config value, e.g. '90 days'. */
  retention: string;
  /** Parent tables whose row was changed by this call (empty when already set). */
  updated: string[];
}

/**
 * Write the retention window to partman.part_config for both audit tables.
 *
 * Idempotent: only rows that differ are written, so replicas booting together
 * just race to a no-op and steady-state boots take no row locks. Also pins
 * retention_keep_table/index = false (drop, not detach), as 0005 did.
 *
 * Throws if part_config has no row for an audit table: pg_partman would then
 * never drop anything, and retention silently off is the failure to avoid.
 */
export async function applyAuditRetention(
  db: Pick<Pool, 'query'>,
  days: number,
): Promise<AppliedRetention> {
  const tables = [...AUDIT_PARENT_TABLES];
  const { rows: found } = await db.query<{ parent_table: string }>(
    `SELECT parent_table FROM partman.part_config WHERE parent_table = ANY($1::text[])`,
    [tables],
  );
  const present = new Set(found.map((r) => r.parent_table));
  const missing = tables.filter((t) => !present.has(t));
  if (missing.length > 0) {
    throw new Error(
      `Audit retention cannot be applied: no partman.part_config row for ${missing.join(', ')}; ` +
        `pg_partman would never drop those partitions`,
    );
  }

  const { rows: changed } = await db.query<{ parent_table: string }>(
    `UPDATE partman.part_config
        SET retention            = $1::int || ' days',
            retention_keep_table = false,
            retention_keep_index = false
      WHERE parent_table = ANY($2::text[])
        AND (retention IS DISTINCT FROM $1::int || ' days'
             OR retention_keep_table
             OR retention_keep_index)
      RETURNING parent_table`,
    [days, tables],
  );
  const retention = `${days} days`;
  const updated = changed.map((r) => r.parent_table);
  console.log(
    `Audit retention: ${retention} (${updated.length > 0 ? `updated ${updated.join(', ')}` : 'unchanged'})`,
  );
  return { retention, updated };
}
