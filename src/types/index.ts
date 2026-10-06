/** Internal priority. Public API names (Plan C2): urgent → realtime, normal → other, bulk → bulk. */
export type Priority = 'realtime' | 'other' | 'bulk';

export interface Job {
  job_id: string;
  channel: string;
  priority: Priority;
  to: string;
  /** The template key of the current delivery; the audit row's template_id. */
  template_id: string;
  /** Request variables for the audit payload ({} when redacted). The worker never sends them. */
  variables: any;
  /** Written only by legacy /notify, which still records it in the audit payload. */
  body?: string;
  attempt?: number; // number of tries so far
  next_attempt_at?: number; // timestamp of when to retry
  /** Audit identity, assigned at /notify and carried to every status write. */
  audit?: import('../lib/audit/store').AuditIds;
  /** Times this job has been replayed from the DLQ (capped; see queue.ts). */
  replays?: number;
  /** Absolute epoch-ms deadline. Past it the job is never sent: terminal `expired`. */
  deadline?: number;
  /** Send API v1: pre-rendered deliveries, tried in order (first_available) or one per job (all). */
  v1?: {
    mode: import('../lib/db/partitioned').DeliveryMode;
    deliveries: import('../lib/send/plan').PlannedDelivery[];
    index: number;
    email?: { cc?: string[]; replyTo?: string; attachments?: import('../lib/providers/email/sendMailCore').Email_attachment[] };
  };
}
