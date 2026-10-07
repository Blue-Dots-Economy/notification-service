import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { loadDbConfig } from '../config';
import { migrateWithLock } from '../migrate';

// A throwaway migration folder: one migration that sleeps, so two concurrent
// runners genuinely overlap, then creates a table. Without the lock the second
// runner reads "nothing applied" before the first commits and fails on
// CREATE TABLE ... already exists.
function fixtureFolder(table: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ns-mig-'));
  mkdirSync(join(dir, 'meta'));
  writeFileSync(
    join(dir, '0000_lock_probe.sql'),
    `SELECT pg_sleep(0.5);--> statement-breakpoint\nCREATE TABLE ${table} (id int);`,
  );
  writeFileSync(
    join(dir, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: [{ idx: 0, version: '7', when: Date.now(), tag: '0000_lock_probe', breakpoints: true }],
    }),
  );
  return dir;
}

const pools: Pool[] = [];
afterAll(async () => {
  // Restore the default so later files migrate into the real ledger.
  delete process.env.NS_MIGRATIONS_TABLE;
  await Promise.all(pools.map((p) => p.end()));
});

describe('migrateWithLock', () => {
  it('serialises concurrent runners so a migration applies once', async () => {
    const table = `lock_probe_${Date.now()}`;
    const folder = fixtureFolder(table);
    const run = () => {
      const pool = new Pool(loadDbConfig());
      pools.push(pool);
      return migrateWithLock(drizzle(pool), pool, folder);
    };

    // Distinct migrations table per test run so reruns start clean.
    process.env.NS_MIGRATIONS_TABLE = `__mig_${Date.now()}`;
    await expect(Promise.all([run(), run()])).resolves.toBeDefined();

    const check = new Pool(loadDbConfig());
    pools.push(check);
    const { rows } = await check.query(`SELECT to_regclass($1) AS t`, [table]);
    expect(rows[0].t).toBe(table);
  });
});
