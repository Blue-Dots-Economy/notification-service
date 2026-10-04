import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const pushed: unknown[] = [];
vi.mock('../../queue', () => ({ pushOther: vi.fn(async (j: unknown) => { pushed.push(j); return 1; }) }));

import redis from '../../redis';
import { pushOther } from '../../queue';
import { closeDb, getPool } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { recordAccepted, upsertAttempt, type AcceptedRecord } from '../store';
import { recoverLostJobs, REDIS_EPOCH_KEY, REDIS_RECOVERY_LOCK_KEY } from '../recover';

beforeAll(async () => { await runMigrations(); });
afterAll(async () => { await closeDb(); redis.disconnect(); });
beforeEach(async () => {
  pushed.length = 0;
  vi.mocked(pushOther).mockClear();
  await redis.del(REDIS_RECOVERY_LOCK_KEY);
  await getPool().query(`DELETE FROM delivery_attempt; DELETE FROM notification_event;`);
});

function rec(priority: 'realtime' | 'other'): AcceptedRecord {
  const jobId = randomUUID();
  return {
    ids: { eventId: randomUUID(), attemptId: randomUUID(), createdAt: new Date().toISOString(), correlationId: jobId },
    network: 'n', source: 's', priority, channel: 'email', templateId: 't',
    payload: {}, recoverable: priority === 'other',
    job: priority === 'other' ? { job_id: jobId, channel: 'email', priority, to: 'x', template_id: 't', variables: {} } : undefined,
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

  it('does nothing when the epoch is present and nothing is stale', async () => {
    await recordAccepted(rec('other'));
    await redis.set(REDIS_EPOCH_KEY, 'x');
    expect(await recoverLostJobs()).toEqual({ epochLost: false, requeued: 0 });
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
    expect(await recoverLostJobs()).toEqual({ epochLost: true, requeued: 0 });
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
    vi.mocked(pushOther).mockRejectedValueOnce(new Error('redis down'));
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
    vi.mocked(pushOther).mockRejectedValueOnce(new Error('redis down'));
    await expect(recoverLostJobs()).rejects.toThrow();
    expect(await redis.get(REDIS_EPOCH_KEY)).toBeNull();
    expect(await recoverLostJobs()).toEqual({ epochLost: true, requeued: 1 });
  });
});
