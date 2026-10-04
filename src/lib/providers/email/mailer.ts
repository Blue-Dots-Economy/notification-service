import { z } from 'zod';
import { ProviderDefinition } from '../../../types/provider';
import {
  attachmentMaxFiles,
  attachmentMaxTotalBytes,
  totalAttachmentBytes,
} from './attachments';
import { sendMail } from './sendMailCore';

export const EmailAttachmentSchema = z.object({
  /** Shown to the recipient and used as the MIME filename. */
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(127),
  /**
   * Base64-encoded file content, no `data:` prefix.
   *
   * Validated as base64 rather than any non-empty string: the decoder silently
   * ignores characters outside the alphabet, so a malformed or `data:`-prefixed
   * payload would pass the 400 boundary and be delivered as garbage bytes. The
   * calling APIs compact whitespace before forwarding, so wrapped base64 from a
   * client arrives here already canonical.
   */
  data: z.base64().min(1),
});

export const emailProvider: ProviderDefinition = {
  name: 'email',
  vendor: 'smtp',
  renders: 'ns',

  templates: {
    basic_email: 'BASIC_EMAIL',
    login_otp: 'LOGIN_OTP_1',
  },

  // The count/size limits are refinements rather than `.max()`/inline checks
  // because both bounds are env-configurable and therefore only knowable at
  // request time. `z.toJSONSchema` (used by the /providers docs route) drops
  // refinements silently, so the published schema stays valid.
  schema: z
    .object({
      fromName: z.string(),
      fromEmail: z.email(),
      subject: z.string(),
      html: z.string(),
      replyTo: z.email().optional(),
      attachments: z.array(EmailAttachmentSchema).optional(),
    })
    .refine((v) => (v.attachments ?? []).length <= attachmentMaxFiles(), {
      path: ['attachments'],
      error: () => `at most ${attachmentMaxFiles()} attachments are accepted`,
    })
    .refine((v) => totalAttachmentBytes(v.attachments) <= attachmentMaxTotalBytes(), {
      path: ['attachments'],
      error: () => `attachments exceed the ${attachmentMaxTotalBytes()} byte total limit`,
    }),

  async send({ to, template_id, variables }) {
    const ok = await sendMail({ to, ...variables, template_id });
    return ok;
  },

  async sendRendered({ to, rendered, email }) {
    if (rendered.mode !== 'ns' || !('subject' in rendered)) {
      return { ok: false, retryable: false, error: 'rendered mode not supported by smtp' };
    }
    const fromEmail = process.env.EMAIL_FROM_ADDRESS?.trim();
    if (!fromEmail) return { ok: false, retryable: false, error: 'email sender not configured' };
    if (!rendered.html && !rendered.text) {
      return { ok: false, retryable: false, error: 'email has no body' };
    }
    const res = await sendMail({
      to,
      fromEmail,
      fromName: process.env.EMAIL_FROM_NAME?.trim() || fromEmail,
      subject: rendered.subject,
      ...(rendered.html ? { html: rendered.html } : {}),
      ...(rendered.text ? { text: rendered.text } : {}),
      ...(email?.replyTo ? { replyTo: email.replyTo } : {}),
      ...(email?.cc?.length ? { cc: email.cc.join(',') } : {}),
      ...(email?.attachments?.length ? { attachments: email.attachments } : {}),
    });
    return res.ok ? { ok: true } : { ok: false, retryable: true, error: 'email send failed' };
  },
};
