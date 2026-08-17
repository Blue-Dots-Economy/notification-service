import { z } from 'zod';
import { ProviderDefinition } from '../../../types/provider';
import {
  attachmentMaxFiles,
  attachmentMaxTotalBytes,
  totalAttachmentBytes,
} from './attachments';
import { sendMail } from './sendMailCore';

const EmailAttachmentSchema = z.object({
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
};
