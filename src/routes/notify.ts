import { randomUUID } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dedupe } from '../lib/dedupe';
import { buildDedupeKey } from '../lib/dedupe_key';
import { providers } from '../lib/providers';
import * as queue from '../lib/queue';
import { requestAuth } from '../plugins/request-auth';
import { notifyBodyLimitBytes } from '../lib/providers/email/attachments';

const NotifySchema = z.object({
  channel: z.string(),
  to: z.string(),
  template_id: z.string(),
  priority: z.enum(['realtime', 'other']).optional(),
  variables: z.record(z.string(), z.any()),
  dedupe_id: z.string().optional(),
});

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

      const job = { job_id, ...body, priority };

      if (priority === 'realtime') await queue.pushRealtime(job);
      else await queue.pushOther(job);

      reply.send({ job_id, enqueued: true });
    },
  });
}
