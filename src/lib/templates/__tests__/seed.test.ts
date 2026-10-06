import { describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }));
vi.mock('../../db/client', () => ({ getPool: () => ({ connect: async () => client }) }));
vi.mock('../../network', () => ({ currentNetwork: () => 'n', NetworkNotConfigured: class extends Error {} }));
vi.mock('../../providers', () => ({ providers: { sms: { vendor: 'msg91', renders: 'provider', templates: {} } } }));
vi.mock('../repo', () => ({
  listTemplates: async () => [{ provider: 'msg91' }],
  createTemplateDraft: vi.fn(),
  publishTemplate: vi.fn(),
}));

const { seedBuiltinTemplates } = await import('../seed');

const textOf = (q: string | { text: string }) => (typeof q === 'string' ? q : q.text);

describe('seedBuiltinTemplates lock handling', () => {
  it('releases the connection with the error when the advisory unlock fails, so the pool destroys it', async () => {
    const unlockErr = new Error('connection lost');
    client.query.mockImplementation(async (q: string | { text: string }) => {
      if (textOf(q).includes('pg_advisory_unlock')) throw unlockErr;
      return { rows: [] };
    });
    await expect(seedBuiltinTemplates()).rejects.toBe(unlockErr);
    expect(client.release).toHaveBeenCalledWith(unlockErr);
  });

  it('releases the connection normally when the unlock succeeds', async () => {
    client.release.mockClear();
    client.query.mockResolvedValue({ rows: [] });
    expect(await seedBuiltinTemplates()).toBe('exists');
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it('raises only the lock wait: 120s server bound, a positive per-query client bound, then RESET before seeding', async () => {
    client.release.mockClear();
    client.query.mockReset();
    client.query.mockResolvedValue({ rows: [] });
    expect(await seedBuiltinTemplates()).toBe('exists');
    const calls = client.query.mock.calls.map((c) => c[0]);
    expect(calls[0]).toBe(`SET statement_timeout = '120s'`);
    expect(calls[1]).toEqual({ text: 'SELECT pg_advisory_lock(hashtext($1))', values: ['notification-service:seed'], query_timeout: 125_000 });
    expect(calls[2]).toBe('RESET statement_timeout');
    expect(textOf(calls[3])).toContain('pg_advisory_unlock');
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it('destroys the connection when RESET fails, so the raised timeout never returns to the pool', async () => {
    client.release.mockClear();
    const resetErr = new Error('reset failed');
    client.query.mockImplementation(async (q: string | { text: string }) => {
      if (textOf(q).startsWith('RESET')) throw resetErr;
      return { rows: [] };
    });
    await expect(seedBuiltinTemplates()).rejects.toBe(resetErr);
    expect(client.release).toHaveBeenCalledWith(resetErr);
  });

  it('destroys the connection when the lock wait fails, since the server may still grant the lock', async () => {
    client.release.mockClear();
    const timeoutErr = new Error('Query read timeout');
    client.query.mockImplementation(async (q: string | { text: string }) => {
      if (textOf(q).includes('pg_advisory_lock(')) throw timeoutErr;
      return { rows: [] };
    });
    await expect(seedBuiltinTemplates()).rejects.toBe(timeoutErr);
    expect(client.release).toHaveBeenCalledWith(timeoutErr);
  });
});
