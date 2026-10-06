import { describe, expect, it, vi } from 'vitest';

// Route scopes are pinned in src/__tests__/route-scopes.test.ts.
vi.mock('../../plugins/auth', () => ({
  authenticate: () => async (req: any) => {
    req.principal = { kind: 'hmac', id: 'test-key', scopes: new Set(['notify:send']) };
  },
}));
vi.mock('../../lib/providers', () => ({
  providers: {
    email: { name: 'email', vendor: 'smtp', renders: 'ns', sendRendered: async () => ({ ok: true }) },
    sms: { name: 'sms', vendor: 'msg91', renders: 'provider', sendRendered: async () => ({ ok: true }) },
  },
}));

const Fastify = (await import('fastify')).default;
const { providerRoutes } = await import('../providers');

async function build() {
  const app = Fastify({ logger: false });
  await app.register(providerRoutes);
  await app.ready();
  return app;
}

describe('GET /providers', () => {
  it('lists each channel as {name, vendor, renders}', async () => {
    const res = await (await build()).inject({ method: 'GET', url: '/providers' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { name: 'email', vendor: 'smtp', renders: 'ns' },
      { name: 'sms', vendor: 'msg91', renders: 'provider' },
    ]);
  });

  it('answers one channel by name', async () => {
    const res = await (await build()).inject({ method: 'GET', url: '/providers/sms' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: 'sms', vendor: 'msg91', renders: 'provider' });
  });

  it('answers 404 for an unknown channel', async () => {
    const res = await (await build()).inject({ method: 'GET', url: '/providers/pigeon' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Provider not found' });
  });
});
