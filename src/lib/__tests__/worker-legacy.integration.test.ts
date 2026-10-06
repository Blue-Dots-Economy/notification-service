import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A job queued by the removed legacy /notify can still reach the worker through
// recovery or a DLQ replay. Over real Postgres + Redis, both paths must end in
// the DLQ as legacy_job_shape, never at a vendor and never as a throw.
const sms = vi.hoisted(() => ({
  sendRendered: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock('../providers', () => ({
  providers: { sms: { name: 'sms', vendor: 'msg91', renders: 'provider', ...sms } },
}));

const redis = (await import('../redis')).default;
const { closeDb, getPool } = await import('../db/client');
const { runMigrations } = await import('../db/migrate');
const { recordAccepted, upsertAttempt } = await import('../audit/store');
const { toAcceptedRecord } = await import('../audit/redact');
const { recoverLostJobs, REDIS_EPOCH_KEY, REDIS_RECOVERY_LOCK_KEY } = await import('../audit/recover');
const { popFrom, QUEUE_KEYS, retryFailedJobs } = await import('../queue');
const { processJob } = await import('../worker');
import type { Job } from 'src/types';

const DLQ = 'queue:dlq';

function legacyJob(): Job {
  return {
    job_id: randomUUID(), channel: 'sms', priority: 'other', to: '+911234567890',
    template_id: 'login_otp', variables: { message: '1' },
    audit: { eventId: randomUUID(), attemptId: randomUUID(), createdAt: new Date().toISOString(), correlationId: 'c' },
  };
}

const dlqIds = async () => (await redis.lrange(DLQ, 0, -1)).map((raw) => JSON.parse(raw).job_id);

async function popAndProcess(): Promise<Job> {
  const conn = redis.duplicate();
  try {
    const job = await popFrom(conn, 'other', 1);
    expect(job).not.toBeNull();
    await expect(processJob(job!)).resolves.not.toThrow();
    return job!;
  } finally {
    conn.disconnect();
  }
}

beforeAll(async () => { await runMigrations(); });
afterAll(async () => { await closeDb(); redis.disconnect(); });
beforeEach(async () => {
  sms.sendRendered.mockClear();
  await redis.del(REDIS_RECOVERY_LOCK_KEY, ...Object.values(QUEUE_KEYS), 'queue:retry', DLQ);
  await redis.set(REDIS_EPOCH_KEY, 'x');
  await getPool().query(`DELETE FROM delivery_attempt; DELETE FROM notification_event;`);
});

describe('legacy-shaped jobs after the legacy path is gone', () => {
  it('a job recovered from a stale dispatching row is dead-lettered as legacy_job_shape', async () => {
    const job = legacyJob();
    const rec = toAcceptedRecord(job, 'test');
    await recordAccepted(rec);
    await upsertAttempt(rec, { status: 'dispatching', attemptNo: 1 });
    await getPool().query(`UPDATE delivery_attempt SET updated_at = now() - interval '1 hour' WHERE id = $1`, [job.audit!.attemptId]);

    expect((await recoverLostJobs({ staleDispatchMs: 60_000 })).requeued).toBe(1);
    await popAndProcess();
    expect(sms.sendRendered).not.toHaveBeenCalled();
    expect(await dlqIds()).toEqual([job.job_id]);
    // Recovery bumped the row to attempt 2; the guard closes that attempt.
    const { rows } = await getPool().query(
      `SELECT status, attempt_no, error FROM delivery_attempt WHERE id = $1`, [job.audit!.attemptId]);
    expect(rows[0]).toMatchObject({ status: 'failed', attempt_no: 2, error: 'legacy_job_shape' });
  });

  it('a DLQ replay of a legacy job lands back in the DLQ, not at the vendor', async () => {
    const job = legacyJob();
    await redis.lpush(DLQ, JSON.stringify(job));

    expect((await retryFailedJobs({ jobId: job.job_id })).retried).toEqual([job.job_id]);
    await popAndProcess();
    expect(sms.sendRendered).not.toHaveBeenCalled();
    const entries = (await redis.lrange(DLQ, 0, -1)).map((raw) => JSON.parse(raw) as Job);
    expect(entries.map((j) => j.job_id)).toEqual([job.job_id]);
    expect(entries[0]).toMatchObject({ replays: 1, attempt: 1 });
  });
});
