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

export interface Job {
  job_id: string;
  channel: string;
  priority: 'realtime' | 'other';
  to: string;
  template_id: string;
  variables: any;
  body?: string;
  attempt?: number; // number of tries so far
  next_attempt_at?: number; // timestamp of when to retry
}
