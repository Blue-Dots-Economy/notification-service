import { defineConfig } from 'vitest/config';

/**
 * Integration suite — needs a REAL Redis, unlike the default run.
 *
 * Locally:  redis-server --port 6399 --daemonize yes
 *           REDIS_PORT=6399 pnpm test:integration
 * In CI:    the `redis` service container on 6379 (see ci.yaml)
 *
 * Single-threaded on purpose: these tests share one Redis keyspace, so running
 * files in parallel would let them clobber each other's `queue:retry`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    fileParallelism: false,
  },
});
