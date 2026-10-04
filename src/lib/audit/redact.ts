import type { Job } from 'src/types';
import type { AcceptedRecord } from './store';

/**
 * What a job persists. The one place this is decided.
 *
 * Realtime jobs carry OTP codes in their variables, and OTP codes are never
 * persisted (spec §Retention and PII): they keep the recipient and the variable
 * NAMES only, and no job copy — so they are also not recoverable after a Redis
 * loss, which is acceptable because the user simply requests a new code.
 *
 * The decision keys on `audit.redactValues`, set once at /notify from the
 * original priority, not on the job's current priority: a DLQ replay may move
 * an OTP job to 'other', and it must stay redacted. Jobs queued before the flag
 * existed fall back to the priority.
 */
export function toAcceptedRecord(job: Job, source: string): AcceptedRecord {
  if (!job.audit) throw new Error(`job ${job.job_id} has no audit ids`);
  const realtime = job.audit.redactValues ?? job.priority === 'realtime';
  return {
    ids: job.audit,
    network: process.env.NS_NETWORK ?? 'unknown',
    source,
    priority: job.priority,
    channel: job.channel,
    templateId: job.template_id,
    payload: realtime
      ? { to: job.to, variable_names: Object.keys(job.variables ?? {}) }
      : { to: job.to, variables: job.variables, ...(job.body ? { body: job.body } : {}) },
    job: realtime ? undefined : (job as unknown as Record<string, unknown>),
    recoverable: !realtime,
  };
}
