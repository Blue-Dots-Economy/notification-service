import type { PoolConfig } from 'pg';

const REQUIRED = ['DATABASE_HOST', 'DATABASE_NAME', 'DATABASE_USER', 'DATABASE_PASSWORD'] as const;

/**
 * Postgres connection settings from the environment.
 *
 * Every connection field is required rather than defaulted: a silent localhost
 * fallback would let a mis-set deployment write its audit trail somewhere else,
 * and NS refuses to start without a database at all — it is the record of what
 * was sent.
 *
 * `DATABASE_SSL` is `disable` (default — how the other services reach the shared
 * RDS today) or `require`, which verifies the server certificate against the
 * Node trust store plus any CA in `NODE_EXTRA_CA_CERTS`.
 */
export function loadDbConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`Database not configured: missing ${missing.join(', ')}`);
  }

  const port = Number(env.DATABASE_PORT ?? 5432);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`DATABASE_PORT must be a positive integer, got '${env.DATABASE_PORT}'`);
  }

  const ssl = (env.DATABASE_SSL ?? 'disable').trim().toLowerCase();
  if (ssl !== 'disable' && ssl !== 'require') {
    throw new Error(`DATABASE_SSL must be 'disable' or 'require', got '${env.DATABASE_SSL}'`);
  }

  return {
    host: env.DATABASE_HOST,
    port,
    database: env.DATABASE_NAME,
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    ssl: ssl === 'require' ? { rejectUnauthorized: true } : false,
    max: Number(env.DATABASE_POOL_MAX ?? 10),
  };
}
