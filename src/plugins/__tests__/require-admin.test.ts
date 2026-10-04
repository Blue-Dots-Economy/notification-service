import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { adminKeyIds, requireAdmin } from '../require-admin';

async function app() {
  const a = Fastify({ logger: false });
  a.get('/x', { preHandler: requireAdmin }, async () => ({ ok: true }));
  await a.ready();
  return a;
}

afterEach(() => { delete process.env.NS_ADMIN_KEY_IDS; });

describe('requireAdmin', () => {
  it('parses a comma-separated allowlist', () => {
    expect([...adminKeyIds({ NS_ADMIN_KEY_IDS: ' a, b ,,c' })]).toEqual(['a', 'b', 'c']);
  });

  it('403s a key id not on the allowlist', async () => {
    process.env.NS_ADMIN_KEY_IDS = 'ns-admin';
    const res = await (await app()).inject({ method: 'GET', url: '/x', headers: { 'x-ns-key': 'dpg-api-client' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'admin scope required' });
  });

  it('403s everyone when the allowlist is empty', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/x', headers: { 'x-ns-key': 'ns-admin' } });
    expect(res.statusCode).toBe(403);
  });

  it('passes an allowlisted key id', async () => {
    process.env.NS_ADMIN_KEY_IDS = 'ns-admin';
    const res = await (await app()).inject({ method: 'GET', url: '/x', headers: { 'x-ns-key': 'ns-admin' } });
    expect(res.statusCode).toBe(200);
  });
});
