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
const { toAcceptedRecord } = await import('../audit/redact');

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

    expect(res).toEqual({ retried: ['dead-1'], skipped: [], refused: [], not_found: [] });
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
    expect(m.bulk).toBe(0);
  });

  it('counts the bulk queue separately', async () => {
    await queue.pushToPriority(job({ job_id: 'b1', priority: 'bulk' }));
    await queue.pushToPriority(job({ job_id: 'b2', priority: 'bulk' }));
    await queue.pushOther(job({ job_id: 'o1' }));

    const m = await queue.getQueueMetrics();

    expect(m.bulk).toBe(2);
    expect(m.other).toBe(1);
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

describe('scheduleRetryWithMarker', () => {
  const marker = { key: 'ns:attempt:a1', value: 'retry:2', ttlSeconds: 604800 };

  it('issues the retry ZADD and the marker SET in one MULTI', async () => {
    const multi = vi.spyOn(redis, 'multi');
    const zadd = vi.spyOn(redis, 'zadd');
    try {
      await queue.scheduleRetryWithMarker(job({ job_id: 'r1' }), 10, marker);
      expect(multi).toHaveBeenCalledTimes(1);
      expect(zadd).toHaveBeenCalledTimes(1); // via the MULTI, not a separate call
    } finally {
      multi.mockRestore();
      zadd.mockRestore();
    }
    expect(await redis.zcard('queue:retry')).toBe(1);
    expect(await redis.get('ns:attempt:a1')).toBe('retry:2');
  });

  it('leaves neither the retry nor the marker when the MULTI fails', async () => {
    const multi = vi.spyOn(redis, 'multi').mockImplementationOnce(() => {
      const chain = {
        zadd: () => chain,
        set: () => chain,
        exec: async () => { throw new Error('connection lost'); },
      };
      return chain as never;
    });
    try {
      await expect(queue.scheduleRetryWithMarker(job({ job_id: 'r2' }), 10, marker)).rejects.toThrow('connection lost');
    } finally {
      multi.mockRestore();
    }
    expect(await redis.get('ns:attempt:a1')).toBeNull();
    expect(await redis.zcard('queue:retry')).toBe(0);
  });

  it('schedules without a marker when the job has no audit ids', async () => {
    await queue.scheduleRetryWithMarker(job({ job_id: 'r3' }), 10, undefined);
    expect(await redis.zcard('queue:retry')).toBe(1);
    expect(redis.strings.size).toBe(0);
  });
});

describe('pushManyToPriority', () => {
  it('pushes each job to its own priority queue, in order', async () => {
    await queue.pushManyToPriority([
      job({ job_id: 'm1', priority: 'other' }),
      job({ job_id: 'b1', priority: 'bulk' }),
      job({ job_id: 'r1', priority: 'realtime' }),
      job({ job_id: 'm2', priority: 'other' }),
    ]);
    const popped = [await queue.popOther(), await queue.popOther()].map((p) => JSON.parse(p![1]).job_id);
    expect(popped).toEqual(['m1', 'm2']);
    expect(JSON.parse((await redis.rpop('queue:bulk'))!).job_id).toBe('b1');
    expect(JSON.parse((await redis.rpop('queue:realtime'))!).job_id).toBe('r1');
  });

  it('sends an unknown or inherited priority name to other', async () => {
    await queue.pushManyToPriority([
      job({ job_id: 'u1', priority: 'nope' as never }),
      job({ job_id: 'u2', priority: 'toString' as never }),
    ]);
    expect(await redis.llen('queue:other')).toBe(2);
  });

  it('is a no-op for an empty batch', async () => {
    await queue.pushManyToPriority([]);
    expect(await redis.llen('queue:other')).toBe(0);
  });
});

describe('retryFailedJobs replay accounting', () => {
  it('increments replays and refuses past MAX_REPLAYS', async () => {
    await queue.pushDLQ(job({ job_id: 'p', replays: queue.MAX_REPLAYS }));
    const res = await queue.retryFailedJobs({ jobId: 'p' });
    expect(res.refused).toEqual(['p']);
    expect(res.retried).toEqual([]);
    // Still in the DLQ, not lost.
    expect(await redis.lrange('queue:dlq', 0, -1)).toHaveLength(1);
  });

  it('a replayed job carries replays + 1', async () => {
    await queue.pushDLQ(job({ job_id: 'q', replays: 1 }));
    await queue.retryFailedJobs({ jobId: 'q' });
    const [raw] = await redis.lrange('queue:other', 0, -1);
    expect(JSON.parse(raw).replays).toBe(2);
  });

  it('skips a capped job at the tail and retries the jobs behind it', async () => {
    // Oldest (tail) first: the capped entry must not block the drain.
    await queue.pushDLQ(job({ job_id: 'capped', replays: queue.MAX_REPLAYS }));
    await queue.pushDLQ(job({ job_id: 'f1' }));
    await queue.pushDLQ(job({ job_id: 'f2' }));
    await queue.pushDLQ(job({ job_id: 'f3' }));
    const res = await queue.retryFailedJobs({ limit: 2 });
    expect(res.retried).toEqual(['f1', 'f2']);
    expect(res.refused).toEqual(['capped']);
    const left = (await redis.lrange('queue:dlq', 0, -1)).map((r) => JSON.parse(r).job_id);
    expect(left).toEqual(['f3', 'capped']);
  });

  it('does not requeue a job another drain removed between read and claim', async () => {
    await queue.pushDLQ(job({ job_id: 'gone' }));
    await queue.pushDLQ(job({ job_id: 'kept' }));
    const realLrem = redis.lrem.bind(redis);
    redis.lrem = async (key, count, value) =>
      JSON.parse(value).job_id === 'gone' ? 0 : realLrem(key, count, value);
    try {
      const res = await queue.retryFailedJobs({ limit: 2 });
      expect(res.retried).toEqual(['kept']);
      expect(res.skipped).toEqual([]);
      const requeued = (await redis.lrange('queue:other', 0, -1)).map((r) => JSON.parse(r).job_id);
      expect(requeued).toEqual(['kept']);
    } finally {
      redis.lrem = realLrem;
    }
  });

  it('records a replay as a new delivery attempt, keeping the event identity', async () => {
    const audit = {
      eventId: 'ev-1',
      attemptId: 'attempt-1',
      createdAt: '2026-10-04T00:00:00.000Z',
      correlationId: 'corr-1',
    };
    await queue.pushDLQ(job({ job_id: 'a', audit } as Partial<Job>));
    await queue.retryFailedJobs({ jobId: 'a' });
    const [raw] = await redis.lrange('queue:other', 0, -1);
    const replayed = JSON.parse(raw);
    expect(replayed.audit.attemptId).not.toBe('attempt-1');
    expect(replayed.audit.attemptId).toEqual(expect.any(String));
    expect(replayed.audit.eventId).toBe('ev-1');
    expect(replayed.audit.createdAt).toBe(audit.createdAt);
    expect(replayed.audit.correlationId).toBe('corr-1');
  });

  it('replays a job without audit without adding one', async () => {
    await queue.pushDLQ(job({ job_id: 'n' }));
    await queue.retryFailedJobs({ jobId: 'n' });
    const [raw] = await redis.lrange('queue:other', 0, -1);
    expect(JSON.parse(raw).audit).toBeUndefined();
  });

  it('a realtime-origin OTP replayed as other persists no variable values and no job copy', async () => {
    const audit = {
      eventId: 'ev-2', attemptId: 'attempt-2', createdAt: '2026-10-04T00:00:00.000Z',
      correlationId: 'corr-2', redactValues: true,
    };
    await queue.pushDLQ(job({
      job_id: 'otp', channel: 'sms', priority: 'realtime', template_id: 'login_otp',
      variables: { message: '739104' }, audit,
    }));
    // Default replay priority is 'other'.
    await queue.retryFailedJobs({ jobId: 'otp' });
    const [raw] = await redis.lrange('queue:other', 0, -1);
    const replayed = JSON.parse(raw) as Job;
    expect(replayed.priority).toBe('other');
    const rec = toAcceptedRecord(replayed, 'worker');
    expect(JSON.stringify(rec)).not.toContain('739104');
    expect(rec.job).toBeUndefined();
    expect(rec.recoverable).toBe(false);
  });
});

describe('serializeJob (well-formed payloads)', () => {
  it('replaces lone surrogates in values and keys with U+FFFD', () => {
    const out = queue.serializeJob(
      job({ variables: { name: 'Asha \ud83d', ['k\udc00']: 'ok', nested: ['\ud800x'] } as never }),
    );
    expect(out).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
    const parsed = JSON.parse(out);
    expect(parsed.variables.name).toBe('Asha �');
    expect(parsed.variables['k�']).toBe('ok');
    expect(parsed.variables.nested).toEqual(['�x']);
  });

  it('keeps valid surrogate pairs and everything else unchanged', () => {
    const j = job({ variables: { name: 'Asha 😀', n: 3, b: true, z: null } as never, attempt: 2 });
    expect(JSON.parse(queue.serializeJob(j))).toEqual(JSON.parse(JSON.stringify(j)));
  });

  it('drops undefined fields like JSON.stringify', () => {
    expect(JSON.parse(queue.serializeJob(job({ next_attempt_at: undefined })))).not.toHaveProperty('next_attempt_at');
  });

  it('every push path writes the sanitized form', async () => {
    const j = job({ variables: { name: 'x\ud83d' } as never });
    await queue.pushToPriority(j);
    await queue.deferJob(j, 0);
    await queue.scheduleRetry({ ...j, job_id: 'job-3' }, 0);
    await queue.scheduleRetryWithMarker({ ...j, job_id: 'job-2' }, 0);
    await queue.pushManyToPriority([j]);
    await queue.pushDLQ(j);
    const all = [
      ...(redis.lists.get('queue:other') ?? []),
      ...(redis.lists.get('queue:dlq') ?? []),
      ...(redis.zsets.get('queue:retry') ?? []).map((e) => e.member),
    ];
    expect(all).toHaveLength(6);
    for (const raw of all) expect(raw).not.toMatch(/\\ud83d/i);
  });
});
