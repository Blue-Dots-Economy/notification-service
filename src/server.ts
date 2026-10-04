import app from './app.js';
import { loadSecrets } from './lib/auth/secrets.js';
import { spawnWorker } from './lib/worker.js';
import { runMigrations } from './lib/db/migrate.js';
import { startPartitionMaintenance } from './lib/db/maintenance.js';

const PORT = process.env.SERVER_PORT || `3000`;

async function main() {
  loadSecrets();
  // Before listen and before the worker: nothing may read or write a table
  // whose migration has not landed. A failure here exits non-zero so the
  // orchestrator keeps the previous pod serving.
  await runMigrations();
  startPartitionMaintenance();
  await app.listen({ port: parseInt(PORT) || 3000, host: '0.0.0.0' });
  spawnWorker();
  console.log(`API running on worker ${process.pid}`);
}

main().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
