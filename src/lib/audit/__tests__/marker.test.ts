import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../redis', async () => {
  const { RedisFake } = await import('../../__tests__/redis-fake');
  return { default: new RedisFake() };
});

const redis = (await import('../../redis')).default as unknown as import('../../__tests__/redis-fake').RedisFake;
const { markAttempt, readAttemptMarkers, attemptMarkerKey } = await import('../marker');

const audit = { eventId: 'e', attemptId: 'a1', createdAt: '2026-10-04T00:00:00.000Z', correlationId: 'c' };
const job = { job_id: 'j', channel: 'email', priority: 'other' as const, to: 'x', template_id: 't', variables: {}, audit };

beforeEach(() => redis.strings.clear());

describe('attempt markers', () => {
  it('writes fate:attemptNo with a TTL and reads it back in a batch', async () => {
    await markAttempt(job, 'sent', 2);
    expect(await redis.get(attemptMarkerKey('a1'))).toBe('sent:2');
    const m = await readAttemptMarkers(['a1', 'missing']);
    expect(m.get('a1')).toEqual({ fate: 'sent', attemptNo: 2 });
    expect(m.has('missing')).toBe(false);
  });

  it('round-trips the expired fate', async () => {
    await markAttempt(job, 'expired', 3);
    expect(await redis.get(attemptMarkerKey('a1'))).toBe('expired:3');
    expect((await readAttemptMarkers(['a1'])).get('a1')).toEqual({ fate: 'expired', attemptNo: 3 });
  });

  it('never throws when Redis fails', async () => {
    const set = redis.set.bind(redis);
    redis.set = (async () => { throw new Error('down'); }) as never;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(markAttempt(job, 'retry', 2)).resolves.toBeUndefined();
    } finally {
      redis.set = set;
      log.mockRestore();
    }
  });

  it('skips jobs without audit ids', async () => {
    await markAttempt({ ...job, audit: undefined }, 'sent', 1);
    expect(redis.strings.size).toBe(0);
  });
});
