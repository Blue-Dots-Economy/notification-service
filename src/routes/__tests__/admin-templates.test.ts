import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route scopes are pinned in src/__tests__/route-scopes.test.ts.
vi.mock('../../plugins/auth', () => ({
  authenticate: () => async (req: any) => {
    req.principal = { kind: 'hmac', id: 'test-key', scopes: new Set(['notify:send', 'templates:admin']) };
  },
}));
const repo = vi.hoisted(() => ({
  createTemplateDraft: vi.fn(), updateTemplateDraft: vi.fn(), publishTemplate: vi.fn(),
  retireTemplate: vi.fn(), getTemplate: vi.fn(), listTemplates: vi.fn(),
}));
vi.mock('../../lib/templates/repo', () => repo);
const cache = vi.hoisted(() => ({ clearResolveCache: vi.fn() }));
vi.mock('../../lib/send/resolver-cache', () => cache);
vi.mock('../../lib/templates/vendors', () => ({
  channelVendor: (c: string) => (c === 'email' ? { vendor: 'smtp', renders: 'ns' } : undefined),
}));

const Fastify = (await import('fastify')).default;
const { adminTemplateRoutes } = await import('../admin-templates');
const { TemplateError } = await import('../../lib/templates/errors');
const { NetworkNotConfigured } = await import('../../lib/network');

const ID = '00000000-0000-4000-8000-000000000001';
const row = {
  id: ID, network: 'n', channel: 'email', templateKey: 'welcome', locale: 'en', version: 1,
  status: 'draft', subject: 'Hi {{name}}', bodyHtml: '<p>{{name}}</p>', bodyText: null,
  variables: [{ name: 'name', required: true, type: 'string', sensitive: false, raw: false }],
  provider: 'smtp', providerTemplateId: null, senderId: null, dltEntityId: null, dltHeaderId: null,
  dltTagId: null, approvalRef: null, defaultDeadlineS: null, createdBy: 'ns-admin', publishedBy: null,
  createdAt: new Date('2026-10-04T00:00:00Z'), updatedAt: new Date('2026-10-04T00:00:00Z'),
  publishedAt: null, retiredAt: null,
};

async function build() {
  const app = Fastify({ logger: false });
  await app.register(adminTemplateRoutes);
  await app.ready();
  return app;
}
const admin = {};

beforeEach(() => {
  Object.values(repo).forEach((f) => f.mockReset());
  cache.clearResolveCache.mockClear();
});

describe('admin template routes', () => {
  it('creates a draft from snake_case input with the caller as actor', async () => {
    repo.createTemplateDraft.mockResolvedValue(row);
    const res = await (await build()).inject({
      method: 'POST', url: '/v1/admin/templates', headers: admin,
      payload: { channel: 'email', template_key: 'welcome', subject: 'Hi {{name}}', body_html: '<p>{{name}}</p>', variables: [{ name: 'name' }] },
    });
    expect(res.statusCode).toBe(201);
    expect(repo.createTemplateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'email', templateKey: 'welcome', bodyHtml: '<p>{{name}}</p>', variables: [{ name: 'name', required: true, type: 'string', sensitive: false, raw: false }] }),
      'hmac:test-key',
    );
    expect(res.json()).toMatchObject({ id: ID, template_key: 'welcome', body_html: '<p>{{name}}</p>', status: 'draft' });
  });

  it('rejects an invalid body with 400 and never calls the repo', async () => {
    const res = await (await build()).inject({ method: 'POST', url: '/v1/admin/templates', headers: admin, payload: { channel: 'email' } });
    expect(res.statusCode).toBe(400);
    expect(repo.createTemplateDraft).not.toHaveBeenCalled();
  });

  it('refuses to change channel, key or locale on PATCH', async () => {
    const res = await (await build()).inject({ method: 'PATCH', url: `/v1/admin/templates/${ID}`, headers: admin, payload: { channel: 'sms' } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects unknown fields such as status on PATCH', async () => {
    const res = await (await build()).inject({ method: 'PATCH', url: `/v1/admin/templates/${ID}`, headers: admin, payload: { status: 'active' } });
    expect(res.statusCode).toBe(400);
    expect(repo.updateTemplateDraft).not.toHaveBeenCalled();
  });

  it('maps template errors to status codes', async () => {
    repo.publishTemplate.mockRejectedValueOnce(new TemplateError('not_found', 'x'));
    repo.publishTemplate.mockRejectedValueOnce(new TemplateError('invalid_state', 'x'));
    repo.publishTemplate.mockRejectedValueOnce(new TemplateError('undeclared_token', 'x', { tokens: ['a'] }));
    repo.publishTemplate.mockRejectedValueOnce(new NetworkNotConfigured());
    const app = await build();
    const codes = [];
    for (let i = 0; i < 4; i++) {
      codes.push((await app.inject({ method: 'POST', url: `/v1/admin/templates/${ID}/publish`, headers: admin })).statusCode);
    }
    expect(codes).toEqual([404, 409, 422, 503]);
  });

  it('refuses to retire a template an active policy still needs with 409 template_in_use', async () => {
    repo.retireTemplate.mockRejectedValueOnce(new TemplateError('template_in_use', 'x', { policy_ids: ['p1'] }));
    const app = await build();
    const res = await app.inject({ method: 'POST', url: `/v1/admin/templates/${ID}/retire`, headers: admin });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'template_in_use', details: { policy_ids: ['p1'] } });
  });

  it('answers a database failure with 503 and never leaks the query or its params', async () => {
    const drizzleErr = Object.assign(
      new Error('Failed query: insert into "template" ("body_text") values ($1)\nparams: SECRET-BODY'),
      { name: 'DrizzleQueryError', query: 'insert into "template" ...', params: ['SECRET-BODY'], cause: Object.assign(new Error('connection terminated'), { code: '57P01' }) },
    );
    repo.publishTemplate.mockRejectedValueOnce(drizzleErr);
    const lines: string[] = [];
    const app = Fastify({ logger: { level: 'error', stream: { write: (l: string) => { lines.push(l); } } } });
    await app.register(adminTemplateRoutes);
    await app.ready();
    const res = await app.inject({ method: 'POST', url: `/v1/admin/templates/${ID}/publish`, headers: admin });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'database_unavailable' });
    expect(res.body).not.toContain('SECRET');
    const logged = lines.join('\n');
    expect(logged).toContain('[57P01] connection terminated');
    expect(logged).not.toContain('SECRET');
    expect(logged).not.toContain('Failed query');
  });

  it('previews a render with the supplied variables', async () => {
    repo.getTemplate.mockResolvedValue(row);
    const res = await (await build()).inject({
      method: 'POST', url: `/v1/admin/templates/${ID}/preview`, headers: admin, payload: { variables: { name: '<b>A</b>' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rendered).toMatchObject({ mode: 'ns', html: '<p>&lt;b&gt;A&lt;/b&gt;</p>' });
  });

  it('preview reports a variable problem as 422', async () => {
    repo.getTemplate.mockResolvedValue(row);
    const res = await (await build()).inject({ method: 'POST', url: `/v1/admin/templates/${ID}/preview`, headers: admin, payload: { variables: {} } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('missing_variable');
  });

  it('publish and retire clear the send-path resolver cache; a failed publish does not', async () => {
    const app = await build();
    repo.publishTemplate.mockRejectedValueOnce(new TemplateError('invalid_state', 'x'));
    await app.inject({ method: 'POST', url: `/v1/admin/templates/${ID}/publish`, headers: admin });
    expect(cache.clearResolveCache).not.toHaveBeenCalled();
    repo.publishTemplate.mockResolvedValue({ ...row, status: 'active' });
    expect((await app.inject({ method: 'POST', url: `/v1/admin/templates/${ID}/publish`, headers: admin })).statusCode).toBe(200);
    expect(cache.clearResolveCache).toHaveBeenCalledTimes(1);
    expect(repo.publishTemplate).toHaveBeenLastCalledWith(ID, 'hmac:test-key');
    repo.retireTemplate.mockResolvedValue({ ...row, status: 'retired' });
    expect((await app.inject({ method: 'POST', url: `/v1/admin/templates/${ID}/retire`, headers: admin })).statusCode).toBe(200);
    expect(cache.clearResolveCache).toHaveBeenCalledTimes(2);
  });
});
