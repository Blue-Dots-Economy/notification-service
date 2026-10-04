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
 *
 * Waits are bounded (node-postgres defaults to waiting forever): a connect
 * timeout (`DATABASE_CONNECT_TIMEOUT_MS`, 2000) and client- and server-side
 * query timeouts (`DATABASE_QUERY_TIMEOUT_MS`, 5000), so an unreachable
 * database cannot hold the worker loop.
 */
function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const n = Number(env[name] ?? fallback);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got '${env[name]}'`);
  }
  return n;
}

export function loadDbConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`Database not configured: missing ${missing.join(', ')}`);
  }

  const port = positiveInt(env, 'DATABASE_PORT', 5432);
  const connectionTimeoutMillis = positiveInt(env, 'DATABASE_CONNECT_TIMEOUT_MS', 2000);
  const queryTimeout = positiveInt(env, 'DATABASE_QUERY_TIMEOUT_MS', 5000);
  // Floor of 2: the migration lock session and the migrator each hold one.
  const poolMax = positiveInt(env, 'DATABASE_POOL_MAX', 10);
  if (poolMax < 2) throw new Error(`DATABASE_POOL_MAX must be at least 2, got '${env.DATABASE_POOL_MAX}'`);

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
    max: poolMax,
    connectionTimeoutMillis,
    query_timeout: queryTimeout,
    statement_timeout: queryTimeout,
  };
}
