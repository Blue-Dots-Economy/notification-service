import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  authenticate: vi.fn((_opts: unknown) => async (req: any) => {
    req.principal = { kind: 'hmac', id: 'test-key', scopes: new Set(['notify:send', 'templates:admin']) };
  }),
}));
vi.mock('../../plugins/auth', () => auth);
const repo = vi.hoisted(() => ({
  createPolicyDraft: vi.fn(), updatePolicyDraft: vi.fn(), publishPolicy: vi.fn(),
  retirePolicy: vi.fn(), getPolicy: vi.fn(), listPolicies: vi.fn(),
}));
vi.mock('../../lib/policies/repo', () => repo);
const cache = vi.hoisted(() => ({ clearResolveCache: vi.fn() }));
vi.mock('../../lib/send/resolver-cache', () => cache);

const Fastify = (await import('fastify')).default;
const { adminPolicyRoutes } = await import('../admin-policies');
const { TemplateError } = await import('../../lib/templates/errors');

const ID = '00000000-0000-4000-8000-000000000002';
const row = {
  id: ID, network: 'n', domain: null, eventType: 'apply', version: 1, status: 'draft', mode: 'first_available',
  channels: [{ channel: 'sms', template_key: 'apply_sms' }], createdBy: 'ns-admin', publishedBy: null,
  createdAt: new Date(), updatedAt: new Date(), publishedAt: null, retiredAt: null,
};
const admin = {};
async function build() {
  const app = Fastify({ logger: false });
  await app.register(adminPolicyRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  Object.values(repo).forEach((f) => f.mockReset());
  cache.clearResolveCache.mockClear();
});

describe('admin policy routes', () => {
  it('guards every route with the templates:admin scope', async () => {
    auth.authenticate.mockClear();
    await build();
    expect(auth.authenticate).toHaveBeenCalled();
    for (const [opts] of auth.authenticate.mock.calls) expect(opts).toEqual({ scope: 'templates:admin' });
  });

  it('creates a draft', async () => {
    repo.createPolicyDraft.mockResolvedValue(row);
    const res = await (await build()).inject({
      method: 'POST', url: '/v1/admin/policies', headers: admin,
      payload: { event_type: 'apply', mode: 'first_available', channels: [{ channel: 'sms', template_key: 'apply_sms' }] },
    });
    expect(res.statusCode).toBe(201);
    expect(repo.createPolicyDraft).toHaveBeenCalledWith(
      { domain: undefined, eventType: 'apply', mode: 'first_available', channels: [{ channel: 'sms', template_key: 'apply_sms' }] },
      'hmac:test-key',
    );
    expect(res.json()).toMatchObject({ id: ID, event_type: 'apply', domain: null });
  });

  it('rejects an unknown mode and a network in the body', async () => {
    const app = await build();
    expect((await app.inject({ method: 'POST', url: '/v1/admin/policies', headers: admin, payload: { mode: 'broadcast', channels: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/admin/policies', headers: admin, payload: { network: 'x', mode: 'all', channels: [] } })).statusCode).toBe(400);
  });

  it('rejects an unknown key such as status on create', async () => {
    const res = await (await build()).inject({ method: 'POST', url: '/v1/admin/policies', headers: admin, payload: { status: 'active', mode: 'all', channels: [] } });
    expect(res.statusCode).toBe(400);
    expect(repo.createPolicyDraft).not.toHaveBeenCalled();
  });

  it('rejects an empty-string domain or event_type on create', async () => {
    const app = await build();
    expect((await app.inject({ method: 'POST', url: '/v1/admin/policies', headers: admin, payload: { domain: '', mode: 'all', channels: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/admin/policies', headers: admin, payload: { event_type: '', mode: 'all', channels: [] } })).statusCode).toBe(400);
    expect(repo.createPolicyDraft).not.toHaveBeenCalled();
  });

  it('reports a publish validation failure as 422 with details', async () => {
    repo.publishPolicy.mockRejectedValue(new TemplateError('incomplete_template', 'no active sms template apply_sms', { channel: 'sms', template_key: 'apply_sms' }));
    const res = await (await build()).inject({ method: 'POST', url: `/v1/admin/policies/${ID}/publish`, headers: admin });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'incomplete_template', details: { channel: 'sms' } });
  });

  it('publish and retire clear the send-path resolver cache; a failed publish does not', async () => {
    const app = await build();
    repo.publishPolicy.mockRejectedValueOnce(new TemplateError('invalid_state', 'x'));
    await app.inject({ method: 'POST', url: `/v1/admin/policies/${ID}/publish`, headers: admin });
    expect(cache.clearResolveCache).not.toHaveBeenCalled();
    repo.publishPolicy.mockResolvedValue({ ...row, status: 'active' });
    expect((await app.inject({ method: 'POST', url: `/v1/admin/policies/${ID}/publish`, headers: admin })).statusCode).toBe(200);
    expect(cache.clearResolveCache).toHaveBeenCalledTimes(1);
    expect(repo.publishPolicy).toHaveBeenLastCalledWith(ID, 'hmac:test-key');
    repo.retirePolicy.mockResolvedValue({ ...row, status: 'retired' });
    expect((await app.inject({ method: 'POST', url: `/v1/admin/policies/${ID}/retire`, headers: admin })).statusCode).toBe(200);
    expect(cache.clearResolveCache).toHaveBeenCalledTimes(2);
  });
});
