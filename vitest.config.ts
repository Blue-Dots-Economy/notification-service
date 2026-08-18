import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node, not jsdom: this is a Fastify service with no DOM anywhere.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Redis is faked (src/lib/__tests__/redis-fake.ts), so nothing here needs a
    // server or Docker — keep it that way, and add any real-Redis coverage as a
    // separate `*.integration.test.ts` excluded from this default run.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
  },
});
