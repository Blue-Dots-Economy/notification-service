import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { AUDIT_PARENT_TABLES, applyAuditRetention, auditRetentionDays } from '../retention';

describe('auditRetentionDays', () => {
  it('defaults to 90', () => {
    expect(auditRetentionDays({})).toBe(90);
  });

  it.each([
    ['31', 31],
    ['30', null],
    ['365', 365],
    ['3650', 3650],
  ])('NS_AUDIT_RETENTION_DAYS=%s', (raw, expected) => {
    if (expected === null) {
      expect(() => auditRetentionDays({ NS_AUDIT_RETENTION_DAYS: raw })).toThrow('NS_AUDIT_RETENTION_DAYS');
    } else {
      expect(auditRetentionDays({ NS_AUDIT_RETENTION_DAYS: raw })).toBe(expected);
    }
  });

  it.each(['', ' ', 'abc', '90.5', '1e2', '-90', '0', '3651', '90 days', '0x5a'])(
    'rejects %j naming the variable and the allowed range',
    (raw) => {
      expect(() => auditRetentionDays({ NS_AUDIT_RETENTION_DAYS: raw })).toThrow(
        /NS_AUDIT_RETENTION_DAYS must be an integer from 31 to 3650/,
      );
    },
  );
});

type Call = { text: string; values?: unknown[] };

function fakeDb(found: string[], updated: string[]) {
  const calls: Call[] = [];
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    calls.push({ text, values });
    if (/^\s*SELECT/i.test(text)) return { rows: found.map((parent_table) => ({ parent_table })) };
    return { rows: updated.map((parent_table) => ({ parent_table })) };
  });
  return { db: { query } as unknown as Pick<Pool, 'query'>, calls };
}

describe('applyAuditRetention', () => {
  it('writes the window as a bound parameter, never interpolated', async () => {
    const { db, calls } = fakeDb([...AUDIT_PARENT_TABLES], [...AUDIT_PARENT_TABLES]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(applyAuditRetention(db, 45)).resolves.toEqual({
        retention: '45 days',
        updated: [...AUDIT_PARENT_TABLES],
      });
    } finally {
      log.mockRestore();
    }
    const update = calls.find((c) => /UPDATE\s+partman\.part_config/i.test(c.text));
    expect(update).toBeDefined();
    expect(update!.text).not.toContain('45');
    expect(update!.values).toContain(45);
    // Drop, not detach.
    expect(update!.text).toMatch(/retention_keep_table\s*=\s*false/);
    // Only rows that differ are written.
    expect(update!.text).toMatch(/IS DISTINCT FROM/);
  });

  it('logs the effective retention once', async () => {
    const { db } = fakeDb([...AUDIT_PARENT_TABLES], []);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(applyAuditRetention(db, 90)).resolves.toEqual({ retention: '90 days', updated: [] });
      const lines = log.mock.calls.map((c) => c.join(' ')).filter((l) => /audit retention/i.test(l));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('90 days');
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    [[], AUDIT_PARENT_TABLES.join(', ')],
    [['public.notification_event'], 'public.delivery_attempt'],
  ])('fails loudly when part_config has no row for a table (found %j)', async (found, missing) => {
    const { db, calls } = fakeDb(found, []);
    await expect(applyAuditRetention(db, 90)).rejects.toThrow(missing);
    expect(calls.some((c) => /UPDATE/i.test(c.text))).toBe(false);
  });
});
