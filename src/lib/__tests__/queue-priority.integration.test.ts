import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import redis from '../redis';
import { deferJob, moveDueRetries, popFrom, pushToPriority, QUEUE_KEYS } from '../queue';
import type { Job } from 'src/types';

const job = (id: string, priority: Job['priority']): Job => ({
  job_id: id, channel: 'sms', priority, to: '+919999999999', template_id: 't', variables: {},
});

beforeEach(async () => {
  await redis.del(QUEUE_KEYS.realtime, QUEUE_KEYS.other, QUEUE_KEYS.bulk, 'queue:retry', 'queue:dlq');
});
afterAll(() => redis.disconnect());

describe('priority queues', () => {
  it('pushes and pops per priority on a dedicated connection', async () => {
    const conn = redis.duplicate();
    try {
      await pushToPriority(job('b1', 'bulk'));
      expect(await popFrom(conn, 'realtime', 1)).toBeNull();
      expect((await popFrom(conn, 'bulk', 1))?.job_id).toBe('b1');
    } finally {
      conn.disconnect();
    }
  });

  it('due retries return to their own priority queue', async () => {
    await deferJob(job('r1', 'realtime'), -1);
    await deferJob(job('o1', 'other'), -1);
    await deferJob(job('b1', 'bulk'), -1);
    await deferJob(job('later', 'bulk'), 60_000);
    expect(await moveDueRetries()).toBe(3);
    expect(await redis.lrange(QUEUE_KEYS.realtime, 0, -1)).toHaveLength(1);
    expect(await redis.lrange(QUEUE_KEYS.other, 0, -1)).toHaveLength(1);
    expect(await redis.lrange(QUEUE_KEYS.bulk, 0, -1)).toHaveLength(1);
    expect(await redis.zcard('queue:retry')).toBe(1);
  });

  it('deferJob does not change the attempt count', async () => {
    await deferJob({ ...job('a', 'other'), attempt: 2 }, -1);
    await moveDueRetries();
    const [raw] = await redis.lrange(QUEUE_KEYS.other, 0, -1);
    expect(JSON.parse(raw!).attempt).toBe(2);
  });

  it('concurrent schedulers never move a retry twice', async () => {
    for (let i = 0; i < 50; i++) await deferJob(job(`j${i}`, 'other'), -1);
    const moved = await Promise.all(Array.from({ length: 8 }, () => moveDueRetries()));
    expect(moved.reduce((a, b) => a + b, 0)).toBe(50);
    expect(await redis.llen(QUEUE_KEYS.other)).toBe(50);
  });

  it('an unparseable retry member is dead-lettered, not lost', async () => {
    await redis.zadd('queue:retry', '0', 'not json');
    expect(await moveDueRetries()).toBe(0);
    expect(await redis.lrange('queue:dlq', 0, -1)).toEqual(['not json']);
  });

  it.each(['[1,2]', '5', 'null', '{"job_id":7}', '{}'])(
    'a member that is not an object with a string job_id (%s) is dead-lettered',
    async (member) => {
      await redis.zadd('queue:retry', '0', member);
      expect(await moveDueRetries()).toBe(0);
      expect(await redis.lrange('queue:dlq', 0, -1)).toEqual([member]);
    },
  );

  it('bounds each call and moves 1500 due members exactly once across calls', async () => {
    const tx = redis.multi();
    for (let i = 0; i < 1500; i++) tx.zadd('queue:retry', '0', JSON.stringify(job(`m${i}`, 'bulk')));
    await tx.exec();
    expect(await moveDueRetries()).toBe(1000);
    expect(await moveDueRetries()).toBe(500);
    expect(await moveDueRetries()).toBe(0);
    const ids = (await redis.lrange(QUEUE_KEYS.bulk, 0, -1)).map((r) => JSON.parse(r).job_id);
    expect(ids).toHaveLength(1500);
    expect(new Set(ids).size).toBe(1500);
  });

  it('an unknown priority is pushed to the other queue, even for inherited keys', async () => {
    await pushToPriority({ ...job('x', 'other'), priority: 'constructor' as never });
    expect(await redis.llen(QUEUE_KEYS.other)).toBe(1);
  });
});
