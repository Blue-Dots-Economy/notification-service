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

function build(logLines?: string[]) {
  const app = logLines
    ? Fastify({ logger: { level: 'warn', stream: { write: (line: string) => void logLines.push(line) } } })
    : Fastify();
  registerRawJsonBody(app);
  const echo = async (req: any) => ({ principal: { kind: req.principal.kind, id: req.principal.id } });
  // A route with a raised bodyLimit, as /v1/notify has for attachments.
  app.post('/upload', { preHandler: authenticate({ scope: 'notify:send' }), bodyLimit: 8 * 1024 * 1024 }, echo);
  app.post('/v1/notify', { preHandler: authenticate({ scope: 'notify:send' }) }, echo);
  app.post('/v1/admin/templates', { preHandler: authenticate({ scope: 'templates:admin' }) }, echo);
  app.get('/providers', { preHandler: authenticate({ scope: 'any' }) }, echo);
  return app;
}

let n = 0;
function hmacHeaders(o: { method: string; url: string; body?: string | Buffer; key?: string; secret?: string; ts?: string; nonce?: string }) {
  const ts = o.ts ?? String(Math.floor(Date.now() / 1000));
  const nonce = o.nonce ?? `nonce-${(n += 1)}`;
  const body = o.body === undefined ? undefined : Buffer.from(o.body);
  const canonical = canonicalString(o.method, o.url, ts, nonce, body);
  return {
    'x-ns-key': o.key ?? 'sender',
    'x-ns-timestamp': ts,
    'x-ns-nonce': nonce,
    'x-ns-signature': signHmac(o.secret ?? 'send-secret', canonical),
  };
}

/** A retired HMAC v1 signature: no body digest in the canonical string, `v1=` prefix. */
function v1Headers(o: { method: string; url: string; secret?: string }) {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = `nonce-${(n += 1)}`;
  const mac = crypto.createHmac('sha256', o.secret ?? 'send-secret').update([o.method, o.url, ts, nonce].join('\n')).digest('hex');
  return { 'x-ns-key': 'sender', 'x-ns-timestamp': ts, 'x-ns-nonce': nonce, 'x-ns-signature': `v1=${mac}` };
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
    const res = await build().inject({ method: 'POST', url: '/upload', payload: body, headers: { ...json, ...hmacHeaders({ method: 'POST', url: '/upload', body }) } });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a v1 signature on every route with the same 401 as any bad signature', async () => {
    for (const [method, url] of [['POST', '/v1/notify'], ['POST', '/upload'], ['GET', '/providers']] as const) {
      const res = await build().inject({ method, url, ...(method === 'POST' ? { payload: '{}' } : {}), headers: { ...(method === 'POST' ? json : {}), ...v1Headers({ method, url }) } });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Invalid signature' });
    }
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
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Bearer auth not enabled' });
  });

  it('rejects a request carrying both credential types', async () => {
    const res = await build().inject({ method: 'GET', url: '/providers', headers: { authorization: 'Bearer abc', ...hmacHeaders({ method: 'GET', url: '/providers' }) } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Ambiguous credentials' });
    expect(bearer.verifyBearer).not.toHaveBeenCalled();
  });
});

describe('authenticate — rejection logging', () => {
  beforeEach(() => bearer.verifyBearer.mockReset());
  const rejected = (lines: string[]) => lines.map((l) => JSON.parse(l)).filter((l) => l.msg === 'auth rejected');

  it('logs an HMAC failure at warn with status, error and credential, and no header values', async () => {
    const lines: string[] = [];
    const headers = hmacHeaders({ method: 'POST', url: '/v1/notify', body: '{}', secret: 'wrong-secret' });
    const res = await build(lines).inject({ method: 'POST', url: '/v1/notify', payload: '{}', headers: { ...json, ...headers } });
    expect(res.statusCode).toBe(401);
    const [entry] = rejected(lines);
    expect(entry).toMatchObject({ level: 40, status: 401, error: 'Invalid signature', credential: 'hmac' });
    const raw = lines.join('\n');
    for (const value of [headers['x-ns-signature'], headers['x-ns-nonce'], 'send-secret', 'wrong-secret']) {
      expect(raw).not.toContain(value);
    }
  });

  it('logs a bearer failure without the token or Authorization header', async () => {
    const lines: string[] = [];
    bearer.verifyBearer.mockResolvedValueOnce({ ok: false, status: 401, error: 'Invalid token' });
    const token = 'eyJ.secret-token-value.sig';
    await build(lines).inject({ method: 'GET', url: '/providers', headers: { authorization: `Bearer ${token}` } });
    const [entry] = rejected(lines);
    expect(entry).toMatchObject({ level: 40, status: 401, error: 'Invalid token', credential: 'bearer' });
    expect(lines.join('\n')).not.toContain('secret-token-value');
  });

  it('logs a 403 for a missing scope', async () => {
    const lines: string[] = [];
    bearer.verifyBearer.mockResolvedValueOnce({ ok: true, principal: { kind: 'bearer', id: 'signals-api', scopes: new Set() } });
    await build(lines).inject({ method: 'POST', url: '/v1/notify', payload: '{}', headers: { ...json, authorization: 'Bearer abc' } });
    expect(rejected(lines)[0]).toMatchObject({ level: 40, status: 403, error: 'Insufficient scope', credential: 'bearer' });
  });

  it('logs ambiguous credentials as credential "both"', async () => {
    const lines: string[] = [];
    await build(lines).inject({ method: 'GET', url: '/providers', headers: { authorization: 'Bearer abc', ...hmacHeaders({ method: 'GET', url: '/providers' }) } });
    expect(rejected(lines)[0]).toMatchObject({ level: 40, status: 401, error: 'Ambiguous credentials', credential: 'both' });
  });

  it('logs a 503 from the key set at error', async () => {
    const lines: string[] = [];
    bearer.verifyBearer.mockResolvedValueOnce({ ok: false, status: 503, error: 'Auth service unavailable' });
    await build(lines).inject({ method: 'GET', url: '/providers', headers: { authorization: 'Bearer abc' } });
    expect(rejected(lines)[0]).toMatchObject({ level: 50, status: 503, credential: 'bearer' });
  });
});

describe('raw JSON body parser', () => {
  it('a bodyless POST authenticates without a Content-Type, and is 400 with an empty JSON body', async () => {
    const bare = await build().inject({ method: 'POST', url: '/v1/notify', headers: hmacHeaders({ method: 'POST', url: '/v1/notify' }) });
    expect(bare.statusCode).toBe(200);
    const empty = await build().inject({ method: 'POST', url: '/v1/notify', headers: { ...json, ...hmacHeaders({ method: 'POST', url: '/v1/notify' }) } });
    expect(empty.statusCode).toBe(400);
  });

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
    const res = await build().inject({ method: 'POST', url: '/upload', payload: body, headers: { ...json, ...hmacHeaders({ method: 'POST', url: '/upload', body }) } });
    expect(res.statusCode).toBe(413);
  });

  it('answers 415 to a text/plain body, before authentication', async () => {
    const body = 'hello';
    const res = await build().inject({ method: 'POST', url: '/v1/notify', payload: body, headers: { 'content-type': 'text/plain', ...hmacHeaders({ method: 'POST', url: '/v1/notify', body }) } });
    expect(res.statusCode).toBe(415);
  });

  it.each(['application/x-www-form-urlencoded', 'application/octet-stream', 'multipart/form-data; boundary=x'])('answers 415 to %s', async (type) => {
    const res = await build().inject({ method: 'POST', url: '/v1/notify', payload: 'a=1', headers: { 'content-type': type, ...hmacHeaders({ method: 'POST', url: '/v1/notify', body: 'a=1' }) } });
    expect(res.statusCode).toBe(415);
  });

  it('every accepted JSON body has rawBody set', async () => {
    const app = Fastify();
    registerRawJsonBody(app);
    app.post('/raw', async (req) => ({ hasRaw: Buffer.isBuffer(req.rawBody) }));
    for (const type of ['application/json', 'application/json; charset=utf-8', 'Application/JSON']) {
      const res = await app.inject({ method: 'POST', url: '/raw', payload: '{}', headers: { 'content-type': type } });
      expect(res.json()).toEqual({ hasRaw: true });
    }
  });

  it('sets req.rawBody to the exact bytes', async () => {
    const app = Fastify();
    registerRawJsonBody(app);
    app.post('/raw', async (req) => ({ raw: req.rawBody?.toString('utf8'), parsed: req.body }));
    const res = await app.inject({ method: 'POST', url: '/raw', payload: '{ "a" : 1 }', headers: json });
    expect(res.json()).toEqual({ raw: '{ "a" : 1 }', parsed: { a: 1 } });
  });
});
