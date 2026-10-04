import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const pushed: unknown[] = [];
vi.mock('../../queue', () => ({ pushOther: vi.fn(async (j: unknown) => { pushed.push(j); return 1; }) }));

import redis from '../../redis';
import { closeDb, getPool } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { recordAccepted, upsertAttempt, type AcceptedRecord } from '../store';
import { recoverLostJobs, REDIS_EPOCH_KEY } from '../recover';

beforeAll(async () => { await runMigrations(); });
afterAll(async () => { await closeDb(); redis.disconnect(); });
beforeEach(async () => {
  pushed.length = 0;
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

describe('recoverLostJobs', () => {
  it('requeues when the epoch is missing, exactly once', async () => {
    const r = rec('other');
    await recordAccepted(r);
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
});
