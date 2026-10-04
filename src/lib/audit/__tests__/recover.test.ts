import { describe, expect, it, vi } from 'vitest';

// Unit-level: the connection-handling paths a real database cannot be made to
// produce on demand. Behaviour against real rows is recover.integration.test.ts.
vi.mock('../../redis', () => ({
  default: {
    set: vi.fn(async () => 'OK'),
    exists: vi.fn(async () => 1),
    eval: vi.fn(async () => 1),
    mget: vi.fn(async () => []),
  },
}));
vi.mock('../../metrics', () => ({ incr: vi.fn(async () => {}) }));
vi.mock('../../queue', () => ({ pushManyToPriority: vi.fn(async () => {}) }));

const release = vi.fn();
const query = vi.fn();
vi.mock('../../db/client', () => ({ getPool: () => ({ connect: async () => ({ query, release }) }) }));

const { recoverAtBoot, recoverLostJobs, recoveryMaxAgeHours } = await import('../recover');

describe('recoverLostJobs connection handling', () => {
  it('destroys the connection when ROLLBACK itself fails', async () => {
    const rollbackErr = new Error('connection terminated');
    query.mockImplementation(async (q: string | { text: string }) => {
      const text = typeof q === 'string' ? q : q.text;
      if (text.startsWith('SELECT')) throw new Error('statement timeout');
      if (text === 'ROLLBACK') throw rollbackErr;
      return { rows: [] };
    });
    await expect(recoverLostJobs({ maxAgeHours: 24 })).rejects.toThrow('statement timeout');
    expect(release).toHaveBeenCalledWith(rollbackErr);
  });

  it('returns a healthy connection normally', async () => {
    release.mockClear();
    query.mockReset().mockResolvedValue({ rows: [] });
    await recoverLostJobs({ maxAgeHours: 24 });
    expect(release).toHaveBeenCalledWith(undefined);
    expect(query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : 'q'))).toContain(
      "SET LOCAL statement_timeout = '60s'",
    );
  });
});

describe('recoveryMaxAgeHours', () => {
  it('defaults to 24', () => expect(recoveryMaxAgeHours({})).toBe(24));
  it('reads the override', () => expect(recoveryMaxAgeHours({ RECOVERY_MAX_AGE_HOURS: '6' })).toBe(6));
  it('rejects non-positive or non-integer values', () => {
    expect(() => recoveryMaxAgeHours({ RECOVERY_MAX_AGE_HOURS: '0' })).toThrow('RECOVERY_MAX_AGE_HOURS');
    expect(() => recoveryMaxAgeHours({ RECOVERY_MAX_AGE_HOURS: '1.5' })).toThrow('RECOVERY_MAX_AGE_HOURS');
    expect(() => recoveryMaxAgeHours({ RECOVERY_MAX_AGE_HOURS: 'abc' })).toThrow('RECOVERY_MAX_AGE_HOURS');
  });
});

describe('recoverAtBoot', () => {
  it('logs and resolves when recovery fails, so boot continues', async () => {
    query.mockReset().mockRejectedValue(new Error('connection refused'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(recoverAtBoot()).resolves.toBeUndefined();
      expect(err.mock.calls.flat().join(' ')).toContain('connection refused');
    } finally {
      err.mockRestore();
    }
  });
});
