import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/client', () => ({ getDb: () => { throw new Error('not used'); } }));
const { capError, MAX_ERROR_LENGTH } = await import('../store');

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
