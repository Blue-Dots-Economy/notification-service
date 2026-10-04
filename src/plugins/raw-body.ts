import type { FastifyInstance } from 'fastify';
import '../types/fastify-auth';

/**
 * JSON is the only request body this service accepts, and every accepted body is
 * captured raw on `req.rawBody` and covered by the HMAC v2 signature. All other
 * content-type parsers (Fastify's built-in `text/plain` included) are removed, so
 * any other content type is answered 415 before authentication runs.
 *
 * The JSON parser keeps the raw bytes and then parses with Fastify's own JSON
 * parser, so prototype-poisoning handling and per-route body limits are unchanged.
 */
export function registerRawJsonBody(app: FastifyInstance): void {
  const parseJson = app.getDefaultJsonParser('error', 'ignore');
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body as Buffer;
    parseJson(req, (body as Buffer).toString('utf8'), done);
  });
}
