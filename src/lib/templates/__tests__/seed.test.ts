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

describe('seedBuiltinTemplates lock handling', () => {
  it('releases the connection with the error when the advisory unlock fails, so the pool destroys it', async () => {
    const unlockErr = new Error('connection lost');
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_advisory_unlock')) throw unlockErr;
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
});
