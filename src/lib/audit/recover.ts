import { randomUUID } from 'node:crypto';
import redis from '../redis';
import { pushOther } from '../queue';
import { getPool } from '../db/client';
import type { Job } from 'src/types';

/**
 * Redis is the dispatch queue; Postgres is the record. A Redis that restarts
 * without its data (or is flushed) loses queued work silently. NS detects that
 * with an epoch key it writes once and never expires: absent epoch = lost data.
 */
export const REDIS_EPOCH_KEY = 'ns:epoch';
const DEFAULT_STALE_DISPATCH_MS = 10 * 60 * 1000;

export async function recoverLostJobs(
  opts: { staleDispatchMs?: number } = {},
): Promise<{ epochLost: boolean; requeued: number }> {
  const staleMs = opts.staleDispatchMs ?? DEFAULT_STALE_DISPATCH_MS;

  // Claim the epoch FIRST, with SET NX: of several replicas booting after a
  // Redis loss, exactly one gets 'OK' and owns the full re-queue. Checking
  // EXISTS and setting afterwards would let a second replica that starts in
  // between also see "lost" and re-queue everything again.
  // (If the owner crashes between this SET and the UPDATE below, the full
  // re-queue is skipped; the stale-dispatch half still recovers in-flight work.)
  const epochLost = (await redis.set(REDIS_EPOCH_KEY, randomUUID(), 'NX')) === 'OK';

  // Claim and bump in one statement. For the stale-dispatch half, concurrent
  // replicas serialise on the row lock and the second re-evaluates its WHERE
  // against the bumped row (now 'queued'), so it no longer matches.
  const { rows } = await getPool().query<{ job: Job; attempt_no: number }>(
    `UPDATE delivery_attempt
        SET status = 'queued', status_rank = 0, attempt_no = attempt_no + 1, updated_at = now()
      WHERE recoverable
        AND job IS NOT NULL
        AND (
          ($1::boolean AND status IN ('queued', 'dispatching'))
          OR (status = 'dispatching' AND updated_at < now() - make_interval(secs => $2::numeric / 1000))
        )
      RETURNING job, attempt_no`,
    [epochLost, staleMs],
  );

  for (const row of rows) {
    await pushOther({ ...row.job, attempt: row.attempt_no - 1 });
  }

  if (rows.length > 0) console.log(`Recovered ${rows.length} job(s) (epochLost=${epochLost})`);
  return { epochLost, requeued: rows.length };
}
