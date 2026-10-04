import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const pushed: unknown[] = [];
// The real push runs (so tests can read the priority queues), recorded on the way.
vi.mock('../../queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../queue')>();
  return {
    ...actual,
    pushManyToPriority: vi.fn(async (jobs: Parameters<typeof actual.pushManyToPriority>[0]) => {
      pushed.push(...jobs);
      await actual.pushManyToPriority(jobs);
    }),
  };
});

import redis from '../../redis';
import { pushManyToPriority, QUEUE_KEYS } from '../../queue';
import { closeDb, getPool } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { recordAccepted, recordAcceptedMany, upsertAttempt, type AcceptedRecord } from '../store';
import { toAcceptedRecord } from '../redact';
import type { Job } from 'src/types';
import { ABANDONED_ERROR, recoverLostJobs, REDIS_EPOCH_KEY, REDIS_RECOVERY_LOCK_KEY } from '../recover';
import { attemptMarkerKey } from '../marker';

beforeAll(async () => { await runMigrations(); });
afterAll(async () => { await closeDb(); redis.disconnect(); });
beforeEach(async () => {
  pushed.length = 0;
  vi.mocked(pushManyToPriority).mockClear();
  await redis.del(REDIS_RECOVERY_LOCK_KEY, ...Object.values(QUEUE_KEYS));
  await getPool().query(`DELETE FROM delivery_attempt; DELETE FROM notification_event;`);
});

function rec(priority: 'realtime' | 'other' | 'bulk', createdAt = new Date()): AcceptedRecord {
  const jobId = randomUUID();
  const recoverable = priority !== 'realtime';
  return {
    ids: { eventId: randomUUID(), attemptId: randomUUID(), createdAt: createdAt.toISOString(), correlationId: jobId },
    network: 'n', source: 's', priority, channel: 'email', templateId: 't',
    payload: {}, recoverable,
    job: recoverable ? { job_id: jobId, channel: 'email', priority, to: 'x', template_id: 't', variables: {} } : undefined,
  };
}

/** Make a row look like it was written long before Redis started. */
async function backdate(r: AcceptedRecord, interval = '365 days') {
  await getPool().query(`UPDATE delivery_attempt SET updated_at = now() - $2::interval WHERE id = $1`, [r.ids.attemptId, interval]);
}

describe('recoverLostJobs', () => {
  it('requeues when the epoch is missing, exactly once', async () => {
    const r = rec('other');
    await recordAccepted(r);
    await backdate(r);
    await redis.del(REDIS_EPOCH_KEY);

    const [a, b] = await Promise.all([recoverLostJobs(), recoverLostJobs()]);
    expect(a.requeued + b.requeued).toBe(1);
    expect(pushed).toHaveLength(1);
    expect(await redis.get(REDIS_EPOCH_KEY)).not.toBeNull();
  });

  it('requeues each job onto its own priority queue', async () => {
    const other = rec('other');
    const bulk = rec('bulk');
    for (const r of [other, bulk]) {
      await recordAccepted(r);
      await backdate(r);
    }
    await redis.del(REDIS_EPOCH_KEY);

    expect((await recoverLostJobs()).requeued).toBe(2);
    const ids = async (key: string) => (await redis.lrange(key, 0, -1)).map((raw) => JSON.parse(raw).job_id);
    expect(await ids(QUEUE_KEYS.other)).toEqual([other.job!.job_id]);
    expect(await ids(QUEUE_KEYS.bulk)).toEqual([bulk.job!.job_id]);
    expect(await redis.llen(QUEUE_KEYS.realtime)).toBe(0);
  });

  it('does nothing when the epoch is present and nothing is stale', async () => {
    await recordAccepted(rec('other'));
    await redis.set(REDIS_EPOCH_KEY, 'x');
    expect(await recoverLostJobs()).toMatchObject({ epochLost: false, requeued: 0 });
  });

  it('does not requeue realtime', async () => {
    await recordAccepted(rec('realtime'));
    await redis.del(REDIS_EPOCH_KEY);
    expect((await recoverLostJobs()).requeued).toBe(0);
  });

  it('requeues an attempt stuck in dispatching past the threshold', async () => {
    const r = rec('other');
    await recordAccepted(r);
    await upsertAttempt(r, { status: 'dispatching', attemptNo: 1 });
    await getPool().query(`UPDATE delivery_attempt SET updated_at = now() - interval '1 hour' WHERE id = $1`, [r.ids.attemptId]);
    await redis.set(REDIS_EPOCH_KEY, 'x');
    expect((await recoverLostJobs({ staleDispatchMs: 60_000 })).requeued).toBe(1);
  });

  it('does not requeue recoverable=false even with a job', async () => {
    const r = { ...rec('other'), recoverable: false };
    await recordAccepted(r);
    await backdate(r);
    await redis.del(REDIS_EPOCH_KEY);
    expect((await recoverLostJobs()).requeued).toBe(0);
    expect(pushed).toHaveLength(0);
  });

  it('on epoch loss skips rows touched after Redis started', async () => {
    const r = rec('other');
    await recordAccepted(r); // updated_at = now, newer than Redis start
    await redis.del(REDIS_EPOCH_KEY);
    expect(await recoverLostJobs()).toMatchObject({ epochLost: true, requeued: 0 });
    expect(await redis.get(REDIS_EPOCH_KEY)).not.toBeNull();
  });

  it('stamps attempt_no + 1 and pushes attempt = bumped attempt_no - 1', async () => {
    const r = rec('other');
    await recordAccepted(r);
    await upsertAttempt(r, { status: 'dispatching', attemptNo: 2 });
    await backdate(r, '1 hour');
    await redis.set(REDIS_EPOCH_KEY, 'x');
    await recoverLostJobs({ staleDispatchMs: 60_000 });
    const { rows } = await getPool().query(`SELECT attempt_no, status FROM delivery_attempt WHERE id = $1`, [r.ids.attemptId]);
    expect(rows[0]).toMatchObject({ attempt_no: 3, status: 'queued' });
    expect((pushed[0] as { attempt: number }).attempt).toBe(2);
  });

  it('rolls back when a push fails; the next call requeues', async () => {
    const r = rec('other');
    await recordAccepted(r);
    await upsertAttempt(r, { status: 'dispatching', attemptNo: 1 });
    await backdate(r, '1 hour');
    await redis.set(REDIS_EPOCH_KEY, 'x');
    vi.mocked(pushManyToPriority).mockRejectedValueOnce(new Error('redis down'));
    await expect(recoverLostJobs({ staleDispatchMs: 60_000 })).rejects.toThrow('redis down');
    const { rows } = await getPool().query(`SELECT attempt_no, status FROM delivery_attempt WHERE id = $1`, [r.ids.attemptId]);
    expect(rows[0]).toMatchObject({ attempt_no: 1, status: 'dispatching' });
    expect(await redis.get(REDIS_RECOVERY_LOCK_KEY)).toBeNull();
    expect((await recoverLostJobs({ staleDispatchMs: 60_000 })).requeued).toBe(1);
  });

  it('leaves the epoch unset when the re-queue fails', async () => {
    const r = rec('other');
    await recordAccepted(r);
    await backdate(r);
    await redis.del(REDIS_EPOCH_KEY);
    vi.mocked(pushManyToPriority).mockRejectedValueOnce(new Error('redis down'));
    await expect(recoverLostJobs()).rejects.toThrow();
    expect(await redis.get(REDIS_EPOCH_KEY)).toBeNull();
    expect(await recoverLostJobs()).toMatchObject({ epochLost: true, requeued: 1 });
  });

  /** A row stuck in `dispatching` at attempt `attemptNo`, past the stale threshold. */
  async function staleDispatching(attemptNo = 1, createdAt = new Date()) {
    const r = rec('other', createdAt);
    await recordAccepted(r);
    await upsertAttempt(r, { status: 'dispatching', attemptNo });
    await backdate(r, '1 hour');
    return r;
  }
  const row = async (r: AcceptedRecord) =>
    (await getPool().query(`SELECT attempt_no, status, error, completed_at FROM delivery_attempt WHERE id = $1`, [r.ids.attemptId])).rows[0];
  const event = async (r: AcceptedRecord) =>
    (await getPool().query(`SELECT status FROM notification_event WHERE id = $1`, [r.ids.eventId])).rows[0];

  describe('attempt markers', () => {
    beforeEach(async () => { await redis.set(REDIS_EPOCH_KEY, 'x'); });

    it('marks a stale dispatching row sent when its marker says sent, and does not push it', async () => {
      const r = await staleDispatching(1);
      await redis.set(attemptMarkerKey(r.ids.attemptId), 'sent:1', 'EX', 60);
      expect(await recoverLostJobs({ staleDispatchMs: 60_000 })).toMatchObject({ requeued: 0, marked: 1 });
      expect(pushed).toHaveLength(0);
      expect(await row(r)).toMatchObject({ status: 'sent', attempt_no: 1 });
      expect(await event(r)).toMatchObject({ status: 'sent' });
    });

    it('marks a stale dispatching row failed when its marker says failed', async () => {
      const r = await staleDispatching(2);
      await redis.set(attemptMarkerKey(r.ids.attemptId), 'failed:2', 'EX', 60);
      expect(await recoverLostJobs({ staleDispatchMs: 60_000 })).toMatchObject({ requeued: 0, marked: 1 });
      expect(pushed).toHaveLength(0);
      expect(await row(r)).toMatchObject({ status: 'failed', attempt_no: 2 });
      expect((await row(r)).completed_at).not.toBeNull();
      expect(await event(r)).toMatchObject({ status: 'failed' });
    });

    it('leaves a stale dispatching row alone when its marker says retry (job is in the retry set)', async () => {
      const r = await staleDispatching(1);
      await redis.set(attemptMarkerKey(r.ids.attemptId), 'retry:2', 'EX', 60);
      expect(await recoverLostJobs({ staleDispatchMs: 60_000 })).toMatchObject({ requeued: 0, marked: 0 });
      expect(pushed).toHaveLength(0);
      expect(await row(r)).toMatchObject({ status: 'dispatching', attempt_no: 1 });
    });

    it('pushes a stale dispatching row with no marker', async () => {
      const r = await staleDispatching(1);
      expect(await recoverLostJobs({ staleDispatchMs: 60_000 })).toMatchObject({ requeued: 1, marked: 0 });
      expect(pushed).toHaveLength(1);
      expect(await row(r)).toMatchObject({ status: 'queued', attempt_no: 2 });
    });

    it('ignores a retry marker left by an earlier attempt when a later attempt crashed', async () => {
      // retry:2 was written by attempt 1; attempt 2 then stamped dispatching and died.
      const r = await staleDispatching(2);
      await redis.set(attemptMarkerKey(r.ids.attemptId), 'retry:2', 'EX', 60);
      expect(await recoverLostJobs({ staleDispatchMs: 60_000 })).toMatchObject({ requeued: 1 });
      expect(pushed).toHaveLength(1);
    });
  });

  describe('recovery window (RECOVERY_MAX_AGE_HOURS)', () => {
    const abandonedCount = async () => Number((await redis.hget('metrics:counters', 'ns_recovery_abandoned_total')) ?? 0);

    it('abandons a stale row older than the window instead of re-sending it, and counts it', async () => {
      await redis.set(REDIS_EPOCH_KEY, 'x');
      const before = await abandonedCount();
      const old = await staleDispatching(1, new Date(Date.now() - 48 * 3600_000));
      const fresh = await staleDispatching(1);
      expect(await recoverLostJobs({ staleDispatchMs: 60_000, maxAgeHours: 24 })).toMatchObject({ requeued: 1, abandoned: 1 });
      expect(pushed).toHaveLength(1);
      expect((pushed[0] as { job_id: string }).job_id).toBe((fresh.job as { job_id: string }).job_id);
      expect(await row(old)).toMatchObject({ status: 'failed', error: ABANDONED_ERROR });
      expect(await event(old)).toMatchObject({ status: 'failed' });
      expect(await abandonedCount()).toBe(before + 1);
    });

    it('abandons old rows on the epoch-lost path too', async () => {
      const old = rec('other', new Date(Date.now() - 48 * 3600_000));
      await recordAccepted(old);
      await backdate(old);
      await redis.del(REDIS_EPOCH_KEY);
      expect(await recoverLostJobs({ maxAgeHours: 24 })).toMatchObject({ epochLost: true, requeued: 0, abandoned: 1 });
      expect(pushed).toHaveLength(0);
      expect(await row(old)).toMatchObject({ status: 'failed', error: ABANDONED_ERROR });
    });

    it('reads the window from RECOVERY_MAX_AGE_HOURS', async () => {
      await redis.set(REDIS_EPOCH_KEY, 'x');
      const r = await staleDispatching(1, new Date(Date.now() - 3 * 3600_000));
      process.env.RECOVERY_MAX_AGE_HOURS = '2';
      try {
        expect(await recoverLostJobs({ staleDispatchMs: 60_000 })).toMatchObject({ abandoned: 1, requeued: 0 });
      } finally {
        delete process.env.RECOVERY_MAX_AGE_HOURS;
      }
      expect(await row(r)).toMatchObject({ status: 'failed' });
    });
  });

  describe('batching', () => {
    it('recovers more than one batch of rows, one push per batch', async () => {
      await redis.set(REDIS_EPOCH_KEY, 'x');
      await getPool().query(
        `INSERT INTO delivery_attempt
           (id, created_at, updated_at, notification_event_id, channel, template_id, attempt_no,
            status, status_rank, recoverable, job)
         SELECT gen_random_uuid(), now() - interval '2 hours', now() - interval '1 hour', gen_random_uuid(),
                'email', 't', 1, 'dispatching', 1, true,
                jsonb_build_object('job_id', 'bulk-' || g, 'channel', 'email', 'priority', 'other',
                                   'to', 'x', 'template_id', 't', 'variables', '{}'::jsonb)
           FROM generate_series(1, 1201) g`,
      );
      const res = await recoverLostJobs({ staleDispatchMs: 60_000 });
      expect(res.requeued).toBe(1201);
      expect(pushed).toHaveLength(1201);
      expect(new Set(pushed.map((j) => (j as { job_id: string }).job_id)).size).toBe(1201);
      expect(vi.mocked(pushManyToPriority)).toHaveBeenCalledTimes(3);
      const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM delivery_attempt WHERE status = 'queued'`);
      expect(rows[0].n).toBe(1201);
    });

    it('fixes the epoch-lost cutoff once: rows written by live traffic mid-run are not re-queued', async () => {
      // Uptime 0 puts the Redis start at "now", so a per-batch now() cutoff
      // would sweep up any row written while the run is in progress.
      const info = vi.spyOn(redis, 'info').mockResolvedValue('uptime_in_seconds:0\r\n' as never);
      const old = [rec('other'), rec('other')];
      for (const r of old) { await recordAccepted(r); await backdate(r); }
      await redis.del(REDIS_EPOCH_KEY);
      const live = rec('other', new Date(Date.now() + 60_000)); // sorts after the cursor
      vi.mocked(pushManyToPriority).mockImplementationOnce(async (jobs) => {
        pushed.push(...jobs);
        await recordAccepted(live); // committed between batch 1 and batch 2
        await new Promise((r) => setTimeout(r, 20));
      });
      try {
        expect(await recoverLostJobs({ batchSize: 1 })).toMatchObject({ epochLost: true, requeued: 2 });
      } finally {
        info.mockRestore();
      }
      const ids = pushed.map((j) => (j as { job_id: string }).job_id);
      expect(ids).not.toContain((live.job as { job_id: string }).job_id);
      expect(await row(live)).toMatchObject({ status: 'queued', attempt_no: 1 });
    });

    it('a failure in a later batch keeps earlier batches committed and leaves the epoch unset', async () => {
      for (let i = 0; i < 3; i++) {
        const r = rec('other');
        await recordAccepted(r);
        await backdate(r);
      }
      await redis.del(REDIS_EPOCH_KEY);
      vi.mocked(pushManyToPriority)
        .mockImplementationOnce(async (jobs) => { pushed.push(...jobs); })
        .mockRejectedValueOnce(new Error('redis down'));
      await expect(recoverLostJobs({ batchSize: 2 })).rejects.toThrow('redis down');
      expect(await redis.get(REDIS_EPOCH_KEY)).toBeNull();
      const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM delivery_attempt WHERE status = 'queued' AND attempt_no = 2`);
      expect(rows[0].n).toBe(2);
      // The committed rows are newer than Redis now, so the retry picks up only the third.
      expect(await recoverLostJobs({ batchSize: 2 })).toMatchObject({ epochLost: true, requeued: 1 });
    });
  });

  describe('Send API v1 jobs', () => {
    function v1BulkJob(redactValues: boolean): Job {
      const createdAt = new Date().toISOString();
      const delivery = {
        channel: 'email', to: 'a@b.co', templateKey: 'digest', provider: 'smtp', providerTemplateId: null,
        rendered: { subject: 's', html: '<p>h</p>' },
        dlt: { senderId: null, dltEntityId: null, dltHeaderId: null, dltTagId: null },
      } as unknown as NonNullable<Job['v1']>['deliveries'][number];
      return {
        job_id: randomUUID(), channel: 'email', priority: 'bulk', to: 'a@b.co', template_id: 'digest',
        variables: redactValues ? {} : { name: 'A' },
        v1: { mode: 'single', deliveries: [delivery], index: 0 },
        audit: {
          eventId: randomUUID(), attemptId: randomUUID(), createdAt, correlationId: 'c',
          deliveryMode: 'single', redactValues, variableNames: ['name'],
        },
      };
    }

    it('re-queues a recoverable bulk v1 job copy onto queue:bulk, intact', async () => {
      const job = v1BulkJob(false);
      const r = toAcceptedRecord(job, 'api');
      await recordAccepted(r);
      await backdate(r);
      await redis.del(REDIS_EPOCH_KEY);
      expect(await recoverLostJobs()).toMatchObject({ epochLost: true, requeued: 1 });
      const bulk = (await redis.lrange(QUEUE_KEYS.bulk, 0, -1)).map((raw) => JSON.parse(raw) as Job);
      expect(bulk).toHaveLength(1);
      expect(bulk[0]).toMatchObject({ job_id: job.job_id, priority: 'bulk', v1: job.v1, audit: job.audit });
      expect(await redis.llen(QUEUE_KEYS.other)).toBe(0);
      expect(await redis.llen(QUEUE_KEYS.realtime)).toBe(0);
    });

    it('never re-queues a redacted v1 job (no job copy, not recoverable)', async () => {
      const r = toAcceptedRecord(v1BulkJob(true), 'api');
      expect(r).toMatchObject({ job: undefined, recoverable: false });
      await recordAccepted(r);
      await upsertAttempt(r, { status: 'dispatching', attemptNo: 1 });
      await backdate(r);
      await redis.del(REDIS_EPOCH_KEY);
      expect(await recoverLostJobs({ staleDispatchMs: 60_000 })).toMatchObject({ requeued: 0, marked: 0, abandoned: 0 });
      expect(pushed).toHaveLength(0);
      for (const key of Object.values(QUEUE_KEYS)) expect(await redis.llen(key)).toBe(0);
    });
  });

  describe('multi-attempt events roll up (never overwritten by the stamped attempt)', () => {
    beforeEach(async () => { await redis.set(REDIS_EPOCH_KEY, 'x'); });

    function siblings(mode: 'first_available' | 'all', createdAt = new Date()): [AcceptedRecord, AcceptedRecord] {
      const base = rec('other', createdAt);
      const a1: AcceptedRecord = { ...base, ids: { ...base.ids, deliveryMode: mode } };
      const b = rec('other', createdAt);
      const a2: AcceptedRecord = { ...b, ids: { ...a1.ids, attemptId: b.ids.attemptId } };
      return [a1, a2];
    }

    it('first_available: a stale earlier attempt stamped failed from its marker leaves a sent event sent', async () => {
      const [a1, a2] = siblings('first_available');
      await recordAcceptedMany([a1]);
      await upsertAttempt(a1, { status: 'dispatching', attemptNo: 1 });
      // a1 failed and fell through; its `failed` stamp was lost, its marker was not.
      await redis.set(attemptMarkerKey(a1.ids.attemptId), 'failed:1', 'EX', 60);
      for (const status of ['queued', 'dispatching', 'sent'] as const) await upsertAttempt(a2, { status, attemptNo: 1 });
      expect(await event(a1)).toMatchObject({ status: 'sent' });
      await backdate(a1, '1 hour');

      expect(await recoverLostJobs({ staleDispatchMs: 60_000 })).toMatchObject({ marked: 1, requeued: 0 });
      expect(await row(a1)).toMatchObject({ status: 'failed' });
      expect(await event(a1)).toMatchObject({ status: 'sent' });
    });

    it('first_available: a stale earlier attempt stamped failed leaves the event on the open later attempt', async () => {
      const [a1, a2] = siblings('first_available');
      await recordAcceptedMany([a1]);
      await upsertAttempt(a1, { status: 'dispatching', attemptNo: 1 });
      await redis.set(attemptMarkerKey(a1.ids.attemptId), 'failed:1', 'EX', 60);
      await upsertAttempt(a2, { status: 'queued', attemptNo: 1 });
      await backdate(a1, '1 hour');

      expect(await recoverLostJobs({ staleDispatchMs: 60_000 })).toMatchObject({ marked: 1 });
      expect(await event(a1)).toMatchObject({ status: 'accepted' }); // a2 is queued
    });

    it('all: recovery stamping one attempt still rolls the event up across attempts', async () => {
      const [a1, a2] = siblings('all');
      await recordAcceptedMany([a1, a2]);
      await upsertAttempt(a1, { status: 'sent', attemptNo: 1 });
      await upsertAttempt(a2, { status: 'dispatching', attemptNo: 1 });
      await redis.set(attemptMarkerKey(a2.ids.attemptId), 'failed:1', 'EX', 60);
      await backdate(a2, '1 hour');

      expect(await recoverLostJobs({ staleDispatchMs: 60_000 })).toMatchObject({ marked: 1 });
      expect(await row(a2)).toMatchObject({ status: 'failed' });
      expect(await event(a1)).toMatchObject({ status: 'partially_delivered' });
    });

    it('all: an abandoned attempt rolls up too', async () => {
      const [a1, a2] = siblings('all', new Date(Date.now() - 48 * 3600_000));
      await recordAcceptedMany([a1, a2]);
      await upsertAttempt(a1, { status: 'sent', attemptNo: 1 });
      await upsertAttempt(a2, { status: 'dispatching', attemptNo: 1 });
      await backdate(a2, '1 hour');

      expect(await recoverLostJobs({ staleDispatchMs: 60_000, maxAgeHours: 24 })).toMatchObject({ abandoned: 1 });
      expect(await row(a2)).toMatchObject({ status: 'failed', error: ABANDONED_ERROR });
      expect(await event(a1)).toMatchObject({ status: 'partially_delivered' });
    });

    it('an expired marker stamps the attempt and a single event expired', async () => {
      const r = await staleDispatching(1);
      await redis.set(attemptMarkerKey(r.ids.attemptId), 'expired:1', 'EX', 60);
      expect(await recoverLostJobs({ staleDispatchMs: 60_000 })).toMatchObject({ marked: 1, requeued: 0 });
      expect(pushed).toHaveLength(0);
      expect(await row(r)).toMatchObject({ status: 'expired', attempt_no: 1 });
      expect((await row(r)).completed_at).not.toBeNull();
      expect(await event(r)).toMatchObject({ status: 'expired' });
    });
  });
});
