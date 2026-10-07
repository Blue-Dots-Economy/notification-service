import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getPool } from '../client';
import { runMigrations } from '../migrate';
import { runPartitionMaintenance } from '../maintenance';
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

  it.each(['notification_event', 'delivery_attempt'])(
    '%s keeps 90 days: maintenance drops a partition whose whole month is older',
    async (table) => {
      const { rows: cfg } = await getPool().query(
        `SELECT retention, retention_keep_table FROM partman.part_config WHERE parent_table = $1`,
        [`public.${table}`],
      );
      expect(cfg[0]).toEqual({ retention: '90 days', retention_keep_table: false });

      // A month that ended well over 90 days ago, and last month (inside the window).
      const now = new Date();
      const old = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 6, 1));
      const recent = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      await getPool().query(`SELECT partman.create_partition_time($1, ARRAY[$2::timestamptz, $3::timestamptz])`, [
        `public.${table}`,
        old.toISOString(),
        recent.toISOString(),
      ]);
      const tag = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      expect((await childPartitions(table)).some((p) => p.includes(tag(old)))).toBe(true);

      await expect(runPartitionMaintenance()).resolves.toBe(true);

      const after = await childPartitions(table);
      expect(after.some((p) => p.includes(tag(old)))).toBe(false);
      expect(after.some((p) => p.includes(tag(recent)))).toBe(true);
      expect(after.some((p) => p.includes(tag(now)))).toBe(true);
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
