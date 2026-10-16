import type { AttemptStatus, EventStatus } from '../db/partitioned';

/**
 * Rank within one attempt number. A write is applied only when
 * (attempt_no, rank) is strictly greater than what is stored, so late or
 * replayed writes can never move a record backwards — which is what makes the
 * realtime path's fire-and-forget insert safe to race the worker.
 */
export const ATTEMPT_RANK: Record<AttemptStatus, number> = {
  queued: 0,
  dispatching: 1,
  sent: 2,
  accepted_by_provider: 3,
  delivered: 4,
  bounced: 4,
  failed: 4,
  expired: 4,
};

/** Event status for a single-attempt event (all Plan A events have exactly one). */
export function eventStatusFor(a: AttemptStatus): EventStatus {
  switch (a) {
    case 'queued': return 'accepted';
    case 'dispatching': return 'dispatching';
    case 'sent':
    case 'accepted_by_provider': return 'sent';
    case 'delivered': return 'delivered';
    case 'bounced':
    case 'failed': return 'failed';
    case 'expired': return 'expired';
  }
}
