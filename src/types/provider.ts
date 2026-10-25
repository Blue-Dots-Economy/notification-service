import { ZodType } from 'zod';
import type { Rendered } from '../lib/templates/render';
import type { Email_attachment } from '../lib/providers/email/sendMailCore';

export interface ProviderTemplateMap {
  [templateId: string]: string;
}

/**
 * Outcome of one provider send.
 *
 * The worker retries any failure up to `MAX_RETRIES` unless `retryable` is
 * `false`, which ends the delivery on the first attempt (dead-letter, drop or
 * fall-through), so a permanent misconfiguration surfaces at once.
 */
export interface ProviderSendResult {
  ok: boolean;
  error?: string;
  retryable?: boolean;
  /** Provider-side handle for the send, stored as delivery_attempt.provider_message_id. */
  provider_message_id?: string;
}

export interface ProviderSendArgs {
  to: string;
  template_id: string;
  variables: any;
  /**
   * Unrendered body template for providers that do not render (Pinnacle).
   * Resolved by the worker as `provider.bodies[key] ?? job.body`, so a provider
   * that names a template owns its text, and a raw pass-through id falls back to
   * the caller's body. MSG91 ignores it.
   */
  body?: string;
  /** Job id, forwarded as the provider's client-side unique id where supported. */
  job_id?: string;
}

/** Content NS already rendered and validated (Send API v1). */
export interface RenderedSendArgs {
  to: string;
  rendered: Rendered;
  providerTemplateId: string | null;
  /** Per-template DLT identifiers; a non-null value overrides the env config. */
  dlt?: {
    senderId?: string | null;
    dltEntityId?: string | null;
    dltHeaderId?: string | null;
    dltTagId?: string | null;
  };
  email?: { cc?: string[]; replyTo?: string; attachments?: Email_attachment[] };
  job_id?: string;
}

export interface ProviderDefinition {
  name: string;
  /**
   * The vendor behind this channel in this deployment ('smtp', 'msg91',
   * 'pinnacle', 'twilio'). DLT and Meta template ids are per vendor, so a
   * template whose vendor differs from the deployment's is refused, not sent.
   */
  vendor: string;
  /**
   * Who turns a template into the delivered text: 'ns' renders the stored body
   * here (email, Pinnacle); 'provider' sends an approved template id plus
   * variables and the vendor renders (MSG91 Flow, Twilio Content).
   */
  renders: 'ns' | 'provider';
  templates: ProviderTemplateMap;
  /**
   * Body text for the templates this provider names, keyed like `templates`
   * (e.g. `login_otp`). Only for providers that do not render (Pinnacle).
   *
   * The text must be byte-identical to the DLT-approved template: the operator
   * matches on it, and a drifted body is scrubbed downstream, not rejected.
   */
  bodies?: ProviderTemplateMap;
  /**
   * When true, a `template_id` not found in `templates` is passed through to the
   * provider verbatim as a raw provider-side id (SMS: callers send DLT flow ids
   * directly). Otherwise the template must be named in `templates` (email).
   */
  allowRawTemplateId?: boolean;
  schema: ZodType<any>;
  send: (payload: ProviderSendArgs) => Promise<ProviderSendResult>;
  /**
   * Send content NS already rendered and validated (Send API v1). Never re-render.
   * A rendered mode or channel this vendor cannot send is a permanent failure.
   */
  sendRendered?: (args: RenderedSendArgs) => Promise<ProviderSendResult>;
}
