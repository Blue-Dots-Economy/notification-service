import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getPool } from '../client';
import { runMigrations } from '../migrate';
import { runPartitionMaintenance } from '../maintenance';
import { applyAuditRetention, auditRetentionDays } from '../retention';
import redis from '../../redis';

beforeAll(async () => {
  await runMigrations();
});
afterAll(async () => {
  await closeDb();
  redis.disconnect();
});

async function childPartitions(parent: string): Promise<string[]> {
  const { rows } = await getPool().query(
    `SELECT c.relname FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = $1 ORDER BY 1`,
    [parent],
  );
  return rows.map((r) => r.relname);
}

describe('audit partitions', () => {
  it.each(['notification_event', 'delivery_attempt'])(
    '%s is partitioned by month with premade future partitions and a default',
    async (table) => {
      const parts = await childPartitions(table);
      const now = new Date();
      const tag = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      expect(parts.some((p) => p.includes(tag(now)))).toBe(true);
      expect(parts.some((p) => p.includes(tag(next)))).toBe(true);
      expect(parts).toContain(`${table}_default`);
    },
  );

  it('insert far in the future lands in the default partition', async () => {
    await getPool().query(
      `INSERT INTO notification_event
         (id, created_at, correlation_id, network, source, priority, status, payload)
       VALUES (gen_random_uuid(), now() + interval '5 years', 'c', 'n', 's', 'other', 'accepted', '{}')`,
    );
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM notification_event_default`,
    );
    expect(rows[0].n).toBeGreaterThan(0);
    await getPool().query(`DELETE FROM notification_event_default`);
  });

  const tag = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const DAY_MS = 24 * 60 * 60 * 1000;

  async function retentionConfig(): Promise<Record<string, unknown>[]> {
    const { rows } = await getPool().query(
      `SELECT parent_table, retention, retention_keep_table, retention_keep_index
         FROM partman.part_config
        WHERE parent_table IN ('public.notification_event', 'public.delivery_attempt')
        ORDER BY parent_table`,
    );
    return rows;
  }

  it('by default (NS_AUDIT_RETENTION_DAYS unset) both audit tables keep 90 days', async () => {
    expect(auditRetentionDays({})).toBe(90);
    await expect(applyAuditRetention(getPool(), auditRetentionDays({}))).resolves.toEqual({
      retention: '90 days',
      updated: [],
    });
    expect(await retentionConfig()).toEqual([
      { parent_table: 'public.delivery_attempt', retention: '90 days', retention_keep_table: false, retention_keep_index: false },
      { parent_table: 'public.notification_event', retention: '90 days', retention_keep_table: false, retention_keep_index: false },
    ]);
  });

  it('NS_AUDIT_RETENTION_DAYS=40 updates part_config for both tables, once', async () => {
    const days = auditRetentionDays({ NS_AUDIT_RETENTION_DAYS: '40' });
    try {
      const first = await applyAuditRetention(getPool(), days);
      expect(first.retention).toBe('40 days');
      expect([...first.updated].sort()).toEqual(['public.delivery_attempt', 'public.notification_event']);
      expect((await retentionConfig()).map((r) => r.retention)).toEqual(['40 days', '40 days']);
      // A second replica booting with the same value writes nothing.
      await expect(applyAuditRetention(getPool(), days)).resolves.toEqual({ retention: '40 days', updated: [] });
    } finally {
      await applyAuditRetention(getPool(), 90);
    }
  });

  it('runMigrations applies NS_AUDIT_RETENTION_DAYS', async () => {
    process.env.NS_AUDIT_RETENTION_DAYS = '45';
    try {
      await runMigrations();
      expect((await retentionConfig()).map((r) => r.retention)).toEqual(['45 days', '45 days']);
    } finally {
      delete process.env.NS_AUDIT_RETENTION_DAYS;
      await runMigrations();
    }
    expect((await retentionConfig()).map((r) => r.retention)).toEqual(['90 days', '90 days']);
  });

  it.each(['notification_event', 'delivery_attempt'])(
    '%s: maintenance drops partitions past the configured window (90 days, then 31)',
    async (table) => {
      // Six months back: past 90 days. Three months back: its upper bound is
      // 59 to 92 days ago, so inside 90 days (bar the last day or so of a long
      // month) and always past 31. Last month: inside both windows.
      const now = new Date();
      const old = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 6, 1));
      const mid = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1));
      const midEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
      const recent = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      await getPool().query(
        `SELECT partman.create_partition_time($1, ARRAY[$2::timestamptz, $3::timestamptz, $4::timestamptz])`,
        [`public.${table}`, old.toISOString(), mid.toISOString(), recent.toISOString()],
      );
      const before = await childPartitions(table);
      expect(before.some((p) => p.includes(tag(old)))).toBe(true);
      expect(before.some((p) => p.includes(tag(mid)))).toBe(true);

      // Default 90 days: only the six-month-old partition goes.
      await expect(runPartitionMaintenance()).resolves.toBe(true);
      let after = await childPartitions(table);
      expect(after.some((p) => p.includes(tag(old)))).toBe(false);
      if (now.getTime() - midEnd.getTime() < 90 * DAY_MS) {
        expect(after.some((p) => p.includes(tag(mid)))).toBe(true);
      }
      expect(after.some((p) => p.includes(tag(recent)))).toBe(true);

      // NS_AUDIT_RETENTION_DAYS=31: the three-month-old partition goes too.
      try {
        await applyAuditRetention(getPool(), auditRetentionDays({ NS_AUDIT_RETENTION_DAYS: '31' }));
        await expect(runPartitionMaintenance()).resolves.toBe(true);
        after = await childPartitions(table);
        expect(after.some((p) => p.includes(tag(mid)))).toBe(false);
        expect(after.some((p) => p.includes(tag(now)))).toBe(true);
        // Last month ended 0 to 31 days ago, so 31 days never reaches it.
        expect(after.some((p) => p.includes(tag(recent)))).toBe(true);
      } finally {
        await applyAuditRetention(getPool(), 90);
      }
    },
  );

  it('maintenance runs, and a concurrent run yields instead of blocking', async () => {
    const holder = await getPool().connect();
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtext('notification-service:partman'))`);
      await expect(runPartitionMaintenance()).resolves.toBe(false);
    } finally {
      await holder.query(`SELECT pg_advisory_unlock(hashtext('notification-service:partman'))`);
      holder.release();
    }
    await expect(runPartitionMaintenance()).resolves.toBe(true);
  });

  it('reports a non-empty default partition via the gauge and a warning', async () => {
    const gauge = async () => redis.hget('metrics:gauges', 'ns_partition_default_rows|parent=public.notification_event');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await getPool().query(
        `INSERT INTO notification_event
           (id, created_at, correlation_id, network, source, priority, status, payload)
         VALUES (gen_random_uuid(), now() + interval '5 years', 'c', 'n', 's', 'other', 'accepted', '{}')`,
      );
      await expect(runPartitionMaintenance()).resolves.toBe(true);
      expect(await gauge()).toBe('1');
      expect(await redis.hget('metrics:gauges', 'ns_partition_default_rows|parent=public.delivery_attempt')).toBe('0');
      expect(warn.mock.calls.flat().join(' ')).toContain('public.notification_event');
    } finally {
      await getPool().query(`DELETE FROM notification_event_default`);
      warn.mockRestore();
    }
    await runPartitionMaintenance();
    expect(await gauge()).toBe('0');
  });
});
