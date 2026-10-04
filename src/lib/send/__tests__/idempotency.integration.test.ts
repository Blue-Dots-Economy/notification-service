import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import redis from '../../redis';
import { closeDb, getPool } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { claimIdempotency, completeIdempotency, fallbackKey, pruneIdempotencyKeys, releaseIdempotency } from '../idempotency';
import { V1NotifySchema } from '../request';

beforeAll(async () => { await runMigrations(); });
afterAll(async () => { await closeDb(); redis.disconnect(); });
beforeEach(async () => {
  await getPool().query(`DELETE FROM idempotency_key`);
  for (const k of await redis.keys('idem:*')) await redis.del(k);
});

describe.each(['realtime', 'other'] as const)('idempotency (%s)', (priority) => {
  it('fresh → in progress → replay', async () => {
    expect(await claimIdempotency('n', 'k1', priority)).toEqual({ status: 'fresh' });
    expect(await claimIdempotency('n', 'k1', priority)).toEqual({ status: 'in_progress' });
    await completeIdempotency('n', 'k1', priority, { notification_event_id: 'e1' });
    expect(await claimIdempotency('n', 'k1', priority)).toEqual({ status: 'replay', response: { notification_event_id: 'e1' } });
  });

  it('release lets a retry claim again', async () => {
    await claimIdempotency('n', 'k2', priority);
    await releaseIdempotency('n', 'k2', priority);
    expect(await claimIdempotency('n', 'k2', priority)).toEqual({ status: 'fresh' });
  });

  it('concurrent claims: exactly one fresh', async () => {
    const claims = await Promise.all(Array.from({ length: 8 }, () => claimIdempotency('n', 'k3', priority)));
    expect(claims.filter((c) => c.status === 'fresh')).toHaveLength(1);
  });

  it('release after complete leaves the stored response intact', async () => {
    await claimIdempotency('n', 'k5', priority);
    await completeIdempotency('n', 'k5', priority, { notification_event_id: 'e5' });
    await releaseIdempotency('n', 'k5', priority);
    expect(await claimIdempotency('n', 'k5', priority)).toEqual({ status: 'replay', response: { notification_event_id: 'e5' } });
  });

  it('keys are scoped per network', async () => {
    await claimIdempotency('a', 'k4', priority);
    expect(await claimIdempotency('b', 'k4', priority)).toEqual({ status: 'fresh' });
  });
});

describe('stale Postgres claims', () => {
  const insertStale = () =>
    getPool().query(`INSERT INTO idempotency_key (network, key, created_at) VALUES ('n', 'stale', now() - interval '16 minutes')`);
  it('reclaims a null-response row older than the window', async () => {
    await insertStale();
    expect(await claimIdempotency('n', 'stale', 'other')).toEqual({ status: 'fresh' });
    expect(await claimIdempotency('n', 'stale', 'other')).toEqual({ status: 'in_progress' });
  });
  it('concurrent claims on a stale row: exactly one fresh', async () => {
    await insertStale();
    const claims = await Promise.all(Array.from({ length: 8 }, () => claimIdempotency('n', 'stale', 'other')));
    expect(claims.filter((c) => c.status === 'fresh')).toHaveLength(1);
  });
});

describe('fallbackKey and pruning', () => {
  it('treats an undefined variable like an absent key (JSON.stringify drops undefined)', () => {
    const a = V1NotifySchema.parse({ event_type: 'x', to: { phone: '+919999999999' }, variables: { a: undefined } });
    const b = V1NotifySchema.parse({ event_type: 'x', to: { phone: '+919999999999' }, variables: {} });
    expect(fallbackKey(a)).toBe(fallbackKey(b));
  });
  it('is stable regardless of key order and differs by content', () => {
    const a = V1NotifySchema.parse({ event_type: 'x', to: { phone: '+919999999999' }, variables: { a: '1', b: '2' } });
    const b = V1NotifySchema.parse({ variables: { b: '2', a: '1' }, to: { phone: '+919999999999' }, event_type: 'x' });
    const c = V1NotifySchema.parse({ event_type: 'x', to: { phone: '+919999999999' }, variables: { a: '1', b: '3' } });
    expect(fallbackKey(a)).toBe(fallbackKey(b));
    expect(fallbackKey(a)).not.toBe(fallbackKey(c));
  });
  it('is stable across nested key order in to and variables', () => {
    const a = V1NotifySchema.parse({ event_type: 'x', to: { email: 'a@b.co', phone: '+919999999999' }, variables: { o: { p: 1, q: 2 } } });
    const b = V1NotifySchema.parse({ event_type: 'x', variables: { o: { q: 2, p: 1 } }, to: { phone: '+919999999999', email: 'a@b.co' } });
    expect(fallbackKey(a)).toBe(fallbackKey(b));
  });
  it('prunes rows older than the window', async () => {
    await claimIdempotency('n', 'old', 'other');
    await getPool().query(`UPDATE idempotency_key SET created_at = now() - interval '91 days' WHERE key = 'old'`);
    await claimIdempotency('n', 'recent', 'other');
    expect(await pruneIdempotencyKeys(90)).toBe(1);
  });
});
