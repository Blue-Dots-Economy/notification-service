import { FastifyReply } from 'fastify';
import { NetworkNotConfigured } from '../lib/network';
import { TemplateError } from '../lib/templates/errors';

export function sendAdminError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof NetworkNotConfigured) {
    return reply.code(503).send({ error: 'network_not_configured' });
  }
  if (err instanceof TemplateError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'invalid_state' ? 409 : 422;
    return reply.code(status).send({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
  }
  throw err;
}
