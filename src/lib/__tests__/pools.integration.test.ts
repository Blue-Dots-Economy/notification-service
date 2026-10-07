import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type Redis from 'ioredis';
import redis from '../redis';
import { pushToPriority, QUEUE_KEYS } from '../queue';
import { startPools } from '../pools';
import type { Job } from 'src/types';

beforeEach(async () => {
  await redis.del(QUEUE_KEYS.realtime, QUEUE_KEYS.other, QUEUE_KEYS.bulk, 'queue:retry');
});
afterAll(() => redis.disconnect());

describe('pools', () => {
  it('urgent loop pops while a bulk loop is blocked', async () => {
    const handled: string[] = [];
    const conns: Redis[] = [];
    let releaseBulk!: () => void;
    const bulkGate = new Promise<void>((r) => {
      releaseBulk = r;
    });
    const pools = startPools(
      { realtime: 1, other: 1, bulk: 1 },
      {
        connect: () => {
          const c = redis.duplicate();
          conns.push(c);
          return c;
        },
        handle: async (job: Job) => {
          if (job.priority === 'bulk') await bulkGate; // a bulk send that takes forever
          handled.push(job.job_id);
        },
      },
    );
    try {
      await pushToPriority({ job_id: 'b', channel: 'sms', priority: 'bulk', to: 'x', template_id: 't', variables: {} });
      await new Promise((r) => setTimeout(r, 200));
      await pushToPriority({ job_id: 'otp', channel: 'sms', priority: 'realtime', to: 'x', template_id: 't', variables: {} });
      const start = Date.now();
      while (!handled.includes('otp') && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 20));
      expect(handled).toEqual(['otp']);
    } finally {
      releaseBulk();
      await pools.stop();
      for (const c of conns) c.disconnect();
    }
  });
});
