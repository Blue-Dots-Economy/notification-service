import { ZodType } from 'zod';

export interface ProviderTemplateMap {
  [templateId: string]: string;
}

/**
 * Outcome of one provider send.
 *
 * `retryable` is the important field: the worker's default is to retry any
 * failure up to `MAX_RETRIES`, which is right for a timeout and wrong for
 * "that template id does not exist". A provider that can tell the difference
 * sets `retryable: false` and the worker dead-letters immediately, so a
 * permanent misconfiguration surfaces in one attempt instead of five.
 * Leaving it undefined keeps the old retry-everything behaviour.
 */
export interface ProviderSendResult {
  ok: boolean;
  error?: string;
  retryable?: boolean;
  /** Provider-side handle for the send, used later to match delivery receipts. */
  provider_message_id?: string;
}

export interface ProviderSendArgs {
  to: string;
  template_id: string;
  variables: any;
  /**
   * Message body TEMPLATE (not yet rendered) for providers that do not render
   * server-side. Resolved by the worker as `provider.bodies[key] ?? job.body`,
   * so a provider that names a template owns its text, and a raw pass-through
   * id falls back to whatever the caller supplied. Undefined for MSG91, which
   * renders from the DLT flow itself.
   */
  body?: string;
  /** Job id, forwarded as the provider's client-side unique id where supported. */
  job_id?: string;
}

export interface ProviderDefinition {
  name: string;
  /**
   * The vendor behind this channel in this deployment ('smtp', 'msg91',
   * 'pinnacle', 'twilio'). Templates are registered against a vendor — DLT and
   * Meta template ids are per vendor — so a template whose vendor differs from
   * the deployment's is refused rather than sent.
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
   * Body text for the templates this provider NAMES, keyed by the same public
   * key as `templates` (e.g. `login_otp`). Only meaningful for providers that
   * do not render server-side — Pinnacle wants final text, MSG91 does not.
   *
   * The text must be byte-identical to the DLT-approved template registered
   * for the sending entity, because the operator matches on it: a body that
   * has drifted is scrubbed downstream rather than rejected upfront.
   */
  bodies?: ProviderTemplateMap;
  /**
   * When true, a `template_id` not found in `templates` is passed through to the
   * provider verbatim (treated as a raw provider-side template id). Lets the
   * caller own the id map — e.g. SMS, where signalstack sends the DLT-approved
   * MSG91 flow id directly (#532/#535). Default (undefined/false) keeps the
   * strict allowlist, so email must still name a known template.
   */
  allowRawTemplateId?: boolean;
  schema: ZodType<any>;
  send: (payload: ProviderSendArgs) => Promise<ProviderSendResult>;
}
