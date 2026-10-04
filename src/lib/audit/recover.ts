import { randomUUID } from 'node:crypto';
import redis from '../redis';
import { pushOther } from '../queue';
import { getPool } from '../db/client';
import type { Job } from 'src/types';

/**
 * Redis is the dispatch queue; Postgres is the record. A Redis that restarts
 * without its data (or is flushed) loses queued work silently. NS detects that
 * with an epoch key it writes once and never expires: absent epoch = lost data.
 * Redis must run with `noeviction` so the epoch key is never dropped.
 */
export const REDIS_EPOCH_KEY = 'ns:epoch';
export const REDIS_RECOVERY_LOCK_KEY = 'ns:recovery';
const RECOVERY_LOCK_TTL_MS = 60_000;
const DEFAULT_STALE_DISPATCH_MS = 10 * 60 * 1000;

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

/**
 * Re-queue recoverable work from Postgres.
 *
 * - Epoch lost (no `ns:epoch`): re-queue queued/dispatching attempts last
 *   touched BEFORE this Redis started; anything newer reached the live Redis.
 * - Always: re-queue attempts stuck in `dispatching` past `staleDispatchMs`
 *   (a worker that died mid-send; at-least-once by design).
 *
 * The status bump and every push happen in one Postgres transaction: if a push
 * fails, the bump rolls back and the next run finds the rows again. Only the
 * holder of a short-lived lock performs the epoch-lost re-queue, and the epoch
 * is written only after the commit.
 */
export async function recoverLostJobs(
  opts: { staleDispatchMs?: number } = {},
): Promise<{ epochLost: boolean; requeued: number }> {
  const staleMs = opts.staleDispatchMs ?? DEFAULT_STALE_DISPATCH_MS;

  const lockToken = randomUUID();
  const gotLock =
    (await redis.set(REDIS_RECOVERY_LOCK_KEY, lockToken, 'PX', RECOVERY_LOCK_TTL_MS, 'NX')) === 'OK';

  try {
    const epochLost = gotLock && !(await redis.exists(REDIS_EPOCH_KEY));
    const uptimeSeconds = epochLost ? await redisUptimeSeconds() : 0;

    const client = await getPool().connect();
    let requeued = 0;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ job: Job; attempt_no: number }>(
        `UPDATE delivery_attempt
            SET status = 'queued', status_rank = 0, attempt_no = attempt_no + 1, updated_at = now()
          WHERE recoverable
            AND job IS NOT NULL
            AND (
              ($1::boolean AND status IN ('queued', 'dispatching')
                 AND updated_at < now() - make_interval(secs => $3::numeric))
              OR (status = 'dispatching' AND updated_at < now() - make_interval(secs => $2::numeric / 1000))
            )
          RETURNING job, attempt_no`,
        [epochLost, staleMs, uptimeSeconds],
      );
      for (const row of rows) {
        await pushOther({ ...row.job, attempt: row.attempt_no - 1 });
      }
      await client.query('COMMIT');
      requeued = rows.length;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    if (epochLost) await redis.set(REDIS_EPOCH_KEY, randomUUID());
    if (requeued > 0) console.log(`Recovered ${requeued} job(s) (epochLost=${epochLost})`);
    return { epochLost, requeued };
  } finally {
    if (gotLock) {
      await redis.eval(RELEASE_LOCK_SCRIPT, 1, REDIS_RECOVERY_LOCK_KEY, lockToken).catch(() => undefined);
    }
  }
}
