import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getPool } from '../client';
import { runMigrations } from '../migrate';
import { runPartitionMaintenance } from '../maintenance';

beforeAll(async () => {
  await runMigrations();
});
afterAll(async () => {
  await closeDb();
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
});
