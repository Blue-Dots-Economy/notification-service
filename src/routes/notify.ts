import { randomUUID } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dedupe, releaseDedupe } from '../lib/dedupe';
import { buildDedupeKey } from '../lib/dedupe_key';
import { providers } from '../lib/providers';
import * as queue from '../lib/queue';
import { recordAccepted } from '../lib/audit/store';
import { toAcceptedRecord } from '../lib/audit/redact';
import { stamp } from '../lib/audit/stamp';
import { describeDbError } from '../lib/db/errors';
import { urgentDefaultDeadlineS } from '../lib/deadline';
import { requestAuth } from '../plugins/request-auth';
import { notifyBodyLimitBytes } from '../lib/providers/email/attachments';

const NotifySchema = z.object({
  channel: z.string(),
  to: z.string(),
  template_id: z.string(),
  priority: z.enum(['realtime', 'other']).optional(),
  variables: z.record(z.string(), z.any()),
  dedupe_id: z.string().optional(),
  // Only read by providers that cannot render server-side (Pinnacle SMS), and
  // only for a raw pass-through `template_id` — when the provider names the
  // template it owns the body, which is why the OTP callers send none.
  //
  // Bounded because it is caller-supplied text that ends up on the wire: the
  // ceiling is the largest single message any supported vendor accepts (2000
  // for Latin-1), so anything longer could not have been delivered anyway and
  // is better rejected here than after being queued.
  body: z.string().max(2000).optional(),
});

/** Persisted on every event; bounded so a caller cannot write arbitrary-size values. */
export const MAX_CORRELATION_ID_LENGTH = 128;

function correlationIdFrom(header: unknown, fallback: string): string {
  const value = typeof header === 'string' ? header.trim().slice(0, MAX_CORRELATION_ID_LENGTH) : '';
  return value || fallback;
}

export async function notifyRoutes(app: FastifyInstance) {
  app.route({
    url: '/notify',
    method: 'POST',
    preHandler: requestAuth,
    // Fastify's 1 MB default would reject every attachment-bearing request
    // (base64 inflates a 5 MB file to ~6.7 MB), so this route — and only this
    // route — is raised to the derived attachment budget. /failed/retry and the
    // rest keep the 1 MB default (#551).
    bodyLimit: notifyBodyLimitBytes(),
    handler: async (req, reply) => {
      const parsed = NotifySchema.safeParse(req.body);
      if (!parsed.success)
        return reply.code(400).send(z.formatError(parsed.error));

      const body = parsed.data;
      const provider = providers[body.channel];
      if (!provider)
        return reply.code(400).send({ error: 'Unknown provider channel' });
      // Strict allowlist unless the provider owns raw ids (SMS, #532/#535).
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
        // Two different conditions wearing one shape, so they answer differently.
        // An explicit `dedupe_id` is the caller asking for suppression, so a hit
        // is a success with a reason. A fallback hit is nobody's intent — it is a
        // dropped message, and every caller so far checked only `res.ok`, so a
        // 200 made that indistinguishable from delivery (#88).
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
          // Sticky: decided by the priority the caller sent, never re-derived.
          redactValues: priority === 'realtime',
        },
      };
      const source = String(req.headers['x-ns-key'] ?? 'unknown');
      const record = toAcceptedRecord(job, source);

      if (priority === 'realtime') {
        // Queue first: a slow or unavailable Postgres must never delay an OTP.
        await queue.pushRealtime(job);
        void recordAccepted(record).catch((err) =>
          req.log.error({ err: describeDbError(err), job_id }, 'realtime audit insert failed'),
        );
        return reply.send({ job_id, enqueued: true });
      }

      // Record before queue: a normal send that cannot be recorded is refused,
      // so a Redis loss can always be recovered from the record (spec
      // §Architecture, durability model).
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
