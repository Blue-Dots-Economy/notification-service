import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { providers } from '../lib/providers';
import { serializeProvider } from '../lib/utils/provider-docs';
import { authenticate } from '../plugins/auth';

const ProviderParamsSchema = z.object({
  name: z.string(),
});

export async function providerRoutes(app: FastifyInstance) {
  app.get('/providers', { preHandler: authenticate({ scope: 'any' }) }, async () => {
    return Object.values(providers).map(serializeProvider);
  });

  app.get('/providers/:name', { preHandler: authenticate({ scope: 'any' }) }, async (req, reply) => {
    const parsed = ProviderParamsSchema.safeParse(req.params);
    if (!parsed.success)
      return reply.code(400).send(z.formatError(parsed.error));

    const provider = providers[parsed.data.name];
    if (!provider) return reply.code(404).send({ error: 'Provider not found' });

    return serializeProvider(provider);
  });
}
