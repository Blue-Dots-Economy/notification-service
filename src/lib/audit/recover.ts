import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryConfig, QueryResultRow } from 'pg';
import redis from '../redis';
import { pushManyToPriority } from '../queue';
import { getPool } from '../db/client';
import * as metrics from '../metrics';
import type { Job } from 'src/types';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { ATTEMPT_RANK } from './status';
import { rollUpEvent, type SqlExecutor } from './store';
import { readAttemptMarkers, type AttemptMarker } from './marker';
import { describeDbError } from '../db/errors';

/**
 * Redis is the dispatch queue; Postgres is the record. A Redis that restarts
 * without its data loses queued work silently. NS detects that with an epoch
 * key it writes once and never expires: absent epoch = Redis lost its data.
 * Recovery keys off Redis uptime, so it covers a restart; a FLUSHALL without a
 * restart is only partly recovered (stale `dispatching` rows; see
 * recoverLostJobs for the `queued` gap). Redis must run
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

/**
 * Boot-time recovery. Never throws: a database or Redis hiccup at boot must not
 * crash-loop the pod, and the periodic sweep retries within minutes.
 */
export async function recoverAtBoot(): Promise<void> {
  try {
    await recoverLostJobs();
  } catch (err) {
    console.error('Boot recovery failed; the periodic sweep will retry:', describeDbError(err));
  }
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

/** `now() - uptime` on the database clock, as exact Postgres text. */
async function redisStartedAt(uptimeSeconds: number): Promise<string> {
  const { rows } = await getPool().query<{ cutoff: string }>(
    `SELECT (now() - make_interval(secs => $1::numeric))::text AS cutoff`,
    [uptimeSeconds],
  );
  return rows[0]!.cutoff;
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
  /** Stamped from an attempt marker (sent / failed / expired) instead of re-sent. */
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
 *   that died mid-send, or before its retry was scheduled; at-least-once by
 *   design).
 *
 * Not covered without an epoch loss: a `queued` row whose job left Redis
 * before the worker's `dispatching` stamp (crash between pop and stamp, or
 * between the /notify insert and its push). Age alone is no proof of loss, as a
 * `queued` job may wait in a queue or the retry set for long, so sweeping
 * `queued` rows would double-send; closing it needs a claim written at pop.
 *
 * Each candidate is resolved in this order:
 * 1. An attempt marker (see marker.ts) for this attempt → `sent`/`failed`/
 *    `expired` is stamped on the row; `retry` means the job is in the retry set → left as is.
 * 2. Created more than `maxAgeHours` ago → marked failed (abandoned) and
 *    counted in ns_recovery_abandoned_total; a late send is worse than none.
 * 3. Otherwise → attempt_no + 1, status queued, pushed back onto its own
 *    priority's queue (a recovered job never changes pool).
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
    // The epoch-lost cutoff is fixed ONCE as an absolute timestamp. Evaluating
    // `now() - uptime` per batch would let it drift forward with the run, and a
    // later batch would pick up rows live traffic wrote after the Redis start.
    const epochCutoff = epochLost ? await redisStartedAt(await redisUptimeSeconds()) : null;

    const total: RecoveryResult = { epochLost, requeued: 0, marked: 0, abandoned: 0 };
    // Keyset cursor: rows left untouched (retry markers) are never revisited.
    let cursor: { createdAt: string; id: string } = {
      createdAt: '-infinity',
      id: '00000000-0000-0000-0000-000000000000',
    };
    for (;;) {
      const batch = await recoverBatch({ epochCutoff, staleMs, maxAgeHours, batchSize, cursor });
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
  /** Absolute Redis start time (Postgres text) when the epoch was lost; else null. */
  epochCutoff: string | null;
  staleMs: number;
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
              created_at < now() - make_interval(hours => $3::int) AS too_old
         FROM delivery_attempt
        WHERE recoverable
          AND job IS NOT NULL
          AND (
            ($1::timestamptz IS NOT NULL AND status IN ('queued', 'dispatching')
               AND updated_at < $1::timestamptz)
            OR (status = 'dispatching' AND updated_at < now() - make_interval(secs => $2::numeric / 1000))
          )
          AND (created_at, id) > ($4::timestamptz, $5::uuid)
        ORDER BY created_at, id
        LIMIT $6
        FOR UPDATE SKIP LOCKED`,
      [p.epochCutoff, p.staleMs, p.maxAgeHours, p.cursor.createdAt, p.cursor.id, p.batchSize],
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
    }

    let requeueJobs: Job[] = [];
    if (toRequeue.length > 0) {
      const { rows: bumped } = await q<{ id: string; attempt_no: number }>(
        `UPDATE delivery_attempt
            SET status = 'queued', status_rank = 0, attempt_no = attempt_no + 1, updated_at = now()
          WHERE id = ANY($1::uuid[]) AND created_at = ANY($2::timestamptz[])
          RETURNING id, attempt_no`,
        [toRequeue.map((r) => r.id), toRequeue.map((r) => r.created_at)],
      );
      const attemptById = new Map(bumped.map((b) => [b.id, b.attempt_no]));
      requeueJobs = toRequeue.map((r) => ({ ...r.job, attempt: (attemptById.get(r.id) ?? r.attempt_no + 1) - 1 }));
    }

    // The events of every attempt written above (stamped, abandoned or
    // re-queued), rolled up from all their attempts (a first_available/all
    // event has siblings; writing one attempt's status straight onto the event
    // would overwrite them). Sorted, so two concurrent sweeps take the event
    // row locks in the same order.
    const touched = new Map<string, { eventId: string; createdAt: string }>();
    for (const r of [...toMark.map((m) => m.row), ...toAbandon, ...toRequeue]) {
      touched.set(`${r.notification_event_id}|${r.created_at}`, { eventId: r.notification_event_id, createdAt: r.created_at });
    }
    const exec = sqlExecutor(q);
    for (const key of [...touched.keys()].sort()) {
      const { eventId, createdAt } = touched.get(key)!;
      await rollUpEvent(exec, eventId, createdAt);
    }

    // Last, so a failed push rolls back every write of this batch.
    if (requeueJobs.length > 0) await pushManyToPriority(requeueJobs);

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

const dialect = new PgDialect();

/** Runs rollUpEvent's drizzle `sql` on recovery's own (pg) transaction client. */
function sqlExecutor(q: Query): SqlExecutor {
  return {
    execute: (query: SQL) => {
      const { sql: text, params } = dialect.sqlToQuery(query);
      return q(text, params);
    },
  };
}

const MARKER_STATUS = { sent: 'sent', failed: 'failed', expired: 'expired' } as const;

/**
 * Record the state the worker marked on the attempt, instead of re-sending.
 * The event is rolled up afterwards, by the caller, from all its attempts.
 */
async function stampFromMarker(q: Query, row: Candidate, marker: AttemptMarker): Promise<void> {
  const status = MARKER_STATUS[marker.fate as keyof typeof MARKER_STATUS] ?? 'failed';
  const terminal = status !== 'sent';
  await q(
    `UPDATE delivery_attempt
        SET status = $3, status_rank = $4, attempt_no = $5,
            error = $6, completed_at = ${terminal ? 'now()' : 'NULL'}, updated_at = now()
      WHERE id = $1 AND created_at = $2`,
    [row.id, row.created_at, status, ATTEMPT_RANK[status], marker.attemptNo, terminal ? `${status} (recorded by attempt marker)` : null],
  );
}
