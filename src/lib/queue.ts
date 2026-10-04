import { randomUUID } from 'crypto';
import { Job } from 'src/types';
import redis from './redis';

// Queue Keys

const REALTIME_QUEUE = 'queue:realtime';
const OTHER_QUEUE = 'queue:other';
const RETRY_ZSET = 'queue:retry';
const DLQ_QUEUE = 'queue:dlq';

/**
 * DLQ replays allowed per job. Attempts reset on replay (a replay is an
 * operator saying "try again"), but replays themselves are counted and capped
 * so one job cannot be cycled through the providers indefinitely.
 */
export const MAX_REPLAYS = 3;

// Basic Queue Operations

/** Enqueue realtime job (high priority). */
export async function pushRealtime(job: Job) {
  return redis.lpush(REALTIME_QUEUE, JSON.stringify(job));
}

/** Enqueue fallback job. */
export async function pushOther(job: Job) {
  return redis.lpush(OTHER_QUEUE, JSON.stringify(job));
}

/**
 * Enqueue many fallback jobs in one MULTI round trip (recovery). Throws if
 * any push failed, so the caller can roll back what it recorded.
 */
export async function pushOtherMany(jobs: Job[]): Promise<void> {
  if (jobs.length === 0) return;
  const tx = redis.multi();
  for (const job of jobs) tx.lpush(OTHER_QUEUE, JSON.stringify(job));
  const results = await tx.exec();
  if (!results) throw new Error('Redis MULTI aborted while re-queueing');
  const failed = results.find(([err]) => err);
  if (failed) throw failed[0];
}

/** Pop from REALTIME queue. Timeout prevents starving lower-priority work. */
export async function popRealtime(timeoutSeconds = 1) {
  return redis.brpop(REALTIME_QUEUE, timeoutSeconds);
}

/** Pop from OTHER queue. Timeout keeps retries from waiting behind idle pops. */
export async function popOther(timeoutSeconds = 1) {
  return redis.brpop(OTHER_QUEUE, timeoutSeconds);
}

// Dead Letter Queue
export async function pushDLQ(job: Job) {
  console.log('DLQ →', job.job_id);
  return redis.lpush(DLQ_QUEUE, JSON.stringify(job));
}

type RetryFailedJobsOptions = {
  jobId?: string;
  limit?: number;
  priority?: 'realtime' | 'other';
};

function parseJob(raw: string): Job | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function requeueFailedJob(raw: string, priority: 'realtime' | 'other') {
  const job = parseJob(raw);
  if (!job) return null;

  const retryJob: Job = {
    ...job,
    priority,
    attempt: 0,
    next_attempt_at: undefined,
    replays: (job.replays ?? 0) + 1,
    // A replay is a new delivery attempt: it gets its own attempt id so its
    // status writes are not rejected as older than the stored failed attempt.
    ...(job.audit ? { audit: { ...job.audit, attemptId: randomUUID() } } : {}),
  };

  if (priority === 'realtime') await pushRealtime(retryJob);
  else await pushOther(retryJob);

  return retryJob;
}

function refuse(job: Job) {
  console.log('DLQ replay refused →', job.job_id, `replays=${job.replays ?? 0}`);
}

export async function retryFailedJobs({
  jobId,
  limit = 1,
  priority = 'other',
}: RetryFailedJobsOptions = {}) {
  const retried: string[] = [];
  const skipped: string[] = [];
  const refused: string[] = [];

  if (jobId) {
    const failedJobs = await redis.lrange(DLQ_QUEUE, 0, -1);
    const raw = failedJobs.find((item) => parseJob(item)?.job_id === jobId);

    if (!raw) return { retried, skipped, refused, not_found: [jobId] };

    const parsed = parseJob(raw);
    if (parsed && (parsed.replays ?? 0) >= MAX_REPLAYS) {
      refuse(parsed);
      return { retried, skipped, refused: [jobId], not_found: [] };
    }

    const removed = await redis.lrem(DLQ_QUEUE, 1, raw);
    if (removed === 0) return { retried, skipped, refused, not_found: [jobId] };

    const job = await requeueFailedJob(raw, priority);
    if (job) retried.push(job.job_id);
    else skipped.push(raw);

    return { retried, skipped, refused, not_found: [] };
  }

  // The DLQ is LPUSHed, so the oldest entry is at the tail: walk from the end.
  // Capped entries stay in place and are reported; each other entry is claimed
  // with LREM so a concurrent drain cannot hand the same job out twice.
  const entries = await redis.lrange(DLQ_QUEUE, 0, -1);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (retried.length + skipped.length >= limit) break;
    const raw = entries[i];
    const parsed = parseJob(raw);

    if (parsed && (parsed.replays ?? 0) >= MAX_REPLAYS) {
      refuse(parsed);
      refused.push(parsed.job_id);
      continue;
    }

    // Another drain took it first: skip silently.
    if ((await redis.lrem(DLQ_QUEUE, 1, raw)) === 0) continue;

    const job = await requeueFailedJob(raw, priority);
    if (job) retried.push(job.job_id);
    else skipped.push(raw);
  }

  return { retried, skipped, refused, not_found: [] };
}

// Retry Scheduling
/**
 * Schedule retry using a ZSET sorted by future timestamp.
 */
export async function scheduleRetry(job: Job, delaySeconds: number) {
  const timestamp = Date.now() + delaySeconds * 1000;

  return redis.zadd(RETRY_ZSET, timestamp.toString(), JSON.stringify(job));
}

/**
 * Schedule a retry and write its attempt marker in ONE MULTI, so the marker
 * exists if and only if the retry is in the set. Written separately, a crash
 * between the two would leave a `retry` marker for a job that was never
 * scheduled, and recovery would skip that job forever. Throws if any command
 * failed, like scheduleRetry.
 */
export async function scheduleRetryWithMarker(
  job: Job,
  delaySeconds: number,
  marker?: { key: string; value: string; ttlSeconds: number },
): Promise<void> {
  const timestamp = Date.now() + delaySeconds * 1000;
  const tx = redis.multi().zadd(RETRY_ZSET, timestamp.toString(), JSON.stringify(job));
  if (marker) tx.set(marker.key, marker.value, 'EX', marker.ttlSeconds);
  const results = await tx.exec();
  if (!results) throw new Error('Redis MULTI aborted while scheduling a retry');
  const failed = results.find(([err]) => err);
  if (failed) throw failed[0];
}

/**
 * Claim-and-remove of due retries, in one atomic step.
 *
 * ZRANGEBYSCORE then ZREM of exactly the members returned, inside a single Lua
 * script so no other client can interleave. The previous implementation issued
 * the read and a ZREMRANGEBYSCORE as two round trips (#51), which had two
 * failure modes:
 *
 *   - a retry written between the two calls with a score <= now was deleted
 *     without ever being returned — the job silently vanished, neither delivered,
 *     retried, nor dead-lettered. No concurrency was needed for this: a
 *     scheduleRetry with a small or non-positive delay during the read's round
 *     trip is enough.
 *   - two workers (which the deployment notes explicitly suggest for scale)
 *     could both complete the read before either deleted, so both returned the
 *     same jobs and both sent them.
 *
 * Deleting the exact members rather than the score range is the part that closes
 * the first mode; doing both in one EVAL closes the second.
 */
// A fixed, module-level script — Redis-side Lua via EVAL, not JavaScript eval().
// Nothing is interpolated into it: the key and the cutoff are passed as KEYS[1]
// and ARGV[1], so no caller-controlled value can become code.
const CLAIM_DUE_RETRIES = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], 0, ARGV[1])
if #due > 0 then
  redis.call('ZREM', KEYS[1], unpack(due))
end
return due
`;

export async function popScheduledRetries(): Promise<Job[]> {
  const now = Date.now();

  const results = (await redis.eval(
    CLAIM_DUE_RETRIES,
    1,
    RETRY_ZSET,
    now.toString(),
  )) as string[];

  if (!results || results.length === 0) return [];

  return results.map((raw) => JSON.parse(raw));
}

export async function getQueueMetrics() {
  const execResult = await redis
    .multi()
    .llen(REALTIME_QUEUE)
    .llen(OTHER_QUEUE)
    .zcard(RETRY_ZSET)
    .zrange(RETRY_ZSET, '0', '0', 'WITHSCORES') // oldest retry entry (string indices: ioredis 6 types zrange stop as string|Buffer)
    .llen(DLQ_QUEUE)
    .exec();

  if (!execResult) {
    return {
      realtime: 0,
      other: 0,
      retry_count: 0,
      retry_oldest: null,
      retry_eta_seconds: null,
      dlq: 0,
    };
  }

  const [
    [, realtime],
    [, other],
    [, retry_count],
    [, oldestRetryRaw],
    [, dlq],
  ] = execResult;

  // Handle empty retry zset
  let retry_oldest: number | null = null;
  let retry_eta_seconds: number | null = null;

  if (Array.isArray(oldestRetryRaw) && oldestRetryRaw.length === 2) {
    // The score is set by scheduleRetry as Date.now() + delay, i.e. epoch
    // MILLISECONDS — the old comment here said seconds, and retry_eta_seconds
    // was reported as the raw millisecond difference despite its name (a 30s
    // retry read as 30000). Convert for the *_seconds field; retry_oldest stays
    // the raw epoch-ms timestamp it has always been.
    const scoreMs = Number(oldestRetryRaw[1]);
    retry_oldest = scoreMs;

    retry_eta_seconds = Math.max(0, Math.round((scoreMs - Date.now()) / 1000));
  }

  return {
    realtime,
    other,
    retry_count,
    retry_oldest,
    retry_eta_seconds,
    dlq,
  };
}
