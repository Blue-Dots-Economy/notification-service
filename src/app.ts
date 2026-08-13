import Fastify from 'fastify';
import { notifyBodyLimitBytes } from './lib/providers/email/attachments';
import { docsRoutes } from './routes/docs';
import { metricsRoutes } from './routes/metrics';
import { notifyRoutes } from './routes/notify';
import { providerRoutes } from './routes/providers';
import { retryRoutes } from './routes/retry';

// Fastify's 1 MB default would reject every attachment-bearing notify request
// (base64 inflates a 5 MB file to ~6.7 MB), so the limit is derived from the
// configured attachment budget — see notifyBodyLimitBytes (#551).
const app = Fastify({ logger: true, bodyLimit: notifyBodyLimitBytes() });

app.register(docsRoutes);
app.register(notifyRoutes);
app.register(providerRoutes);
app.register(metricsRoutes);
app.register(retryRoutes);

export default app;
