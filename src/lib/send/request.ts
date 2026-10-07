import { z } from 'zod';
import type { Priority } from 'src/types';
import { EmailAttachmentSchema } from '../providers/email/mailer';
import { attachmentMaxFiles, attachmentMaxTotalBytes, totalAttachmentBytes } from '../providers/email/attachments';

const Slug = (max: number) => z.string().regex(/^[a-z0-9_.-]+$/).max(max);
const E164 = /^\+[1-9]\d{6,14}$/;

export const PRIORITY_MAP: Record<'urgent' | 'normal' | 'bulk', Priority> = {
  urgent: 'realtime',
  normal: 'other',
  bulk: 'bulk',
};

export const V1NotifySchema = z
  .object({
    event_type: Slug(64).optional(),
    template_key: Slug(128).optional(),
    channel: z.string().min(1).max(32).optional(),
    domain: Slug(64).optional(),
    to: z
      .object({ email: z.email().max(254).optional(), phone: z.string().regex(E164).optional() })
      .strict()
      .refine((t) => Boolean(t.email || t.phone), { message: 'at least one contact point is required' }),
    locale: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/).optional(),
    variables: z.record(z.string(), z.unknown()).default({}),
    priority: z.enum(['urgent', 'normal', 'bulk']).default('normal'),
    idempotency_key: z.string().min(1).max(128).optional(),
    deadline: z.iso.datetime({ offset: true }).optional(),
    correlation_id: z.string().trim().max(128).optional(),
    cc: z.array(z.email()).max(10).optional(),
    reply_to: z.email().optional(),
    attachments: z.array(EmailAttachmentSchema).optional(),
  })
  .strict()
  .refine((b) => Boolean(b.event_type) !== Boolean(b.template_key), {
    message: 'exactly one of event_type or template_key is required',
  })
  .refine((b) => !b.template_key || Boolean(b.channel), { message: 'template_key requires channel', path: ['channel'] })
  .refine((b) => !b.event_type || !b.channel, { message: 'channel is chosen by policy for event_type', path: ['channel'] })
  .refine(
    (b) => !b.template_key || b.channel === 'email' || (!b.cc && !b.reply_to && !b.attachments),
    { message: 'cc, reply_to and attachments apply to email only', path: ['channel'] },
  )
  .refine((b) => (b.attachments ?? []).length <= attachmentMaxFiles(), { path: ['attachments'], error: () => `at most ${attachmentMaxFiles()} attachments are accepted` })
  .refine((b) => totalAttachmentBytes(b.attachments) <= attachmentMaxTotalBytes(), { path: ['attachments'], error: () => `attachments exceed the ${attachmentMaxTotalBytes()} byte total limit` });

export type V1Request = z.infer<typeof V1NotifySchema>;

const MAX_DEADLINE_MS = 24 * 60 * 60 * 1000;

export function parseDeadline(iso: string | undefined, now = Date.now()): number | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  if (at <= now) throw new RangeError('deadline must be in the future');
  if (at - now > MAX_DEADLINE_MS) throw new RangeError('deadline must be within 24 hours');
  return at;
}
