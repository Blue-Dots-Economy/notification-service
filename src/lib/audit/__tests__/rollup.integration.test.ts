import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getPool } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { recordAcceptedMany, upsertAttempt, type AcceptedRecord } from '../store';

beforeAll(async () => { await runMigrations(); });
afterAll(async () => { await closeDb(); });
beforeEach(async () => { await getPool().query(`DELETE FROM delivery_attempt; DELETE FROM notification_event;`); });

function records(n: number, mode: 'all' | 'first_available'): AcceptedRecord[] {
  const eventId = randomUUID();
  const createdAt = new Date().toISOString();
  return Array.from({ length: n }, (_, i) => ({
    ids: { eventId, attemptId: randomUUID(), createdAt, correlationId: 'c', deliveryMode: mode },
    network: 'n', source: 's', priority: 'other', channel: i === 0 ? 'sms' : 'email',
    templateId: 't', payload: {}, recoverable: true, job: { job_id: `j${i}` },
  }));
}
async function eventStatus(r: AcceptedRecord) {
  const { rows } = await getPool().query(`SELECT status, delivery_mode FROM notification_event WHERE id = $1`, [r.ids.eventId]);
  return rows[0];
}

describe('multi-delivery events', () => {
  it('records one event and one attempt per delivery', async () => {
    const rs = records(2, 'all');
    await recordAcceptedMany(rs);
    const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM delivery_attempt WHERE notification_event_id = $1`, [rs[0]!.ids.eventId]);
    expect(rows[0].n).toBe(2);
    expect(await eventStatus(rs[0]!)).toEqual({ status: 'accepted', delivery_mode: 'all' });
  });

  it('all: mixed outcomes roll up to partially_delivered', async () => {
    const rs = records(2, 'all');
    await recordAcceptedMany(rs);
    await upsertAttempt(rs[0]!, { status: 'sent', attemptNo: 1 });
    expect((await eventStatus(rs[0]!)).status).toBe('dispatching');
    await upsertAttempt(rs[1]!, { status: 'failed', attemptNo: 1, error: 'x' });
    expect((await eventStatus(rs[0]!)).status).toBe('partially_delivered');
  });

  it('all: every delivery sent → sent; every one failed → failed', async () => {
    const ok = records(2, 'all');
    await recordAcceptedMany(ok);
    for (const r of ok) await upsertAttempt(r, { status: 'sent', attemptNo: 1 });
    expect((await eventStatus(ok[0]!)).status).toBe('sent');
    const bad = records(2, 'all');
    await recordAcceptedMany(bad);
    for (const r of bad) await upsertAttempt(r, { status: 'failed', attemptNo: 1 });
    expect((await eventStatus(bad[0]!)).status).toBe('failed');
  });

  it('all: concurrent writers on different attempts serialise to the right roll-up', async () => {
    for (let i = 0; i < 10; i++) {
      const rs = records(2, 'all');
      await recordAcceptedMany(rs);
      await Promise.all([
        upsertAttempt(rs[0]!, { status: 'sent', attemptNo: 1 }),
        upsertAttempt(rs[1]!, { status: 'failed', attemptNo: 1, error: 'x' }),
      ]);
      expect((await eventStatus(rs[0]!)).status).toBe('partially_delivered');
    }
  });

  it('first_available mirrors the current attempt', async () => {
    const [a, b] = records(2, 'first_available');
    await recordAcceptedMany([a!]);
    await upsertAttempt(a!, { status: 'failed', attemptNo: 1 });
    await upsertAttempt(b!, { status: 'sent', attemptNo: 1 });
    expect((await eventStatus(a!)).status).toBe('sent');
  });

  it('first_available: a1 failed, a2 queued → the event reflects a2 (accepted)', async () => {
    const [a, b] = records(2, 'first_available');
    await recordAcceptedMany([a!]);
    await upsertAttempt(a!, { status: 'failed', attemptNo: 1, error: 'x' });
    expect((await eventStatus(a!)).status).toBe('failed');
    await upsertAttempt(b!, { status: 'queued', attemptNo: 1 });
    expect((await eventStatus(a!)).status).toBe('accepted');
    await upsertAttempt(b!, { status: 'dispatching', attemptNo: 1 });
    expect((await eventStatus(a!)).status).toBe('dispatching');
  });

  it('first_available: a1 sent, then a2 queued → the event stays sent', async () => {
    const [a, b] = records(2, 'first_available');
    await recordAcceptedMany([a!]);
    for (const status of ['dispatching', 'sent'] as const) await upsertAttempt(a!, { status, attemptNo: 1 });
    expect((await eventStatus(a!)).status).toBe('sent');
    await upsertAttempt(b!, { status: 'queued', attemptNo: 1 });
    expect((await eventStatus(a!)).status).toBe('sent');
  });

  it('first_available: a late failure of the earlier attempt never moves a sent event back', async () => {
    const [a, b] = records(2, 'first_available');
    await recordAcceptedMany([a!]);
    await upsertAttempt(a!, { status: 'dispatching', attemptNo: 1 });
    for (const status of ['queued', 'dispatching', 'sent'] as const) await upsertAttempt(b!, { status, attemptNo: 1 });
    await upsertAttempt(a!, { status: 'failed', attemptNo: 1, error: 'late' });
    expect((await eventStatus(a!)).status).toBe('sent');
    await upsertAttempt(b!, { status: 'delivered', attemptNo: 1 });
    expect((await eventStatus(a!)).status).toBe('delivered');
  });

  it('first_available: every attempt closed without success → the latest-closed attempt wins', async () => {
    const [a, b] = records(2, 'first_available');
    await recordAcceptedMany([a!]);
    await upsertAttempt(a!, { status: 'failed', attemptNo: 1, error: 'x' });
    await upsertAttempt(b!, { status: 'expired', attemptNo: 1 });
    expect((await eventStatus(a!)).status).toBe('expired');
  });
});
