import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const executed = vi.hoisted(() => [] as unknown[]);
vi.mock('../../db/client', () => ({
  getDb: () => ({ transaction: async (cb: (tx: unknown) => Promise<void>) => cb({ execute: async (q: unknown) => { executed.push(q); } }) }),
}));
const { capError, MAX_ERROR_LENGTH } = await import('../store');
const dialect = new PgDialect();

describe('capError', () => {
  it('caps persisted error strings at 500 chars', () => {
    expect(MAX_ERROR_LENGTH).toBe(500);
    expect(capError('e'.repeat(2000))).toHaveLength(500);
    expect(capError('short')).toBe('short');
    expect(capError(undefined)).toBeNull();
  });
});

describe('recordAcceptedMany guard', () => {
  const rec = (eventId: string, createdAt: string) =>
    ({ ids: { eventId, attemptId: 'a', createdAt, correlationId: 'c' } }) as never;
  it('refuses records that do not share one eventId and createdAt', async () => {
    const { recordAcceptedMany } = await import('../store');
    await expect(recordAcceptedMany([rec('e1', 't'), rec('e2', 't')])).rejects.toThrow(/share one eventId/);
    await expect(recordAcceptedMany([rec('e1', 't1'), rec('e1', 't2')])).rejects.toThrow(/share one eventId/);
  });
});

describe('event row identity', () => {
  const base = {
    ids: { eventId: 'e', attemptId: 'a', createdAt: 't', correlationId: 'c' },
    network: 'n', source: 's', priority: 'other' as const, channel: 'sms', templateId: 'k_sms',
    payload: {}, recoverable: true,
  };
  /** The event INSERT's column list and bound values, as one name → value map. */
  async function eventColumns(write: () => Promise<void>) {
    executed.length = 0;
    await write();
    const { sql, params } = dialect.sqlToQuery(executed[0] as SQL);
    expect(sql).toMatch(/INSERT INTO notification_event/);
    const cols = /\(([^)]*)\)\s*VALUES/.exec(sql)![1]!.split(',').map((c) => c.trim());
    return Object.fromEntries(cols.map((c, i) => [c, params[i]]));
  }

  it('every insert path writes event_type, domain and the event-level template_key', async () => {
    const { recordAccepted, recordAcceptedMany, upsertAttempt } = await import('../store');
    const rec = { ...base, eventType: 'apply', domain: 'seeker', templateKey: null };
    for (const write of [
      () => recordAccepted(rec),
      () => recordAcceptedMany([rec]),
      () => upsertAttempt(rec, { status: 'sent', attemptNo: 1 }),
    ]) {
      expect(await eventColumns(write)).toMatchObject({ event_type: 'apply', domain: 'seeker', template_key: null });
    }
  });

  it('a template_key send writes its template and null event_type and domain', async () => {
    const { recordAccepted } = await import('../store');
    const rec = { ...base, eventType: null, domain: null, templateKey: 'login_otp' };
    expect(await eventColumns(() => recordAccepted(rec))).toMatchObject({ event_type: null, domain: null, template_key: 'login_otp' });
  });
});
