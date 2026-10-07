import app from './app.js';
import { loadSecrets } from './lib/auth/secrets.js';
import { spawnWorker } from './lib/worker.js';
import { runMigrations } from './lib/db/migrate.js';
import { startPartitionMaintenance } from './lib/db/maintenance.js';
import { recoverAtBoot, recoverLostJobs } from './lib/audit/recover.js';
import { validateBootConfig } from './lib/boot-config.js';
import { describeDbError } from './lib/db/errors.js';
import { seedBuiltinTemplates } from './lib/templates/seed.js';
import { startContent } from './lib/content/resolver.js';

const PORT = process.env.SERVER_PORT || `3000`;

async function main() {
  loadSecrets();
  // API process only: the forked worker never renders. Never throws; a broken
  // content file leaves content unavailable and affects no other send.
  // validateBootConfig below rejects bad NS_CONTENT_* settings before listen.
  await startContent();
  // Before listen and before the worker: nothing may read or write a table
  // whose migration has not landed. A failure here exits non-zero so the
  // orchestrator keeps the previous pod serving.
  await runMigrations();
  startPartitionMaintenance();
  // Config errors are fatal; a recovery failure is not. This includes the
  // worker's pool, rate-limit, deadline and timeout settings: a bad value must
  // fail the pod here, not only kill the forked worker after listen.
  validateBootConfig();
  // Before the worker starts draining, so recovered jobs join the queue in order.
  // Not fatal: the periodic sweep below retries within 5 minutes.
  await recoverAtBoot();
  // Non-fatal: a seeding problem must never keep NS from sending.
  await seedBuiltinTemplates()
    .then((outcome) => console.log(`Built-in templates: ${outcome}`))
    .catch((err) => console.error('Built-in template seeding failed:', describeDbError(err)));
  await app.listen({ port: parseInt(PORT) || 3000, host: '0.0.0.0' });
  spawnWorker();
  // Periodic stale-dispatch sweep; a failure is logged, never thrown.
  setInterval(() => {
    recoverLostJobs().catch((err) => console.error('Recovery sweep failed:', describeDbError(err)));
  }, 5 * 60 * 1000).unref();
  console.log(`API running on worker ${process.pid}`);
}

main().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
