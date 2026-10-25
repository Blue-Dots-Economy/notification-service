import { randomUUID } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dedupe, releaseDedupe } from '../lib/dedupe';
import { buildDedupeKey } from '../lib/dedupe_key';
import { providers } from '../lib/providers';
import * as queue from '../lib/queue';
import { recordAccepted } from '../lib/audit/store';
import { isOtpTemplate, toAcceptedRecord } from '../lib/audit/redact';
import { stamp } from '../lib/audit/stamp';
import { describeDbError } from '../lib/db/errors';
import { urgentDefaultDeadlineS } from '../lib/deadline';
import { principalLabel } from '../lib/auth/principal';
import { authenticate } from '../plugins/auth';
import { correlationIdFrom, MAX_CORRELATION_ID_LENGTH } from '../lib/correlation';
import { notifyBodyLimitBytes } from '../lib/providers/email/attachments';

const NotifySchema = z.object({
  channel: z.string(),
  to: z.string(),
  template_id: z.string(),
  priority: z.enum(['realtime', 'other']).optional(),
  variables: z.record(z.string(), z.any()),
  dedupe_id: z.string().optional(),
  // Only read by providers that do not render (Pinnacle SMS), and only for a
  // raw pass-through `template_id`: a template the provider names owns its body.
  // Capped at the largest single message a supported vendor accepts (2000,
  // Latin-1), so an undeliverable body is rejected before it is queued.
  body: z.string().max(2000).optional(),
});

export { MAX_CORRELATION_ID_LENGTH };

export async function notifyRoutes(app: FastifyInstance) {
  app.route({
    url: '/notify',
    method: 'POST',
    preHandler: authenticate({ scope: 'notify:send', legacyHmacV1: true }),
    // Fastify's 1 MB default would reject attachment-bearing requests, so the
    // send routes are raised to the derived attachment budget.
    bodyLimit: notifyBodyLimitBytes(),
    handler: async (req, reply) => {
      const parsed = NotifySchema.safeParse(req.body);
      if (!parsed.success)
        return reply.code(400).send(z.formatError(parsed.error));

      const body = parsed.data;
      const provider = providers[body.channel];
      if (!provider)
        return reply.code(400).send({ error: 'Unknown provider channel' });
      // Strict allowlist unless the provider allows raw ids (SMS).
      if (
        !provider.allowRawTemplateId &&
        typeof provider.templates[body.template_id] !== 'string'
      )
        return reply.code(400).send({ error: 'Unknown template for provider' });

      const v = provider.schema.safeParse(body.variables);
      if (!v.success)
        return reply.code(400).send({ error: z.formatError(v.error) });

      const job_id = randomUUID();
      const priority = body.priority ?? 'other';

      const { key, ttlSeconds, explicit } = buildDedupeKey(body);
      const isNew = await dedupe(key, ttlSeconds);
      if (!isNew) {
        // An explicit `dedupe_id` hit is the suppression the caller asked for: 200
        // with a reason. A fallback hit is a dropped message nobody intended, so
        // it is a 409 that callers checking only `res.ok` cannot mistake for delivery.
        req.log.warn(
          { dedupe_key: key, channel: body.channel, template_id: body.template_id, explicit },
          'suppressed duplicate notify',
        );
        return explicit
          ? reply.send({ job_id, enqueued: false, reason: 'duplicate' })
          : reply.code(409).send({ job_id, enqueued: false, reason: 'duplicate-fallback' });
      }

      const job = {
        job_id,
        ...body,
        priority,
        ...(priority === 'realtime' ? { deadline: Date.now() + urgentDefaultDeadlineS() * 1000 } : {}),
        audit: {
          eventId: randomUUID(),
          attemptId: randomUUID(),
          createdAt: new Date().toISOString(),
          correlationId: correlationIdFrom(req.headers['x-correlation-id'], job_id),
          // Sticky: decided by the priority the caller sent and the template,
          // never re-derived. An OTP template is redacted at any priority.
          redactValues: priority === 'realtime' || isOtpTemplate(body.template_id),
        },
      };
      const source = principalLabel(req.principal);
      const record = toAcceptedRecord(job, source);

      if (priority === 'realtime') {
        // Queue first: a slow or unavailable Postgres must never delay an OTP.
        await queue.pushRealtime(job);
        void recordAccepted(record).catch((err) =>
          req.log.error({ err: describeDbError(err), job_id }, 'realtime audit insert failed'),
        );
        return reply.send({ job_id, enqueued: true });
      }

      // Record before queue: a send that cannot be recorded is refused, so a
      // Redis loss can be recovered from the record.
      try {
        await recordAccepted(record);
      } catch (err) {
        req.log.error({ err: describeDbError(err), job_id }, 'audit insert failed; refusing send');
        // Release the claim so a retry is not suppressed as a duplicate of a
        // send that was never queued. Best-effort: never changes the 503.
        await releaseDedupe(key).catch((e) =>
          req.log.error({ err: (e as Error)?.message ?? String(e), job_id }, 'dedupe release failed'),
        );
        return reply.code(503).send({ error: 'audit store unavailable', enqueued: false });
      }
      try {
        await queue.pushOther(job);
      } catch (err) {
        // Recorded but never queued: close the record so recovery does not
        // send it later. Best-effort (stamp never throws); the error still
        // propagates so the caller sees the failure.
        await stamp(job, { status: 'failed', attemptNo: 1, error: 'enqueue failed' });
        // Release the claim as on the 503 path, so the caller's retry is not
        // suppressed as a duplicate of a send that was never queued.
        await releaseDedupe(key).catch((e) =>
          req.log.error({ err: (e as Error)?.message ?? String(e), job_id }, 'dedupe release failed'),
        );
        throw err;
      }
      reply.send({ job_id, enqueued: true });
    },
  });
}
