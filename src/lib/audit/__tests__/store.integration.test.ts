import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getPool } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { recordAccepted, upsertAttempt, type AcceptedRecord } from '../store';

beforeAll(async () => { await runMigrations(); });
afterAll(async () => { await closeDb(); });

function rec(): AcceptedRecord {
  return {
    ids: {
      eventId: randomUUID(), attemptId: randomUUID(),
      createdAt: new Date().toISOString(), correlationId: randomUUID(),
    },
    network: 'blue_dot', source: 'test', priority: 'other',
    channel: 'email', templateId: 'welcome', templateKey: 'welcome', eventType: null, domain: null,
    payload: { to: 'a@b.c' }, job: { job_id: 'j' }, recoverable: true,
  };
}

async function read(r: AcceptedRecord) {
  const pool = getPool();
  const ev = await pool.query(`SELECT status FROM notification_event WHERE id = $1`, [r.ids.eventId]);
  const at = await pool.query(
    `SELECT status, attempt_no, provider_message_id FROM delivery_attempt WHERE id = $1`,
    [r.ids.attemptId],
  );
  return { event: ev.rows[0]?.status, attempt: at.rows[0] };
}

describe('audit store', () => {
  it('records an accepted send as event accepted + attempt queued', async () => {
    const r = rec();
    await recordAccepted(r);
    expect(await read(r)).toMatchObject({
      event: 'accepted', attempt: { status: 'queued', attempt_no: 1 },
    });
  });

  it('is idempotent on replay of the same ids', async () => {
    const r = rec();
    await recordAccepted(r);
    await expect(recordAccepted(r)).resolves.toBeUndefined();
  });

  it('moves forward and never backward within an attempt', async () => {
    const r = rec();
    await recordAccepted(r);
    await upsertAttempt(r, { status: 'sent', attemptNo: 1, providerMessageId: 'pm-1' });
    await upsertAttempt(r, { status: 'dispatching', attemptNo: 1 });
    expect(await read(r)).toMatchObject({
      event: 'sent', attempt: { status: 'sent', provider_message_id: 'pm-1' },
    });
  });

  it('a later attempt number may restart at queued', async () => {
    const r = rec();
    await recordAccepted(r);
    await upsertAttempt(r, { status: 'dispatching', attemptNo: 1 });
    await upsertAttempt(r, { status: 'queued', attemptNo: 2 });
    expect(await read(r)).toMatchObject({ attempt: { status: 'queued', attempt_no: 2 } });
  });

  it('upsertAttempt applied out of order still lands the final status', async () => {
    // Realtime: the worker finished before the fire-and-forget insert arrived.
    const r = { ...rec(), priority: 'realtime' as const, job: undefined, recoverable: false };
    await upsertAttempt(r, { status: 'sent', attemptNo: 1 });
    await recordAccepted(r);
    expect(await read(r)).toMatchObject({ event: 'sent', attempt: { status: 'sent' } });
  });

  it('persists at most 500 chars of a provider error', async () => {
    const r = rec();
    await recordAccepted(r);
    await upsertAttempt(r, { status: 'failed', attemptNo: 1, error: 'x'.repeat(5000) });
    const { rows } = await getPool().query(`SELECT length(error) AS n FROM delivery_attempt WHERE id = $1`, [r.ids.attemptId]);
    expect(rows[0].n).toBe(500);
  });
});
