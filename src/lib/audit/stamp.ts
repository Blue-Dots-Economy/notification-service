import type { Job } from 'src/types';
import * as metrics from '../metrics';
import { describeDbError } from '../db/errors';
import { toAcceptedRecord } from './redact';
import { upsertAttempt, type AttemptUpdate } from './store';

/**
 * Best-effort status write from the worker. A database problem must never
 * fail, delay or re-route a send, so this never throws; failures are counted
 * (ns_audit_write_failures_total) so a silent audit gap is still alertable.
 *
 * Realtime jobs are not awaited, so a slow database cannot delay an OTP.
 * Other priorities await, bounded by the pool's connect/query timeouts.
 * Record building sits inside the guard too: a malformed job is an audit gap,
 * not a reason to lose the send.
 */
export async function stamp(job: Job, update: AttemptUpdate): Promise<void> {
  if (!job.audit) return;
  let urgent = false;
  try {
    urgent = job.priority === 'realtime';
  } catch {
    /* malformed job: fall through; write_ records the failure */
  }
  const write = write_(job, update);
  // Realtime (OTP) sends are latency-critical: start the write and move on.
  // `write_` never rejects, so there is no unhandled rejection to worry about.
  if (urgent) return;
  await write;
}

async function write_(job: Job, update: AttemptUpdate): Promise<void> {
  try {
    // upsertAttempt caps `error` at MAX_ERROR_LENGTH before it is persisted.
    await upsertAttempt(toAcceptedRecord(job, 'worker'), update);
  } catch (err) {
    try {
      await metrics.incr('ns_audit_write_failures_total', { stage: update.status });
      console.log(`Audit write failed for ${job.job_id} (${update.status}):`, describeDbError(err));
    } catch {
      /* best-effort */
    }
  }
}
