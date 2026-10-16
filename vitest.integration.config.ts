import { defineConfig } from 'vitest/config';

/**
 * Integration suite — needs a REAL Redis and Postgres, unlike the default run.
 *
 * Locally:  redis-server --port 6399 --daemonize yes
 *           docker compose up -d postgres
 *           export DATABASE_HOST=127.0.0.1 DATABASE_NAME=notification \
 *                  DATABASE_USER=notification DATABASE_PASSWORD=notification \
 *                  REDIS_ALLOW_NO_AUTH=true
 *           REDIS_PORT=6399 pnpm test:integration
 * In CI:    the `redis` service container on 6379 and a pg_partman Postgres
 *           built from docker/postgres (see ci.yaml)
 *
 * Single-threaded on purpose: these tests share one Redis keyspace, so running
 * files in parallel would let them clobber each other's `queue:retry`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    // Local integration runs use an unauthenticated dev Redis.
    env: { REDIS_ALLOW_NO_AUTH: 'true' },
    include: ['src/**/*.integration.test.ts'],
    fileParallelism: false,
  },
});
