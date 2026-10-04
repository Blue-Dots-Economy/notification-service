import { sql, type SQL } from 'drizzle-orm';
import type { Priority } from 'src/types';
import { getDb } from '../db/client';
import type { AttemptStatus, DeliveryMode } from '../db/partitioned';
import { ATTEMPT_RANK, eventStatusFor } from './status';

export interface AuditIds {
  eventId: string;
  attemptId: string;
  /** ISO timestamp; part of both primary keys, so it travels with the job. */
  createdAt: string;
  correlationId: string;
  /**
   * Persist variable NAMES only, never values, and keep no job copy. Fixed at
   * /notify from the ORIGINAL priority (true for realtime) and carried on the
   * job, so a DLQ replay under another priority still never persists an OTP.
   * Optional only for jobs queued before the flag existed.
   */
  redactValues?: boolean;
  /** Absent = `single`. `all` events roll their status up across attempts. */
  deliveryMode?: DeliveryMode;
  /** Variable NAMES of a redacted send (its job carries no values). */
  variableNames?: string[];
}

export interface AcceptedRecord {
  ids: AuditIds;
  network: string;
  source: string;
  priority: Priority;
  channel: string;
  templateId: string;
  traceId?: string;
  /** Redacted request payload. Realtime: variable NAMES only, never values. */
  payload: Record<string, unknown>;
  /** The queued job, kept only when recoverable (normal priority). */
  job?: Record<string, unknown>;
  recoverable: boolean;
}

export interface AttemptUpdate {
  status: AttemptStatus;
  attemptNo: number;
  providerMessageId?: string;
  error?: string;
}

/** Persisted error strings are bounded: provider errors are not ours to size. */
export const MAX_ERROR_LENGTH = 500;

export function capError(error: string | undefined): string | null {
  if (error === undefined || error === null) return null;
  return error.length > MAX_ERROR_LENGTH ? error.slice(0, MAX_ERROR_LENGTH) : error;
}

function insertEvent(rec: AcceptedRecord, status: string) {
  return sql`
    INSERT INTO notification_event
      (id, created_at, correlation_id, trace_id, template_key, network, source, priority, status, payload, delivery_mode)
    VALUES
      (${rec.ids.eventId}, ${rec.ids.createdAt}, ${rec.ids.correlationId}, ${rec.traceId ?? null},
       ${rec.templateId}, ${rec.network}, ${rec.source}, ${rec.priority}, ${status},
       ${JSON.stringify(rec.payload)}::jsonb, ${rec.ids.deliveryMode ?? 'single'})
    ON CONFLICT (id, created_at) DO NOTHING`;
}

function insertAttempt(rec: AcceptedRecord) {
  return sql`
    INSERT INTO delivery_attempt
      (id, created_at, notification_event_id, channel, template_id, attempt_no,
       status, status_rank, recoverable, job)
    VALUES
      (${rec.ids.attemptId}, ${rec.ids.createdAt}, ${rec.ids.eventId}, ${rec.channel},
       ${rec.templateId}, 1, 'queued', ${ATTEMPT_RANK.queued}, ${rec.recoverable},
       ${rec.job ? JSON.stringify(rec.job) : null}::jsonb)
    ON CONFLICT (id, created_at) DO NOTHING`;
}

/** Event `accepted` + attempt `queued` (attempt 1), atomically. Replay-safe. */
export async function recordAccepted(rec: AcceptedRecord): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(insertEvent(rec, 'accepted'));
    await tx.execute(insertAttempt(rec));
  });
}

/** One event, one attempt per delivery, atomically. Replay-safe. */
export async function recordAcceptedMany(records: AcceptedRecord[]): Promise<void> {
  if (records.length === 0) return;
  // One event row is written from records[0]; a record for another event or
  // timestamp would hang its attempt off the wrong (or a missing) event.
  const { eventId, createdAt } = records[0]!.ids;
  if (records.some((r) => r.ids.eventId !== eventId || r.ids.createdAt !== createdAt)) {
    throw new Error('recordAcceptedMany: records must share one eventId and createdAt');
  }
  await getDb().transaction(async (tx) => {
    await tx.execute(insertEvent(records[0]!, 'accepted'));
    for (const rec of records) await tx.execute(insertAttempt(rec));
  });
}

/**
 * Move an attempt (and its event) forward. Inserts the rows if the accepted
 * record has not landed yet; never moves either backwards.
 */
export async function upsertAttempt(rec: AcceptedRecord, u: AttemptUpdate): Promise<void> {
  const rank = ATTEMPT_RANK[u.status];
  const terminal = rank >= ATTEMPT_RANK.delivered;
  await getDb().transaction(async (tx) => {
    await tx.execute(insertEvent(rec, 'accepted'));
    await tx.execute(sql`
      INSERT INTO delivery_attempt
        (id, created_at, notification_event_id, channel, template_id, attempt_no,
         status, status_rank, recoverable, job, provider_message_id, error,
         dispatched_at, completed_at)
      VALUES
        (${rec.ids.attemptId}, ${rec.ids.createdAt}, ${rec.ids.eventId}, ${rec.channel},
         ${rec.templateId}, ${u.attemptNo}, ${u.status}, ${rank}, ${rec.recoverable},
         ${rec.job ? JSON.stringify(rec.job) : null}::jsonb,
         ${u.providerMessageId ?? null}, ${capError(u.error)},
         ${u.status === 'dispatching' ? sql`now()` : null},
         ${terminal ? sql`now()` : null})
      ON CONFLICT (id, created_at) DO UPDATE SET
        attempt_no          = EXCLUDED.attempt_no,
        status              = EXCLUDED.status,
        status_rank         = EXCLUDED.status_rank,
        provider_message_id = COALESCE(EXCLUDED.provider_message_id, delivery_attempt.provider_message_id),
        error               = EXCLUDED.error,
        dispatched_at       = COALESCE(EXCLUDED.dispatched_at, delivery_attempt.dispatched_at),
        completed_at        = EXCLUDED.completed_at,
        updated_at          = now()
      WHERE (EXCLUDED.attempt_no, EXCLUDED.status_rank)
          > (delivery_attempt.attempt_no, delivery_attempt.status_rank)`);
    // Same transaction, after the attempt upsert (see rollUpEvent).
    if (rec.ids.deliveryMode === 'all' || rec.ids.deliveryMode === 'first_available') {
      await rollUpEvent(tx, rec.ids.eventId, rec.ids.createdAt);
      return;
    }
    await tx.execute(sql`
      UPDATE notification_event e
         SET status = ${eventStatusFor(u.status)}, updated_at = now()
        FROM delivery_attempt a
       WHERE e.id = ${rec.ids.eventId} AND e.created_at = ${rec.ids.createdAt}
         AND a.id = ${rec.ids.attemptId} AND a.created_at = ${rec.ids.createdAt}
         AND a.status = ${u.status} AND a.attempt_no = ${u.attemptNo}`);
  });
}

/** Anything that runs a drizzle `sql` query: a drizzle transaction, or recovery's adapter. */
export interface SqlExecutor {
  execute(query: SQL): Promise<unknown>;
}

/**
 * Recompute a multi-attempt event's status from all of its attempts. Call it
 * inside the transaction that changed an attempt, after that change.
 *
 * Writers on sibling attempts serialise on the event row lock. Taking it in its
 * own statement first means the roll-up statement's (READ COMMITTED) snapshot
 * is taken after the other writer committed, so it sees that writer's attempt.
 * Callers that roll up several events in one transaction must call this in a
 * stable (sorted) event order, so two such callers cannot deadlock.
 *
 * - `all`: every attempt counts; mixed terminal outcomes → partially_delivered.
 * - `first_available` (and a `single` event, whose replays add attempts):
 *   delivered / sent if ANY attempt reached it — so a late failure of an
 *   earlier attempt never moves a sent event back to failed — otherwise the
 *   status of the latest attempt. Attempts share created_at (the partition
 *   key) and have random ids, so "latest" is: an open attempt (completed_at
 *   NULL; fall-through closes an attempt before it opens the next) first,
 *   then the most recently completed, then updated_at, then id.
 */
export async function rollUpEvent(tx: SqlExecutor, eventId: string, createdAt: string): Promise<void> {
  await tx.execute(sql`
    SELECT 1 FROM notification_event
     WHERE id = ${eventId} AND created_at = ${createdAt}
       FOR UPDATE`);
  await tx.execute(sql`
    UPDATE notification_event e
       SET status = CASE WHEN e.delivery_mode = 'all' THEN r.all_status ELSE r.latest_status END,
           updated_at = now()
    FROM (
      SELECT
        CASE
          WHEN bool_or(a.status IN ('queued','dispatching')) THEN
            CASE WHEN bool_or(a.status = 'dispatching' OR a.status IN ('sent','accepted_by_provider','delivered'))
                 THEN 'dispatching' ELSE 'accepted' END
          WHEN bool_and(a.status IN ('sent','accepted_by_provider','delivered')) THEN
            CASE WHEN bool_and(a.status = 'delivered') THEN 'delivered' ELSE 'sent' END
          WHEN bool_and(a.status IN ('failed','bounced','expired')) THEN
            CASE WHEN bool_and(a.status = 'expired') THEN 'expired' ELSE 'failed' END
          ELSE 'partially_delivered'
        END AS all_status,
        CASE
          WHEN bool_or(a.status = 'delivered') THEN 'delivered'
          WHEN bool_or(a.status IN ('sent','accepted_by_provider')) THEN 'sent'
          ELSE (
            SELECT CASE l.status
                     WHEN 'queued' THEN 'accepted'
                     WHEN 'dispatching' THEN 'dispatching'
                     WHEN 'expired' THEN 'expired'
                     ELSE 'failed'
                   END
              FROM delivery_attempt l
             WHERE l.notification_event_id = ${eventId} AND l.created_at = ${createdAt}
             ORDER BY l.completed_at DESC NULLS FIRST, l.updated_at DESC, l.id DESC
             LIMIT 1)
        END AS latest_status
      FROM delivery_attempt a
      WHERE a.notification_event_id = ${eventId} AND a.created_at = ${createdAt}
      HAVING count(*) > 0
    ) r
    WHERE e.id = ${eventId} AND e.created_at = ${createdAt}
      AND (CASE WHEN e.delivery_mode = 'all' THEN r.all_status ELSE r.latest_status END) IS NOT NULL`);
}
