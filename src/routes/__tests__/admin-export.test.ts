import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route scopes are pinned in src/__tests__/route-scopes.test.ts.
vi.mock('../../plugins/auth', () => ({
  authenticate: () => async (req: any) => {
    req.principal = { kind: 'hmac', id: 'test-key', scopes: new Set(['notify:send', 'templates:admin']) };
  },
}));
const exp = vi.hoisted(() => ({ exportCatalogue: vi.fn() }));
vi.mock('../../lib/catalogue/export', () => exp);

const Fastify = (await import('fastify')).default;
const { adminExportRoutes } = await import('../admin-export');
const { NetworkNotConfigured } = await import('../../lib/network');
const { TemplateError } = await import('../../lib/templates/errors');

async function build() {
  const app = Fastify({ logger: false });
  await app.register(adminExportRoutes);
  await app.ready();
  return app;
}

beforeEach(() => { exp.exportCatalogue.mockReset(); });

describe('GET /v1/admin/export', () => {
  it('returns the catalogue with a timestamp version', async () => {
    const catalogue = { version: 'x', templates: [], policies: [] };
    exp.exportCatalogue.mockResolvedValue(catalogue);
    const res = await (await build()).inject({ method: 'GET', url: '/v1/admin/export' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(catalogue);
    const version = exp.exportCatalogue.mock.calls[0]![0] as string;
    expect(version).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/);
  });

  it('answers 503 network_not_configured when NS_NETWORK is unset', async () => {
    exp.exportCatalogue.mockImplementation(async () => { throw new NetworkNotConfigured(); });
    const res = await (await build()).inject({ method: 'GET', url: '/v1/admin/export' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'network_not_configured' });
  });

  it('answers 422 export_invalid naming paths when the store does not fit the catalogue format', async () => {
    exp.exportCatalogue.mockImplementation(async () => {
      throw new TemplateError('export_invalid', 'export does not fit the catalogue format at: templates');
    });
    const res = await (await build()).inject({ method: 'GET', url: '/v1/admin/export' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'export_invalid', message: 'export does not fit the catalogue format at: templates' });
  });
});
