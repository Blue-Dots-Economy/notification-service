import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryConfig, QueryResultRow } from 'pg';
import redis from '../redis';
import { pushOtherMany } from '../queue';
import { getPool } from '../db/client';
import * as metrics from '../metrics';
import type { Job } from 'src/types';
import { ATTEMPT_RANK, eventStatusFor } from './status';
import { readAttemptMarkers, type AttemptMarker } from './marker';

/**
 * Redis is the dispatch queue; Postgres is the record. A Redis that restarts
 * without its data loses queued work silently. NS detects that with an epoch
 * key it writes once and never expires: absent epoch = Redis lost its data.
 * Recovery keys off Redis uptime, so it covers a restart; a FLUSHALL without a
 * restart is only partly recovered (stale `dispatching` rows). Redis must run
 * with `noeviction` so the epoch key is never dropped.
 */
export const REDIS_EPOCH_KEY = 'ns:epoch';
export const REDIS_RECOVERY_LOCK_KEY = 'ns:recovery';
export const RECOVERY_BATCH_SIZE = 500;
export const ABANDONED_ERROR = 'abandoned: not delivered within recovery window';
const RECOVERY_LOCK_TTL_MS = 60_000;
const DEFAULT_STALE_DISPATCH_MS = 10 * 60 * 1000;
const DEFAULT_MAX_AGE_HOURS = 24;
/** Server- and client-side bound for recovery's own queries (the pool default is 5s). */
const RECOVERY_QUERY_TIMEOUT_MS = 60_000;

/** `RECOVERY_MAX_AGE_HOURS` (default 24): older open rows are abandoned, not re-sent. */
export function recoveryMaxAgeHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RECOVERY_MAX_AGE_HOURS;
  const n = Number(raw ?? DEFAULT_MAX_AGE_HOURS);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`RECOVERY_MAX_AGE_HOURS must be a positive integer, got '${raw}'`);
  }
  return n;
}

// Fixed Redis-side Lua (EVAL), not JavaScript eval(): delete the lock only if
// it is still ours, so a slow holder never releases a successor's lock.
const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

async function redisUptimeSeconds(): Promise<number> {
  const info = await redis.info('server');
  const m = /uptime_in_seconds:(\d+)/.exec(info);
  if (!m) throw new Error('Redis INFO did not report uptime_in_seconds');
  return Number(m[1]);
}

interface Candidate {
  id: string;
  /**
   * created_at as Postgres text. A JS Date would truncate microseconds, and
   * the value is fed back as a key (cursor, partition match), so it must be exact.
   */
  created_at: string;
  notification_event_id: string;
  attempt_no: number;
  job: Job;
  too_old: boolean;
}

export interface RecoveryResult {
  epochLost: boolean;
  /** Pushed back onto the queue. */
  requeued: number;
  /** Stamped from an attempt marker (sent / failed) instead of re-sent. */
  marked: number;
  /** Older than the recovery window: marked failed, not re-sent. */
  abandoned: number;
}

/**
 * Re-queue recoverable work from Postgres.
 *
 * Candidates (recoverable, with a job copy):
 * - Epoch lost (no `ns:epoch`): queued/dispatching attempts last touched
 *   BEFORE this Redis started; anything newer reached the live Redis.
 * - Always: attempts stuck in `dispatching` past `staleDispatchMs` (a worker
 *   that died mid-send; at-least-once by design).
 *
 * Each candidate is resolved in this order:
 * 1. An attempt marker (see marker.ts) for this attempt → `sent`/`failed` is
 *    stamped on the row; `retry` means the job is in the retry set → left as is.
 * 2. Created more than `maxAgeHours` ago → marked failed (abandoned) and
 *    counted in ns_recovery_abandoned_total; a late send is worse than none.
 * 3. Otherwise → attempt_no + 1, status queued, pushed onto the other queue.
 *
 * Work runs in batches of RECOVERY_BATCH_SIZE, each its own transaction: the
 * row updates and the batch's single MULTI push commit together, or roll back
 * together and are found again by the next run. Only the holder of a
 * short-lived lock performs the epoch-lost re-queue, and the epoch is written
 * only after every batch committed.
 */
export async function recoverLostJobs(
  opts: { staleDispatchMs?: number; maxAgeHours?: number; batchSize?: number } = {},
): Promise<RecoveryResult> {
  const staleMs = opts.staleDispatchMs ?? DEFAULT_STALE_DISPATCH_MS;
  const maxAgeHours = opts.maxAgeHours ?? recoveryMaxAgeHours();
  const batchSize = opts.batchSize ?? RECOVERY_BATCH_SIZE;

  const lockToken = randomUUID();
  const gotLock =
    (await redis.set(REDIS_RECOVERY_LOCK_KEY, lockToken, 'PX', RECOVERY_LOCK_TTL_MS, 'NX')) === 'OK';

  try {
    const epochLost = gotLock && !(await redis.exists(REDIS_EPOCH_KEY));
    const uptimeSeconds = epochLost ? await redisUptimeSeconds() : 0;

    const total: RecoveryResult = { epochLost, requeued: 0, marked: 0, abandoned: 0 };
    // Keyset cursor: rows left untouched (retry markers) are never revisited.
    let cursor: { createdAt: string; id: string } = {
      createdAt: '-infinity',
      id: '00000000-0000-0000-0000-000000000000',
    };
    for (;;) {
      const batch = await recoverBatch({ epochLost, staleMs, uptimeSeconds, maxAgeHours, batchSize, cursor });
      total.requeued += batch.requeued;
      total.marked += batch.marked;
      total.abandoned += batch.abandoned;
      if (batch.abandoned > 0) await metrics.incr('ns_recovery_abandoned_total', {}, batch.abandoned);
      if (batch.size < batchSize || !batch.last) break;
      cursor = batch.last;
    }

    if (epochLost) await redis.set(REDIS_EPOCH_KEY, randomUUID());
    if (total.requeued + total.marked + total.abandoned > 0) {
      console.log(
        `Recovery: requeued=${total.requeued} marked=${total.marked} abandoned=${total.abandoned} (epochLost=${epochLost})`,
      );
    }
    return total;
  } finally {
    if (gotLock) {
      await redis.eval(RELEASE_LOCK_SCRIPT, 1, REDIS_RECOVERY_LOCK_KEY, lockToken).catch(() => undefined);
    }
  }
}

async function recoverBatch(p: {
  epochLost: boolean;
  staleMs: number;
  uptimeSeconds: number;
  maxAgeHours: number;
  batchSize: number;
  cursor: { createdAt: string; id: string };
}): Promise<{ size: number; last?: { createdAt: string; id: string }; requeued: number; marked: number; abandoned: number }> {
  const client = await getPool().connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '60s'`);
    const q = queryWithTimeout(client);

    const { rows } = await q<Candidate>(
      `SELECT id, created_at::text AS created_at, notification_event_id, attempt_no, job,
              created_at < now() - make_interval(hours => $4::int) AS too_old
         FROM delivery_attempt
        WHERE recoverable
          AND job IS NOT NULL
          AND (
            ($1::boolean AND status IN ('queued', 'dispatching')
               AND updated_at < now() - make_interval(secs => $3::numeric))
            OR (status = 'dispatching' AND updated_at < now() - make_interval(secs => $2::numeric / 1000))
          )
          AND (created_at, id) > ($5::timestamptz, $6::uuid)
        ORDER BY created_at, id
        LIMIT $7
        FOR UPDATE SKIP LOCKED`,
      [p.epochLost, p.staleMs, p.uptimeSeconds, p.maxAgeHours, p.cursor.createdAt, p.cursor.id, p.batchSize],
    );

    const markers = await readAttemptMarkers(rows.map((r) => r.id));
    const toMark: Array<{ row: Candidate; marker: AttemptMarker }> = [];
    const toAbandon: Candidate[] = [];
    const toRequeue: Candidate[] = [];
    for (const row of rows) {
      const marker = markers.get(row.id);
      if (marker && marker.fate !== 'retry' && marker.attemptNo >= row.attempt_no) {
        toMark.push({ row, marker });
      } else if (marker && marker.fate === 'retry' && marker.attemptNo > row.attempt_no) {
        // The job is already in the retry set; only its `queued` stamp failed.
      } else if (row.too_old) {
        toAbandon.push(row);
      } else {
        toRequeue.push(row);
      }
    }

    for (const { row, marker } of toMark) {
      await stampFromMarker(q, row, marker);
    }

    if (toAbandon.length > 0) {
      await q(
        `UPDATE delivery_attempt
            SET status = 'failed', status_rank = $3, error = $4, completed_at = now(), updated_at = now()
          WHERE id = ANY($1::uuid[]) AND created_at = ANY($2::timestamptz[])`,
        [toAbandon.map((r) => r.id), toAbandon.map((r) => r.created_at), ATTEMPT_RANK.failed, ABANDONED_ERROR],
      );
      await q(
        `UPDATE notification_event
            SET status = 'failed', updated_at = now()
          WHERE id = ANY($1::uuid[]) AND created_at = ANY($2::timestamptz[])`,
        [toAbandon.map((r) => r.notification_event_id), toAbandon.map((r) => r.created_at)],
      );
    }

    if (toRequeue.length > 0) {
      const { rows: bumped } = await q<{ id: string; attempt_no: number }>(
        `UPDATE delivery_attempt
            SET status = 'queued', status_rank = 0, attempt_no = attempt_no + 1, updated_at = now()
          WHERE id = ANY($1::uuid[]) AND created_at = ANY($2::timestamptz[])
          RETURNING id, attempt_no`,
        [toRequeue.map((r) => r.id), toRequeue.map((r) => r.created_at)],
      );
      const attemptById = new Map(bumped.map((b) => [b.id, b.attempt_no]));
      await pushOtherMany(
        toRequeue.map((r) => ({ ...r.job, attempt: (attemptById.get(r.id) ?? r.attempt_no + 1) - 1 })),
      );
    }

    await client.query('COMMIT');
    const lastRow = rows[rows.length - 1];
    return {
      size: rows.length,
      last: lastRow ? { createdAt: lastRow.created_at, id: lastRow.id } : undefined,
      requeued: toRequeue.length,
      marked: toMark.length,
      abandoned: toAbandon.length,
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // A connection that cannot roll back is in an unknown state: destroy it.
      broken = rollbackErr as Error;
    }
    throw err;
  } finally {
    client.release(broken);
  }
}

type Query = <R extends QueryResultRow>(text: string, values: unknown[]) => Promise<{ rows: R[] }>;

/**
 * node-postgres honours a per-query `query_timeout` (not in @types/pg), which
 * lifts the pool's 5s client-side bound to match the 60s SET LOCAL.
 */
function queryWithTimeout(client: PoolClient): Query {
  return <R extends QueryResultRow>(text: string, values: unknown[]) =>
    client.query<R>({ text, values, query_timeout: RECOVERY_QUERY_TIMEOUT_MS } as QueryConfig);
}

/** Record the state the worker marked, instead of re-sending. */
async function stampFromMarker(q: Query, row: Candidate, marker: AttemptMarker): Promise<void> {
  const status = marker.fate === 'sent' ? 'sent' : 'failed';
  const terminal = status === 'failed';
  await q(
    `UPDATE delivery_attempt
        SET status = $3, status_rank = $4, attempt_no = $5,
            error = $6, completed_at = ${terminal ? 'now()' : 'NULL'}, updated_at = now()
      WHERE id = $1 AND created_at = $2`,
    [row.id, row.created_at, status, ATTEMPT_RANK[status], marker.attemptNo, terminal ? 'failed (recorded by attempt marker)' : null],
  );
  await q(
    `UPDATE notification_event SET status = $3, updated_at = now()
      WHERE id = $1 AND created_at = $2`,
    [row.notification_event_id, row.created_at, eventStatusFor(status)],
  );
}
