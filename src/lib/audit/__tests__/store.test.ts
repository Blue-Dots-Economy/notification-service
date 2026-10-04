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
