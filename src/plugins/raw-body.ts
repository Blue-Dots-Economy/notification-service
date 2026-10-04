import type { FastifyInstance } from 'fastify';
import '../types/fastify-auth';

/**
 * Replace the JSON parser with one that keeps the raw bytes on `req.rawBody`
 * (HMAC v2 signs them) and then parses with Fastify's own JSON parser, so
 * prototype-poisoning handling and per-route body limits are unchanged.
 */
export function registerRawJsonBody(app: FastifyInstance): void {
  const parseJson = app.getDefaultJsonParser('error', 'ignore');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body as Buffer;
    parseJson(req, (body as Buffer).toString('utf8'), done);
  });
}
