export interface NotifyRequest {
  channel: string;
  to: string;
  template_id: string;
  priority?: 'realtime' | 'other';
  variables: any;
  dedupe_id?: string;
  /**
   * Optional body template for providers that do not render (Pinnacle SMS);
   * ignored by the others. Only used for a raw pass-through `template_id`: a
   * template the provider names uses its own body (`ProviderDefinition.bodies`).
   */
  body?: string;
}

/** Internal priority. Send API v1 names: urgent → realtime, normal → other, bulk → bulk. */
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
  next_attempt_at?: number; // never set; the retry time is the queue:retry score
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
