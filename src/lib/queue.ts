import { Job } from 'src/types';
import redis from './redis';

// Queue Keys

const REALTIME_QUEUE = 'queue:realtime';
const OTHER_QUEUE = 'queue:other';
const RETRY_ZSET = 'queue:retry';
const DLQ_QUEUE = 'queue:dlq';

// Basic Queue Operations

/** Enqueue realtime job (high priority). */
export async function pushRealtime(job: Job) {
  return redis.lpush(REALTIME_QUEUE, JSON.stringify(job));
}

/** Enqueue fallback job. */
export async function pushOther(job: Job) {
  return redis.lpush(OTHER_QUEUE, JSON.stringify(job));
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
  };

  if (priority === 'realtime') await pushRealtime(retryJob);
  else await pushOther(retryJob);

  return retryJob;
}

export async function retryFailedJobs({
  jobId,
  limit = 1,
  priority = 'other',
}: RetryFailedJobsOptions = {}) {
  const retried: string[] = [];
  const skipped: string[] = [];

  if (jobId) {
    const failedJobs = await redis.lrange(DLQ_QUEUE, 0, -1);
    const raw = failedJobs.find((item) => parseJob(item)?.job_id === jobId);

    if (!raw) return { retried, skipped, not_found: [jobId] };

    const removed = await redis.lrem(DLQ_QUEUE, 1, raw);
    if (removed === 0) return { retried, skipped, not_found: [jobId] };

    const job = await requeueFailedJob(raw, priority);
    if (job) retried.push(job.job_id);
    else skipped.push(raw);

    return { retried, skipped, not_found: [] };
  }

  for (let i = 0; i < limit; i += 1) {
    const raw = await redis.rpop(DLQ_QUEUE);
    if (!raw) break;

    const job = await requeueFailedJob(raw, priority);
    if (job) retried.push(job.job_id);
    else skipped.push(raw);
  }

  return { retried, skipped, not_found: [] };
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
 * Pop due retry jobs:
 * - Fetch jobs where timestamp <= NOW
 * - Remove them atomically
 */
export async function popScheduledRetries(): Promise<Job[]> {
  const now = Date.now();

  // Step 1: get due jobs
  const results = await redis.zrangebyscore(RETRY_ZSET, 0, now);

  if (results.length === 0) return [];

  // Step 2: remove fetched jobs
  await redis.zremrangebyscore(RETRY_ZSET, 0, now);

  // Step 3: Deserialize to Job[]
  return results.map((raw) => JSON.parse(raw));
}

export async function getQueueMetrics() {
  const execResult = await redis
    .multi()
    .llen(REALTIME_QUEUE)
    .llen(OTHER_QUEUE)
    .zcard(RETRY_ZSET)
    .zrange(RETRY_ZSET, 0, 0, 'WITHSCORES') // oldest retry entry
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
