import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The real document walks the provider directories; the gate is what is under test.
vi.mock('../../lib/utils/openapi', () => ({ openApiDocument: () => ({ openapi: '3.1.0' }) }));

import { docsEnabled, docsRoutes } from '../docs';

describe('docs routes', () => {
  const original = process.env.NS_DOCS_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.NS_DOCS_ENABLED;
    else process.env.NS_DOCS_ENABLED = original;
  });

  async function build() {
    const app = Fastify();
    await app.register(docsRoutes);
    return app;
  }

  it('are off unless NS_DOCS_ENABLED=true', async () => {
    delete process.env.NS_DOCS_ENABLED;
    const app = await build();
    expect((await app.inject({ method: 'GET', url: '/openapi.json' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
  });

  it('are off for any value other than "true"', async () => {
    process.env.NS_DOCS_ENABLED = '1';
    const app = await build();
    expect((await app.inject({ method: 'GET', url: '/openapi.json' })).statusCode).toBe(404);
  });

  it('are served when NS_DOCS_ENABLED=true', async () => {
    process.env.NS_DOCS_ENABLED = 'true';
    const app = await build();
    expect((await app.inject({ method: 'GET', url: '/openapi.json' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(200);
  });

  it('docsEnabled reads the given env', () => {
    expect(docsEnabled({ NS_DOCS_ENABLED: 'true' })).toBe(true);
    expect(docsEnabled({})).toBe(false);
  });
});
