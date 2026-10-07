import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as queue from '../lib/queue';
import { authenticate } from '../plugins/auth';

const RetryFailedJobsSchema = z.object({
  job_id: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  priority: z.enum(['realtime', 'other']).optional(),
});

export async function retryRoutes(app: FastifyInstance) {
  app.post('/failed/retry', { preHandler: authenticate({ scope: 'templates:admin' }) }, async (req, reply) => {
    const parsed = RetryFailedJobsSchema.safeParse(req.body ?? {});
    if (!parsed.success)
      return reply.code(400).send(z.formatError(parsed.error));

    const result = await queue.retryFailedJobs({
      jobId: parsed.data.job_id,
      limit: parsed.data.limit,
      priority: parsed.data.priority,
    });

    if (parsed.data.job_id && result.not_found.length > 0) {
      return reply.code(404).send({
        retried: result.retried,
        skipped: result.skipped.length,
        refused: result.refused,
        not_found: result.not_found,
      });
    }

    return reply.send({
      retried: result.retried,
      retried_count: result.retried.length,
      skipped: result.skipped.length,
      refused: result.refused,
      not_found: result.not_found,
    });
  });
}
