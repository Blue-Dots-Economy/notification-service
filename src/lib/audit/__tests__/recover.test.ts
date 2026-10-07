import { describe, expect, it, vi } from 'vitest';

// Unit-level: the connection-handling paths a real database cannot be made to
// produce on demand. Behaviour against real rows is recover.integration.test.ts.
const mget = vi.fn(async (..._keys: string[]): Promise<Array<string | null>> => []);
vi.mock('../../redis', () => ({
  default: {
    set: vi.fn(async () => 'OK'),
    exists: vi.fn(async () => 1),
    eval: vi.fn(async () => 1),
    mget,
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

describe('stampFromMarker', () => {
  it('stamps an expired marker as expired (terminal), not failed, and rolls the event up', async () => {
    const row = {
      id: 'a1', created_at: '2026-10-04 00:00:00+00', notification_event_id: 'e1',
      attempt_no: 1, job: { job_id: 'j' }, too_old: false,
    };
    mget.mockResolvedValueOnce(['expired:1']);
    const calls: Array<{ text: string; values: unknown[] }> = [];
    query.mockReset().mockImplementation(async (q: string | { text: string; values: unknown[] }) => {
      const c = typeof q === 'string' ? { text: q, values: [] } : q;
      calls.push(c);
      return { rows: c.text.includes('SKIP LOCKED') ? [row] : [] };
    });
    expect(await recoverLostJobs({ maxAgeHours: 24 })).toMatchObject({ marked: 1, requeued: 0 });
    const attemptUpdate = calls.find((c) => c.text.includes('UPDATE delivery_attempt'));
    expect(attemptUpdate?.values.slice(2, 6)).toEqual(['expired', 4, 1, 'expired (recorded by attempt marker)']);
    expect(attemptUpdate?.text).toContain('completed_at = now()');
    // The event is rolled up from its attempts, never written from the marker.
    expect(calls.some((c) => /UPDATE notification_event[\s\S]*SET status = \$/.test(c.text))).toBe(false);
    expect(calls.some((c) => c.text.includes('FOR UPDATE') && c.text.includes('notification_event'))).toBe(true);
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
