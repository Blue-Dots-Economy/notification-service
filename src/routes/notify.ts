import { randomUUID } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dedupe } from '../lib/dedupe';
import { providers } from '../lib/providers';
import * as queue from '../lib/queue';
import { requestAuth } from '../plugins/request-auth';

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
    handler: async (req, reply) => {
      const parsed = NotifySchema.safeParse(req.body);
      if (!parsed.success)
        return reply.code(400).send(z.formatError(parsed.error));

      const body = parsed.data;
      const provider = providers[body.channel];
      if (!provider)
        return reply.code(400).send({ error: 'Unknown provider channel' });
      if (typeof provider.templates[body.template_id] !== 'string')
        return reply.code(400).send({ error: 'Unknown template for provider' });

      const v = provider.schema.safeParse(body.variables);
      if (!v.success)
        return reply.code(400).send({ error: z.formatError(v.error) });

      const job_id = randomUUID();
      const priority = body.priority ?? 'other';

      const dedupeKey =
        body.dedupe_id ?? `${body.channel}:${body.to}:${body.template_id}`;
      const isNew = await dedupe(dedupeKey, 5);
      if (!isNew) return reply.send({ job_id, enqueued: false });

      const job = { job_id, ...body, priority };

      if (priority === 'realtime') await queue.pushRealtime(job);
      else await queue.pushOther(job);

      reply.send({ job_id, enqueued: true });
    },
  });
}
