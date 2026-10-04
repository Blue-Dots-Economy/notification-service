import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import redis from '../redis';
import { getDb } from '../db/client';
import { describeDbError } from '../db/errors';
import type { Priority } from '../../types';
import type { V1Request } from './request';

export type Claim =
  | { status: 'fresh' }
  | { status: 'replay'; response: Record<string, unknown> }
  | { status: 'in_progress' };

/** How long a claim may stay pending before it is treated as abandoned (Redis TTL and Postgres stale-reclaim). */
const CLAIM_WINDOW_S = 15 * 60;
const PENDING = 'pending';
/** Atomic compare-and-delete: only drop the key while it is still pending. */
const RELEASE_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
const redisKey = (network: string, key: string) => `idem:${network}:${key}`;

/**
 * Claim an idempotency key. Urgent sends use Redis so an OTP never waits on
 * Postgres; normal and bulk use the idempotency_key table (kept 90 days).
 */
export async function claimIdempotency(network: string, key: string, priority: Priority): Promise<Claim> {
  if (priority === 'realtime') {
    const k = redisKey(network, key);
    if ((await redis.set(k, PENDING, 'EX', CLAIM_WINDOW_S, 'NX')) === 'OK') return { status: 'fresh' };
    const value = await redis.get(k);
    if (value === null) return claimIdempotency(network, key, priority); // expired between the two calls
    return value === PENDING ? { status: 'in_progress' } : { status: 'replay', response: JSON.parse(value) };
  }
  const inserted = await getDb().execute(
    sql`INSERT INTO idempotency_key (network, key) VALUES (${network}, ${key}) ON CONFLICT DO NOTHING RETURNING key`,
  );
  if (inserted.rows.length > 0) return { status: 'fresh' };
  // A crash between claim and complete/release leaves a null-response row; reclaim it once the window has passed
  // (Redis self-heals via its TTL). The UPDATE is atomic, so concurrent claimers get exactly one winner.
  const reclaimed = await getDb().execute(
    sql`UPDATE idempotency_key SET created_at = now()
        WHERE network = ${network} AND key = ${key} AND response IS NULL
          AND created_at < now() - make_interval(secs => ${CLAIM_WINDOW_S})
        RETURNING key`,
  );
  if (reclaimed.rows.length > 0) return { status: 'fresh' };
  const existing = await getDb().execute(
    sql`SELECT response FROM idempotency_key WHERE network = ${network} AND key = ${key}`,
  );
  const response = existing.rows[0]?.response as Record<string, unknown> | null | undefined;
  return response ? { status: 'replay', response } : { status: 'in_progress' };
}

export async function completeIdempotency(
  network: string,
  key: string,
  priority: Priority,
  response: Record<string, unknown>,
): Promise<void> {
  if (priority === 'realtime') {
    // XX: if the key already expired the no-op is intentional, the 15-minute window has passed.
    await redis.set(redisKey(network, key), JSON.stringify(response), 'EX', CLAIM_WINDOW_S, 'XX');
    return;
  }
  await getDb().execute(
    sql`UPDATE idempotency_key SET response = ${JSON.stringify(response)}::jsonb WHERE network = ${network} AND key = ${key}`,
  );
}

/** Undo a claim so the caller's retry is accepted. Best-effort: never throws. */
export async function releaseIdempotency(network: string, key: string, priority: Priority): Promise<void> {
  try {
    if (priority === 'realtime') {
      await redis.eval(RELEASE_LUA, 1, redisKey(network, key), PENDING);
      return;
    }
    await getDb().execute(
      sql`DELETE FROM idempotency_key WHERE network = ${network} AND key = ${key} AND response IS NULL`,
    );
  } catch (err) {
    console.error('idempotency release failed:', describeDbError(err));
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, canonical(obj[k])]),
    );
  }
  return value;
}

/**
 * Content key for the 5-second duplicate guard used when no idempotency_key is sent.
 * JSON.stringify drops undefined values, so `{a: undefined}` hashes the same as an absent key.
 */
export function fallbackKey(req: V1Request): string {
  const { event_type, template_key, channel, domain, to, locale, variables } = req;
  const digest = createHash('sha256')
    .update(JSON.stringify(canonical({ event_type, template_key, channel, domain, to, locale, variables })))
    .digest('hex');
  return `v1:${digest}`;
}

export async function pruneIdempotencyKeys(olderThanDays = 90): Promise<number> {
  const res = await getDb().execute(
    sql`DELETE FROM idempotency_key WHERE created_at < now() - make_interval(days => ${olderThanDays})`,
  );
  return res.rowCount ?? 0;
}
