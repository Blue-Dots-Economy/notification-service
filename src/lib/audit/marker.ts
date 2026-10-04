import redis from '../redis';
import type { Job } from 'src/types';

/**
 * Attempt markers: the worker's own note of a job's fate, written to Redis
 * right after the fate is decided and BEFORE the Postgres stamp.
 *
 * A stamp can fail (best-effort) and leave the row `dispatching`; without a
 * marker the stale-dispatch sweep would re-send a message that was already
 * sent. Recovery reads the marker first and records the marked state instead
 * of re-queueing. A double failure (stamp fails AND Redis loses the marker)
 * can still re-send — delivery is at-least-once.
 *
 * Value is `<fate>:<attemptNo>`, where attemptNo is the attempt number the
 * matching stamp would write (`retry` stamps the NEXT attempt as queued), so a
 * marker left by an earlier attempt never masks a later attempt's crash.
 */
export type AttemptFate = 'sent' | 'retry' | 'failed';

export const ATTEMPT_MARKER_TTL_SECONDS = 7 * 24 * 60 * 60;

export function attemptMarkerKey(attemptId: string): string {
  return `ns:attempt:${attemptId}`;
}

/** Best-effort: never throws, so it can never change a send's outcome. */
export async function markAttempt(job: Job, fate: AttemptFate, attemptNo: number): Promise<void> {
  const attemptId = job.audit?.attemptId;
  if (!attemptId) return;
  try {
    await redis.set(attemptMarkerKey(attemptId), `${fate}:${attemptNo}`, 'EX', ATTEMPT_MARKER_TTL_SECONDS);
  } catch (err) {
    console.log(`Attempt marker write failed for ${job.job_id}:`, err instanceof Error ? err.message : String(err));
  }
}

export interface AttemptMarker {
  fate: AttemptFate;
  attemptNo: number;
}

function parse(raw: string | null): AttemptMarker | undefined {
  if (!raw) return undefined;
  const m = /^(sent|retry|failed):(\d+)$/.exec(raw);
  return m ? { fate: m[1] as AttemptFate, attemptNo: Number(m[2]) } : undefined;
}

/** One MGET for a batch of attempt ids. Throws on a Redis failure. */
export async function readAttemptMarkers(attemptIds: string[]): Promise<Map<string, AttemptMarker>> {
  const out = new Map<string, AttemptMarker>();
  if (attemptIds.length === 0) return out;
  const values = await redis.mget(...attemptIds.map(attemptMarkerKey));
  attemptIds.forEach((id, i) => {
    const m = parse(values[i] ?? null);
    if (m) out.set(id, m);
  });
  return out;
}
