import type { Job } from 'src/types';

export function urgentDefaultDeadlineS(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.URGENT_DEFAULT_DEADLINE_S;
  if (raw === undefined || raw === '') return 600;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`URGENT_DEFAULT_DEADLINE_S must be a positive integer, got '${raw}'`);
  return n;
}

export function isExpired(job: Job, now = Date.now()): boolean {
  return job.deadline !== undefined && now > job.deadline;
}

/** True if something scheduled `delayMs` from now would run after the deadline. */
export function wouldExpire(job: Job, delayMs: number, now = Date.now()): boolean {
  return job.deadline !== undefined && now + delayMs > job.deadline;
}

/** OTP-class jobs: never persisted with values, never dead-lettered. Sticky (Plan A R15). */
export function isRedacted(job: Job): boolean {
  return job.audit?.redactValues ?? job.priority === 'realtime';
}
