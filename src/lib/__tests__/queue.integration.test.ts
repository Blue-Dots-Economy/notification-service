/**
 * Integration coverage for the parts of the queue whose correctness IS the Redis
 * semantics — specifically the atomic claim in `popScheduledRetries` (#51).
 *
 * Excluded from `pnpm test` (see vitest.config.ts) and run by `pnpm test:integration`
 * against a real server: locally `redis-server --port 6399`, in CI the `redis`
 * service container. The in-process fake cannot substitute here: it is
 * single-threaded, so it can never interleave two claims.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Job } from 'src/types';

const redis = (await import('../redis')).default;
const queue = await import('../queue');

const RETRY_ZSET = 'queue:retry';

const job = (id: string): Job => ({
  job_id: id,
  channel: 'email',
  priority: 'other',
  to: `${id}@example.com`,
  template_id: 'welcome',
  variables: {},
});

beforeEach(async () => {
  await redis.del(RETRY_ZSET);
});

afterAll(async () => {
  await redis.del(RETRY_ZSET);
  await redis.quit();
});

describe('popScheduledRetries against real Redis', () => {
  it('returns every due job exactly once across concurrent claims', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `j${i}`);
    for (const id of ids) await queue.scheduleRetry(job(id), -1);

    // Eight claimers racing for the same 50 due jobs.
    const batches = await Promise.all(
      Array.from({ length: 8 }, () => queue.popScheduledRetries()),
    );

    const claimed = batches.flat().map((j) => j.job_id);

    // No job claimed twice — the double-processing mode from #51.
    expect(new Set(claimed).size).toBe(claimed.length);
    // No job lost — every scheduled job was claimed by exactly one caller.
    expect(claimed.sort()).toEqual([...ids].sort());
    expect(await redis.zcard(RETRY_ZSET)).toBe(0);
  });

  it('never deletes a job it did not return, even when writes land mid-claim', async () => {
    // Interleave claims with fresh due writes. Under the old
    // ZRANGEBYSCORE-then-ZREMRANGEBYSCORE implementation, a job written between
    // the two calls fell inside the deleted score range without being returned.
    const claimed: string[] = [];
    const written: string[] = [];

    await Promise.all(
      Array.from({ length: 40 }, async (_, i) => {
        const id = `race-${i}`;
        written.push(id);
        await queue.scheduleRetry(job(id), -1);
        const got = await queue.popScheduledRetries();
        claimed.push(...got.map((j) => j.job_id));
      }),
    );

    // Anything written is either claimed or still parked — never silently gone.
    const remaining = (await redis.zrange(RETRY_ZSET, 0, -1)).map(
      (raw) => (JSON.parse(raw) as Job).job_id,
    );
    expect([...claimed, ...remaining].sort()).toEqual([...written].sort());
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it('leaves future retries parked while claiming only the due ones', async () => {
    await queue.scheduleRetry(job('due-1'), -5);
    await queue.scheduleRetry(job('due-2'), -1);
    await queue.scheduleRetry(job('future'), 600);

    const claimed = await queue.popScheduledRetries();

    expect(claimed.map((j) => j.job_id).sort()).toEqual(['due-1', 'due-2']);
    expect(await redis.zcard(RETRY_ZSET)).toBe(1);
  });

  it('returns an empty array when nothing is due, without error', async () => {
    await queue.scheduleRetry(job('future'), 600);

    expect(await queue.popScheduledRetries()).toEqual([]);
    expect(await redis.zcard(RETRY_ZSET)).toBe(1);
  });
});
