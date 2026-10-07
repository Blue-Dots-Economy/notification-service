import { FastifyReply } from 'fastify';
import { describeDbError } from '../lib/db/errors';
import { NetworkNotConfigured } from '../lib/network';
import { TemplateError } from '../lib/templates/errors';

/**
 * Map an admin-route failure to a response. Anything that is not a template
 * rule violation or missing network config is treated as a database failure:
 * it is logged only through `describeDbError` (a DrizzleQueryError message
 * embeds the SQL and every bound parameter, template bodies included) and
 * answered with a generic 503, so neither the log nor the body leaks it.
 */
export function sendAdminError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof NetworkNotConfigured) {
    return reply.code(503).send({ error: 'network_not_configured' });
  }
  if (err instanceof TemplateError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'invalid_state' || err.code === 'template_in_use' ? 409 : 422;
    return reply.code(status).send({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
  }
  reply.log.error(`admin request failed: ${describeDbError(err)}`);
  return reply.code(503).send({ error: 'database_unavailable' });
}
