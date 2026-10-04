import type { Job } from 'src/types';
import * as metrics from '../metrics';
import { toAcceptedRecord } from './redact';
import { upsertAttempt, type AttemptUpdate } from './store';

/**
 * Best-effort status write from the worker. A database problem must never
 * fail, delay or re-route a send, so this never throws; failures are counted
 * (ns_audit_write_failures_total) so a silent audit gap is still alertable.
 *
 * Record building sits inside the guard too: a malformed job is an audit gap,
 * not a reason to lose the send.
 */
export async function stamp(job: Job, update: AttemptUpdate): Promise<void> {
  if (!job.audit) return;
  try {
    await upsertAttempt(toAcceptedRecord(job, 'worker'), update);
  } catch (err) {
    try {
      await metrics.incr('ns_audit_write_failures_total', { stage: update.status });
      console.log(`Audit write failed for ${job.job_id} (${update.status}):`, err instanceof Error ? err.message : err);
    } catch {
      /* best-effort */
    }
  }
}
