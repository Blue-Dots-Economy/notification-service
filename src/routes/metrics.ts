import { FastifyInstance } from 'fastify';
import * as queue from '../lib/queue';
import { renderPrometheus } from '../lib/metrics';
import { requestAuth } from '../plugins/request-auth';

export async function metricsRoutes(app: FastifyInstance) {
  app.get('/metrics/queue', { preHandler: requestAuth }, async (req, reply) => {
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
   * Unauthenticated, unlike every other route here, because Prometheus cannot
   * produce this service's HMAC signature. That is acceptable only because the
   * exposition carries counts and queue depths — no recipients, no variables,
   * no message content — and because the port is internal to the cluster. Keep
   * it that way: anything recipient-identifying must not be exported here.
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
