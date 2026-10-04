import { describe, expect, it, vi } from 'vitest';

// Pins the route-scope table: every route's auth options, and that GET /metrics
// is the only route registered without authentication.
vi.mock('../plugins/auth', () => ({
  authenticate: (opts: unknown) => Object.assign(async () => {}, { opts }),
}));
vi.mock('../lib/redis', async () => {
  const { RedisFake } = await import('../lib/__tests__/redis-fake');
  return { default: new RedisFake() };
});
vi.mock('../lib/providers', () => ({ providers: {} }));

delete process.env.NS_DOCS_ENABLED;

const { default: app } = await import('../app');

type Seen = { method: string; url: string; opts: unknown; hasPreHandler: boolean };
const seen: Seen[] = [];
app.addHook('onRoute', (r) => {
  const methods = Array.isArray(r.method) ? r.method : [r.method];
  const handlers = r.preHandler === undefined ? [] : Array.isArray(r.preHandler) ? r.preHandler : [r.preHandler];
  for (const method of methods) {
    if (method === 'HEAD') continue; // Fastify's auto-added HEAD mirrors GET
    seen.push({
      method,
      url: r.url,
      hasPreHandler: handlers.length > 0,
      opts: handlers.length === 1 ? (handlers[0] as { opts?: unknown }).opts : handlers.map((h) => (h as { opts?: unknown }).opts),
    });
  }
});
await app.ready();

const SEND = { scope: 'notify:send' };
const ADMIN = { scope: 'templates:admin' };
const ANY = { scope: 'any' };

function expected(method: string, url: string): unknown {
  if (method === 'POST' && url === '/notify') return { scope: 'notify:send', legacyHmacV1: true };
  if (method === 'POST' && url === '/v1/notify') return SEND;
  if (url.startsWith('/v1/admin/')) return ADMIN;
  if (method === 'POST' && url === '/failed/retry') return ADMIN;
  if (method === 'GET' && ['/providers', '/providers/:name', '/metrics/queue'].includes(url)) return ANY;
  return 'unlisted';
}

describe('route scope table', () => {
  it('registers the routes the table lists', () => {
    const keys = seen.map((r) => `${r.method} ${r.url}`);
    for (const k of ['POST /notify', 'POST /v1/notify', 'POST /failed/retry', 'GET /providers', 'GET /providers/:name', 'GET /metrics/queue', 'GET /metrics', 'GET /v1/admin/templates', 'GET /v1/admin/policies']) {
      expect(keys).toContain(k);
    }
  });

  it('every authenticated route carries exactly the options in the table', () => {
    for (const r of seen.filter((x) => x.hasPreHandler)) {
      expect({ route: `${r.method} ${r.url}`, opts: r.opts }).toEqual({ route: `${r.method} ${r.url}`, opts: expected(r.method, r.url) });
    }
  });

  it('GET /metrics is the only route without a preHandler', () => {
    expect(seen.filter((r) => !r.hasPreHandler).map((r) => `${r.method} ${r.url}`)).toEqual(['GET /metrics']);
  });

  it('docs routes are not registered unless NS_DOCS_ENABLED=true', () => {
    const urls = seen.map((r) => r.url);
    expect(urls).not.toContain('/');
    expect(urls).not.toContain('/openapi.json');
  });
});
