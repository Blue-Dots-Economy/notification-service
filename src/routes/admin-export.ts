import { FastifyInstance } from 'fastify';
import { exportCatalogue } from '../lib/catalogue/export';
import { authenticate } from '../plugins/auth';
import { sendAdminError } from './admin-errors';

export async function adminExportRoutes(app: FastifyInstance) {
  const preHandler = authenticate({ scope: 'templates:admin' });

  app.get('/v1/admin/export', { preHandler }, async (_req, reply) => {
    try {
      return await exportCatalogue(new Date().toISOString().replace(/[:]/g, '-').slice(0, 64));
    } catch (err) {
      return sendAdminError(reply, err);
    }
  });
}
