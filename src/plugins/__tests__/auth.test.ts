import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/redis', async () => {
  const { RedisFake } = await import('../../lib/__tests__/redis-fake');
  return { default: new RedisFake() };
});
const bearer = vi.hoisted(() => ({
  bearerConfig: vi.fn(() => ({ issuer: 'i', jwksUri: 'https://i/c', audience: 'notification-service', allowedAzp: new Set(['signals-api']) })),
  verifyBearer: vi.fn(),
}));
vi.mock('../../lib/auth/bearer', () => bearer);

const { loadSecrets } = await import('../../lib/auth/secrets');
const { registerRawJsonBody } = await import('../raw-body');
const { authenticate } = await import('../auth');
const { signHmac, canonicalString } = await import('../../lib/auth/hmac');

beforeAll(() => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ns-auth-')), 'secrets.json');
  fs.writeFileSync(file, JSON.stringify({
    sender: { secret: 'send-secret' },
    admin: { secret: 'admin-secret', scopes: ['notify:send', 'templates:admin'] },
  }));
  process.env.INTERNAL_SECRETS_JSON = file;
  loadSecrets();
});

function build() {
  const app = Fastify();
  registerRawJsonBody(app);
  const echo = async (req: any) => ({ principal: { kind: req.principal.kind, id: req.principal.id } });
  app.post('/notify', { preHandler: authenticate({ scope: 'notify:send', legacyHmacV1: true }), bodyLimit: 8 * 1024 * 1024 }, echo);
  app.post('/v1/notify', { preHandler: authenticate({ scope: 'notify:send' }) }, echo);
  app.post('/v1/admin/templates', { preHandler: authenticate({ scope: 'templates:admin' }) }, echo);
  app.get('/providers', { preHandler: authenticate({ scope: 'any' }) }, echo);
  return app;
}

let n = 0;
function hmacHeaders(o: { method: string; url: string; body?: string | Buffer; key?: string; secret?: string; version?: 'v1' | 'v2'; ts?: string; nonce?: string }) {
  const ts = o.ts ?? String(Math.floor(Date.now() / 1000));
  const nonce = o.nonce ?? `nonce-${(n += 1)}`;
  const body = o.body === undefined ? undefined : Buffer.from(o.body);
  const canonical = canonicalString(o.version ?? 'v2', o.method, o.url, ts, nonce, body);
  return {
    'x-ns-key': o.key ?? 'sender',
    'x-ns-timestamp': ts,
    'x-ns-nonce': nonce,
    'x-ns-signature': signHmac(o.version ?? 'v2', o.secret ?? 'send-secret', canonical),
  };
}

const json = { 'content-type': 'application/json' };

describe('authenticate — HMAC', () => {
  it('accepts a v2 signature over the exact body', async () => {
    const body = '{"a":1}';
    const res = await build().inject({ method: 'POST', url: '/v1/notify', payload: body, headers: { ...json, ...hmacHeaders({ method: 'POST', url: '/v1/notify', body }) } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ principal: { kind: 'hmac', id: 'sender' } });
  });

  it('rejects a re-serialised body (signed compact, sent pretty)', async () => {
    const signed = '{"a":1}';
    const res = await build().inject({ method: 'POST', url: '/v1/notify', payload: '{ "a": 1 }', headers: { ...json, ...hmacHeaders({ method: 'POST', url: '/v1/notify', body: signed }) } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Invalid signature' });
  });

  it('verifies a non-ASCII body signed over its UTF-8 bytes, with a charset content type', async () => {
    const body = '{"name":"अनिकेत","note":"naïve ✓"}';
    const res = await build().inject({ method: 'POST', url: '/v1/notify', payload: body, headers: { 'content-type': 'application/json; charset=utf-8', ...hmacHeaders({ method: 'POST', url: '/v1/notify', body }) } });
    expect(res.statusCode).toBe(200);
  });

  it('signs the query string as part of the path, and an empty body on GET', async () => {
    const url = '/providers?channel=sms';
    const res = await build().inject({ method: 'GET', url, headers: hmacHeaders({ method: 'GET', url }) });
    expect(res.statusCode).toBe(200);
  });

  it('verifies a large body (attachment-sized)', async () => {
    const body = JSON.stringify({ data: 'x'.repeat(6 * 1024 * 1024) });
    const res = await build().inject({ method: 'POST', url: '/notify', payload: body, headers: { ...json, ...hmacHeaders({ method: 'POST', url: '/notify', body }) } });
    expect(res.statusCode).toBe(200);
  });

  it('accepts v1 only on legacy /notify', async () => {
    const legacy = await build().inject({ method: 'POST', url: '/notify', payload: '{}', headers: { ...json, ...hmacHeaders({ method: 'POST', url: '/notify', version: 'v1' }) } });
    expect(legacy.statusCode).toBe(200);
    const v1 = await build().inject({ method: 'POST', url: '/v1/notify', payload: '{}', headers: { ...json, ...hmacHeaders({ method: 'POST', url: '/v1/notify', version: 'v1' }) } });
    expect(v1.statusCode).toBe(401);
    expect(v1.json()).toEqual({ error: 'Signature version not accepted' });
  });

  it('does not burn the nonce on a bad signature; a replay of a good one is rejected', async () => {
    const app = build();
    const body = '{}';
    const good = hmacHeaders({ method: 'POST', url: '/v1/notify', body, nonce: 'fixed-nonce' });
    const bad = { ...good, 'x-ns-signature': 'v2=' + '0'.repeat(64) };
    expect((await app.inject({ method: 'POST', url: '/v1/notify', payload: body, headers: { ...json, ...bad } })).json()).toEqual({ error: 'Invalid signature' });
    expect((await app.inject({ method: 'POST', url: '/v1/notify', payload: body, headers: { ...json, ...good } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/notify', payload: body, headers: { ...json, ...good } })).json()).toEqual({ error: 'Replay detected' });
  });

  it.each([
    [{ 'x-ns-signature': 'v2=zz' }, 'Invalid signature'],
    [{ 'x-ns-timestamp': '1' }, 'Request expired'],
    [{ 'x-ns-timestamp': 'abc' }, 'Request expired'],
    [{ 'x-ns-key': 'nobody' }, 'Invalid key'],
    [{ 'x-ns-nonce': undefined }, 'Missing auth headers'],
  ])('rejects %j', async (over, error) => {
    const headers = { ...json, ...hmacHeaders({ method: 'POST', url: '/v1/notify', body: '{}' }), ...over } as Record<string, string>;
    for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
    const res = await build().inject({ method: 'POST', url: '/v1/notify', payload: '{}', headers });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error });
  });

  it('a sending key gets 403 on an admin route; an admin key passes', async () => {
    const body = '{}';
    const send = await build().inject({ method: 'POST', url: '/v1/admin/templates', payload: body, headers: { ...json, ...hmacHeaders({ method: 'POST', url: '/v1/admin/templates', body }) } });
    expect(send.statusCode).toBe(403);
    expect(send.json()).toEqual({ error: 'Insufficient scope', required: 'templates:admin' });
    const admin = await build().inject({ method: 'POST', url: '/v1/admin/templates', payload: body, headers: { ...json, ...hmacHeaders({ method: 'POST', url: '/v1/admin/templates', body, key: 'admin', secret: 'admin-secret' }) } });
    expect(admin.statusCode).toBe(200);
  });
});

describe('authenticate — bearer', () => {
  beforeEach(() => bearer.verifyBearer.mockReset());
  const principal = (scopes: string[]) => ({ ok: true, principal: { kind: 'bearer', id: 'signals-api', scopes: new Set(scopes) } });

  it('accepts a token holding the route scope', async () => {
    bearer.verifyBearer.mockResolvedValue(principal(['notify:send']));
    const res = await build().inject({ method: 'POST', url: '/v1/notify', payload: '{}', headers: { ...json, authorization: 'Bearer abc' } });
    expect(res.statusCode).toBe(200);
    expect(bearer.verifyBearer).toHaveBeenCalledWith('abc', expect.objectContaining({ audience: 'notification-service' }));
  });

  it('a token without an NS role gets 403 on every scoped route, and passes `any`', async () => {
    bearer.verifyBearer.mockResolvedValue(principal([]));
    expect((await build().inject({ method: 'POST', url: '/v1/notify', payload: '{}', headers: { ...json, authorization: 'Bearer abc' } })).statusCode).toBe(403);
    expect((await build().inject({ method: 'POST', url: '/v1/admin/templates', payload: '{}', headers: { ...json, authorization: 'Bearer abc' } })).statusCode).toBe(403);
    expect((await build().inject({ method: 'GET', url: '/providers', headers: { authorization: 'Bearer abc' } })).statusCode).toBe(200);
  });

  it('passes verifier failures through (401 and 503)', async () => {
    bearer.verifyBearer.mockResolvedValueOnce({ ok: false, status: 503, error: 'Auth service unavailable' });
    const res = await build().inject({ method: 'GET', url: '/providers', headers: { authorization: 'Bearer abc' } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'Auth service unavailable' });
  });

  it.each([
    [{ authorization: 'Basic abc' }, 'Malformed authorization header'],
    [{ authorization: 'Bearer' }, 'Malformed authorization header'],
  ])('rejects %j', async (headers, error) => {
    const res = await build().inject({ method: 'GET', url: '/providers', headers });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error });
  });

  it('rejects bearer when bearer auth is off', async () => {
    bearer.bearerConfig.mockReturnValueOnce(null as never);
    const res = await build().inject({ method: 'GET', url: '/providers', headers: { authorization: 'Bearer abc' } });
    expect(res.json()).toEqual({ error: 'Bearer auth not enabled' });
  });

  it('rejects a request carrying both credential types', async () => {
    const res = await build().inject({ method: 'GET', url: '/providers', headers: { authorization: 'Bearer abc', ...hmacHeaders({ method: 'GET', url: '/providers' }) } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Ambiguous credentials' });
    expect(bearer.verifyBearer).not.toHaveBeenCalled();
  });
});

describe('raw JSON body parser', () => {
  it('keeps Fastify prototype-poisoning protection (__proto__ body -> 400)', async () => {
    const body = '{"__proto__":{"polluted":true}}';
    const res = await build().inject({ method: 'POST', url: '/v1/notify', payload: body, headers: { ...json, ...hmacHeaders({ method: 'POST', url: '/v1/notify', body }) } });
    expect(res.statusCode).toBe(400);
  });

  it('keeps the default 1 MB limit on routes without a raised bodyLimit', async () => {
    const body = JSON.stringify({ data: 'x'.repeat(2 * 1024 * 1024) });
    const res = await build().inject({ method: 'POST', url: '/v1/notify', payload: body, headers: { ...json, ...hmacHeaders({ method: 'POST', url: '/v1/notify', body }) } });
    expect(res.statusCode).toBe(413);
  });

  it('applies the route bodyLimit to the raw parser', async () => {
    const body = JSON.stringify({ data: 'x'.repeat(9 * 1024 * 1024) });
    const res = await build().inject({ method: 'POST', url: '/notify', payload: body, headers: { ...json, ...hmacHeaders({ method: 'POST', url: '/notify', body }) } });
    expect(res.statusCode).toBe(413);
  });

  it('sets req.rawBody to the exact bytes', async () => {
    const app = Fastify();
    registerRawJsonBody(app);
    app.post('/raw', async (req) => ({ raw: req.rawBody?.toString('utf8'), parsed: req.body }));
    const res = await app.inject({ method: 'POST', url: '/raw', payload: '{ "a" : 1 }', headers: json });
    expect(res.json()).toEqual({ raw: '{ "a" : 1 }', parsed: { a: 1 } });
  });
});
