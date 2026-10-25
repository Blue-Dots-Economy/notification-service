import Fastify from 'fastify';
import { adminTemplateRoutes } from './routes/admin-templates';
import { adminPolicyRoutes } from './routes/admin-policies';
import { adminExportRoutes } from './routes/admin-export';
import { docsRoutes } from './routes/docs';
import { metricsRoutes } from './routes/metrics';
import { notifyRoutes } from './routes/notify';
import { v1NotifyRoutes } from './routes/v1-notify';
import { providerRoutes } from './routes/providers';
import { retryRoutes } from './routes/retry';
import { registerRawJsonBody } from './plugins/raw-body';

// The raised body limit for attachments is set on /notify and /v1/notify
// themselves; every other route keeps Fastify's 1 MB default.
const app = Fastify({ logger: true });

// Before any route: HMAC v2 signs the exact JSON body bytes.
registerRawJsonBody(app);

app.register(docsRoutes);
app.register(adminTemplateRoutes);
app.register(adminPolicyRoutes);
app.register(adminExportRoutes);
app.register(notifyRoutes);
app.register(v1NotifyRoutes);
app.register(providerRoutes);
app.register(metricsRoutes);
app.register(retryRoutes);

export default app;
