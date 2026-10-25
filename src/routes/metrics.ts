import { FastifyInstance } from 'fastify';
import * as queue from '../lib/queue';
import { renderPrometheus } from '../lib/metrics';
import { authenticate } from '../plugins/auth';

export async function metricsRoutes(app: FastifyInstance) {
  app.get('/metrics/queue', { preHandler: authenticate({ scope: 'any' }) }, async (req, reply) => {
    try {
      const metrics = await queue.getQueueMetrics();

      return reply.send({
        status: 'ok',
        timestamp: Date.now(),
        queues: metrics,
      });
    } catch (err: any) {
      req.log.error('Failed to fetch queue metrics:', err?.message || 'Unknown');
      return reply.code(500).send({ error: 'Failed to fetch metrics' });
    }
  });

  /**
   * Prometheus scrape endpoint.
   *
   * Unauthenticated, unlike the API routes, because Prometheus cannot produce
   * this service's credentials. Acceptable only because the exposition carries
   * counts and queue depths (no recipients, variables or message content) and
   * the port is internal to the cluster. Never export anything recipient-identifying.
   */
  app.get('/metrics', async (req, reply) => {
    try {
      const text = await renderPrometheus(await queue.getQueueMetrics());
      return reply
        .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
        .send(text);
    } catch (err: any) {
      req.log.error('Failed to render metrics:', err?.message || 'Unknown');
      return reply.code(500).send('# metrics unavailable\n');
    }
  });
}
