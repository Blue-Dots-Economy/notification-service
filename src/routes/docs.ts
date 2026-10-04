import { FastifyInstance } from 'fastify';
import { openApiDocument } from '../lib/utils/openapi';

/**
 * The schema and API reference pages are a development aid. They are off in
 * deployed environments unless NS_DOCS_ENABLED=true is set explicitly.
 */
export function docsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NS_DOCS_ENABLED === 'true';
}

export async function docsRoutes(app: FastifyInstance) {
  if (!docsEnabled()) return;

  app.get('/', async (_, reply) => {
    return reply.type('text/html').send(`<!doctype html>
<html>
  <head>
    <title>Notification Service API</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
    <script>
      Scalar.createApiReference('#app', {
        url: '/openapi.json',
        title: 'Notification Service API'
      })
    </script>
  </body>
</html>`);
  });

  app.get('/openapi.json', async () => openApiDocument());
}
