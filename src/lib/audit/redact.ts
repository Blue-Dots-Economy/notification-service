import type { Job } from 'src/types';
import type { AcceptedRecord } from './store';
import { decodedBase64Length } from '../providers/email/attachments';

/**
 * Email attachments are file bodies, not audit data: the persisted payload
 * keeps filename, contentType and size only. The job copy keeps them intact,
 * because recovery re-pushes that copy.
 */
function withoutAttachmentBodies(channel: string, variables: unknown): unknown {
  if (channel !== 'email' || !variables || typeof variables !== 'object') return variables;
  const v = variables as Record<string, unknown>;
  if (!Array.isArray(v.attachments)) return variables;
  return {
    ...v,
    attachments: v.attachments.map((a) => {
      if (!a || typeof a !== 'object') return a;
      const { data, content, ...meta } = a as Record<string, unknown>;
      const body = typeof data === 'string' ? data : typeof content === 'string' ? content : undefined;
      return body === undefined ? meta : { ...meta, size: decodedBase64Length(body) };
    }),
  };
}

/**
 * An OTP template: `otp` as a whole token of the template id (`login_otp`,
 * `otp.login`, `guardian-otp`), case-insensitive. Raw provider ids (DLT flow
 * ids) carry no name, so an OTP sent under one is redacted only via
 * `priority: 'realtime'`.
 */
export function isOtpTemplate(templateId: unknown): boolean {
  return typeof templateId === 'string' && /(^|[._-])otp($|[._-])/i.test(templateId);
}

/**
 * What a job persists. The one place this is decided.
 *
 * Redacted jobs may carry OTP codes, which are never persisted: they keep the
 * recipients and the variable names only, and no job copy, so they are not
 * recoverable after a Redis loss (the user requests a new code).
 *
 * The decision keys on `audit.redactValues`, set once at accept, not on the
 * job's current priority: a DLQ replay may move a job to 'other', and it must
 * stay redacted. Without the flag the priority decides. An OTP template is
 * redacted whatever the flag or priority says.
 */
export function toAcceptedRecord(job: Job, source: string): AcceptedRecord {
  if (!job.audit) throw new Error(`job ${job.job_id} has no audit ids`);
  const realtime =
    (job.audit.redactValues ?? job.priority === 'realtime') || isOtpTemplate(job.template_id);
  const to = job.audit.recipients ?? job.to;
  // References (key, version, locale), never content values: recorded on redacted sends too.
  const contentRefs =
    job.audit.contentRefs && Object.keys(job.audit.contentRefs).length ? { content_refs: job.audit.contentRefs } : {};
  return {
    ids: job.audit,
    network: process.env.NS_NETWORK ?? 'unknown',
    source,
    priority: job.priority,
    channel: job.channel,
    templateId: job.template_id,
    // An event send names an event, not a template: its templates are per attempt.
    templateKey: job.audit.eventType ? null : job.template_id,
    eventType: job.audit.eventType ?? null,
    domain: job.audit.domain ?? null,
    payload: realtime
      ? { to, variable_names: job.audit.variableNames ?? Object.keys(job.variables ?? {}), ...contentRefs }
      : {
          to,
          variables: withoutAttachmentBodies(job.channel, job.variables),
          ...(job.body ? { body: job.body } : {}),
          ...contentRefs,
        },
    job: realtime ? undefined : (job as unknown as Record<string, unknown>),
    recoverable: !realtime,
  };
}
