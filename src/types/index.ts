export interface NotifyRequest {
  channel: string;
  to: string;
  template_id: string;
  priority?: 'realtime' | 'other';
  variables: any;
  dedupe_id?: string;
  /**
   * Optional message body template, for providers that do not render
   * server-side (Pinnacle SMS). Ignored by providers that do (MSG91 renders
   * from the DLT flow; SES renders from the email template).
   *
   * Only needed for a RAW pass-through `template_id` — when the provider names
   * the template it owns the body too (`ProviderDefinition.bodies`), which is
   * why the OTP callers need no change.
   */
  body?: string;
}

/** Internal priority. Public API names (Plan C2): urgent → realtime, normal → other, bulk → bulk. */
export type Priority = 'realtime' | 'other' | 'bulk';

export interface Job {
  job_id: string;
  channel: string;
  priority: Priority;
  to: string;
  template_id: string;
  variables: any;
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
