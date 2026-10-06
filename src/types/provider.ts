import type { Rendered } from '../lib/templates/render';
import type { Email_attachment } from '../lib/providers/email/sendMailCore';

/**
 * Outcome of one provider send.
 *
 * `retryable` is the important field: the worker's default is to retry any
 * failure up to `MAX_RETRIES`, which is right for a timeout and wrong for
 * "that template id does not exist". A provider that can tell the difference
 * sets `retryable: false` and the worker dead-letters immediately, so a
 * permanent misconfiguration surfaces in one attempt instead of five.
 * Leaving it undefined means retry.
 */
export interface ProviderSendResult {
  ok: boolean;
  error?: string;
  retryable?: boolean;
  /** Provider-side handle for the send, used later to match delivery receipts. */
  provider_message_id?: string;
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
  /**
   * Send content NS already rendered and validated (Send API v1). Never re-render.
   * A rendered mode or channel this vendor cannot send is a permanent failure.
   */
  sendRendered: (args: RenderedSendArgs) => Promise<ProviderSendResult>;
}
