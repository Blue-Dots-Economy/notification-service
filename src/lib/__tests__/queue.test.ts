import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'src/types';

// One fake instance shared by the module under test and by these tests, so
// assertions can inspect the same state the code wrote.
vi.mock('../redis', async () => {
  const { RedisFake } = await import('./redis-fake');
  return { default: new RedisFake() };
});

const redis = (await import('../redis')).default as unknown as import('./redis-fake').RedisFake;
const queue = await import('../queue');

const job = (over: Partial<Job> = {}): Job => ({
  job_id: 'job-1',
  channel: 'email',
  priority: 'other',
  to: 'someone@example.com',
  template_id: 'welcome',
  variables: {},
  ...over,
});

beforeEach(() => {
  redis.lists.clear();
  redis.zsets.clear();
  redis.strings.clear();
});

describe('priority queues', () => {
  it('round-trips a realtime job and returns ioredis brpop shape', async () => {
    await queue.pushRealtime(job({ job_id: 'rt-1', priority: 'realtime' }));

    const popped = await queue.popRealtime();

    expect(popped).not.toBeNull();
    expect(popped![0]).toBe('queue:realtime');
    expect(JSON.parse(popped![1]).job_id).toBe('rt-1');
  });

  it('is FIFO — the first job pushed is the first popped', async () => {
    await queue.pushOther(job({ job_id: 'first' }));
    await queue.pushOther(job({ job_id: 'second' }));

    const a = await queue.popOther();
    const b = await queue.popOther();

    expect(JSON.parse(a![1]).job_id).toBe('first');
    expect(JSON.parse(b![1]).job_id).toBe('second');
  });

  it('returns null on an empty queue rather than throwing', async () => {
    expect(await queue.popRealtime()).toBeNull();
    expect(await queue.popOther()).toBeNull();
  });

  it('keeps realtime and other queues separate', async () => {
    await queue.pushRealtime(job({ job_id: 'rt' }));

    expect(await queue.popOther()).toBeNull();
    expect(await queue.popRealtime()).not.toBeNull();
  });
});

describe('retry scheduling', () => {
  it('does not return a retry before its delay has elapsed', async () => {
    await queue.scheduleRetry(job({ job_id: 'later' }), 60);

    expect(await queue.popScheduledRetries()).toEqual([]);
    // still parked in the sorted set, not lost
    expect(await redis.zcard('queue:retry')).toBe(1);
  });

  it('returns a retry once due, and removes it', async () => {
    await queue.scheduleRetry(job({ job_id: 'due' }), -1);

    const due = await queue.popScheduledRetries();

    expect(due.map((j) => j.job_id)).toEqual(['due']);
    expect(await redis.zcard('queue:retry')).toBe(0);
  });

  it('returns only the due subset and leaves future retries parked', async () => {
    await queue.scheduleRetry(job({ job_id: 'due' }), -1);
    await queue.scheduleRetry(job({ job_id: 'not-yet' }), 300);

    const due = await queue.popScheduledRetries();

    expect(due.map((j) => j.job_id)).toEqual(['due']);
    expect(await redis.zcard('queue:retry')).toBe(1);
  });
});

describe('dead-letter queue and manual retry', () => {
  it('retries a specific job by id and resets it for a fresh attempt', async () => {
    await queue.pushDLQ(job({ job_id: 'dead-1', attempt: 5, next_attempt_at: 123 }));

    const res = await queue.retryFailedJobs({ jobId: 'dead-1', priority: 'realtime' });

    expect(res).toEqual({ retried: ['dead-1'], skipped: [], not_found: [] });
    expect(await redis.llen('queue:dlq')).toBe(0);

    const requeued = JSON.parse((await queue.popRealtime())![1]);
    expect(requeued.attempt).toBe(0);
    expect(requeued.priority).toBe('realtime');
    expect(requeued.next_attempt_at).toBeUndefined();
  });

  it('reports not_found for an id that is not in the DLQ, without touching it', async () => {
    await queue.pushDLQ(job({ job_id: 'dead-1' }));

    const res = await queue.retryFailedJobs({ jobId: 'nope' });

    expect(res.not_found).toEqual(['nope']);
    expect(res.retried).toEqual([]);
    expect(await redis.llen('queue:dlq')).toBe(1);
  });

  it('drains up to `limit` jobs when no id is given', async () => {
    await queue.pushDLQ(job({ job_id: 'd1' }));
    await queue.pushDLQ(job({ job_id: 'd2' }));
    await queue.pushDLQ(job({ job_id: 'd3' }));

    const res = await queue.retryFailedJobs({ limit: 2 });

    expect(res.retried).toHaveLength(2);
    expect(await redis.llen('queue:dlq')).toBe(1);
  });

  it('stops cleanly when the DLQ runs dry before the limit', async () => {
    await queue.pushDLQ(job({ job_id: 'only' }));

    const res = await queue.retryFailedJobs({ limit: 10 });

    expect(res.retried).toEqual(['only']);
    expect(await redis.llen('queue:dlq')).toBe(0);
  });

  it('records unparseable DLQ entries as skipped instead of crashing the drain', async () => {
    await redis.lpush('queue:dlq', 'not-json');

    const res = await queue.retryFailedJobs({ limit: 1 });

    expect(res.retried).toEqual([]);
    expect(res.skipped).toEqual(['not-json']);
  });
});

describe('getQueueMetrics', () => {
  it('counts each queue', async () => {
    await queue.pushRealtime(job({ job_id: 'rt' }));
    await queue.pushOther(job({ job_id: 'o1' }));
    await queue.pushOther(job({ job_id: 'o2' }));
    await queue.pushDLQ(job({ job_id: 'd' }));
    await queue.scheduleRetry(job({ job_id: 'r' }), 30);

    const m = await queue.getQueueMetrics();

    expect(m.realtime).toBe(1);
    expect(m.other).toBe(2);
    expect(m.dlq).toBe(1);
    expect(m.retry_count).toBe(1);
  });

  it('reports the oldest retry as an epoch-milliseconds timestamp', async () => {
    const before = Date.now();
    await queue.scheduleRetry(job({ job_id: 'r' }), 30);

    const m = await queue.getQueueMetrics();

    expect(m.retry_oldest).toBeGreaterThanOrEqual(before + 30_000);
    expect(m.retry_oldest).toBeLessThan(before + 31_000);
  });

  it('reports retry_eta_seconds in SECONDS, matching its name', async () => {
    await queue.scheduleRetry(job({ job_id: 'r' }), 30);

    const m = await queue.getQueueMetrics();

    // Regression guard: this previously returned `score - now` in milliseconds
    // (~30000) from a field named *_seconds.
    expect(m.retry_eta_seconds).toBeGreaterThan(28);
    expect(m.retry_eta_seconds).toBeLessThanOrEqual(30);
  });

  it('clamps a past-due retry eta to zero rather than going negative', async () => {
    await queue.scheduleRetry(job({ job_id: 'overdue' }), -120);

    const m = await queue.getQueueMetrics();

    expect(m.retry_eta_seconds).toBe(0);
  });

  it('returns nulls for the retry eta when nothing is scheduled', async () => {
    const m = await queue.getQueueMetrics();

    expect(m.retry_count).toBe(0);
    expect(m.retry_oldest).toBeNull();
    expect(m.retry_eta_seconds).toBeNull();
  });
});
