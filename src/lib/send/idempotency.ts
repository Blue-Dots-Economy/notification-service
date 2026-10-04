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

const URGENT_TTL_S = 15 * 60;
const PENDING = 'pending';
const redisKey = (network: string, key: string) => `idem:${network}:${key}`;

/**
 * Claim an idempotency key. Urgent sends use Redis so an OTP never waits on
 * Postgres; normal and bulk use the idempotency_key table (kept 90 days).
 */
export async function claimIdempotency(network: string, key: string, priority: Priority): Promise<Claim> {
  if (priority === 'realtime') {
    const k = redisKey(network, key);
    if ((await redis.set(k, PENDING, 'EX', URGENT_TTL_S, 'NX')) === 'OK') return { status: 'fresh' };
    const value = await redis.get(k);
    if (value === null) return claimIdempotency(network, key, priority); // expired between the two calls
    return value === PENDING ? { status: 'in_progress' } : { status: 'replay', response: JSON.parse(value) };
  }
  const inserted = await getDb().execute(
    sql`INSERT INTO idempotency_key (network, key) VALUES (${network}, ${key}) ON CONFLICT DO NOTHING RETURNING key`,
  );
  if (inserted.rows.length > 0) return { status: 'fresh' };
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
    await redis.set(redisKey(network, key), JSON.stringify(response), 'EX', URGENT_TTL_S, 'XX');
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
      const k = redisKey(network, key);
      if ((await redis.get(k)) === PENDING) await redis.del(k);
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

/** Content key for the 5-second duplicate guard used when no idempotency_key is sent. */
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
