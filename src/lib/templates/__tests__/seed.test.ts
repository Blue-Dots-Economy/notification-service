import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TemplateError } from '../errors';

const client = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }));
const repo = vi.hoisted(() => ({
  listTemplates: vi.fn(),
  createTemplateDraft: vi.fn(),
  publishTemplate: vi.fn(),
  reapplySeedDraft: vi.fn(),
}));
vi.mock('../../db/client', () => ({ getPool: () => ({ connect: async () => client }) }));
vi.mock('../../network', () => ({ currentNetwork: () => 'n', NetworkNotConfigured: class extends Error {} }));
vi.mock('../../providers', () => ({ providers: { sms: { vendor: 'msg91', renders: 'provider', templates: {} } } }));
vi.mock('../repo', async (importOriginal) => ({ ...(await importOriginal<typeof import('../repo')>()), ...repo }));

const { seedBuiltinTemplates } = await import('../seed');

const t0 = new Date('2026-10-01T00:00:00Z');
const seedDraft = (over: Record<string, unknown> = {}) => ({
  id: 'd1', provider: 'msg91', status: 'draft', createdBy: 'system:seed', version: 1, createdAt: t0, updatedAt: t0, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  client.query.mockResolvedValue({ rows: [] });
  repo.listTemplates.mockResolvedValue([{ provider: 'msg91' }]);
  process.env.SMS_LOGIN_OTP_TEMPLATE_ID = 'flow-otp';
});

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
    expect(await seedBuiltinTemplates()).toBe('exists');
    expect(client.release).toHaveBeenCalledWith(undefined);
  });
});

describe('seedBuiltinTemplates retry of its own draft', () => {
  it('re-applies env values to an untouched seed draft and retries publish', async () => {
    repo.listTemplates.mockResolvedValue([seedDraft()]);
    repo.reapplySeedDraft.mockResolvedValue(seedDraft());
    repo.publishTemplate.mockResolvedValue({});
    expect(await seedBuiltinTemplates()).toBe('seeded_active');
    expect(repo.reapplySeedDraft).toHaveBeenCalledWith('d1', expect.objectContaining({ providerTemplateId: 'flow-otp' }));
    expect(repo.publishTemplate).toHaveBeenCalledWith('d1', 'system:seed');
    expect(repo.createTemplateDraft).not.toHaveBeenCalled();
  });

  it('treats an admin-edited seed draft as exists', async () => {
    repo.listTemplates.mockResolvedValue([seedDraft({ updatedAt: new Date(t0.getTime() + 1000) })]);
    expect(await seedBuiltinTemplates()).toBe('exists');
    expect(repo.reapplySeedDraft).not.toHaveBeenCalled();
    expect(repo.publishTemplate).not.toHaveBeenCalled();
  });

  it('treats a seed draft beside an admin row as exists', async () => {
    repo.listTemplates.mockResolvedValue([seedDraft(), seedDraft({ id: 'd2', createdBy: 'admin', version: 2 })]);
    expect(await seedBuiltinTemplates()).toBe('exists');
    expect(repo.publishTemplate).not.toHaveBeenCalled();
  });

  it('treats an active seed row as exists', async () => {
    repo.listTemplates.mockResolvedValue([seedDraft({ status: 'active' })]);
    expect(await seedBuiltinTemplates()).toBe('exists');
    expect(repo.publishTemplate).not.toHaveBeenCalled();
  });

  it('answers exists when an admin touched the draft between list and re-apply', async () => {
    repo.listTemplates.mockResolvedValue([seedDraft()]);
    repo.reapplySeedDraft.mockRejectedValue(new TemplateError('invalid_state', 'touched'));
    expect(await seedBuiltinTemplates()).toBe('exists');
    expect(repo.publishTemplate).not.toHaveBeenCalled();
  });

  it('warns when the seed is left as a draft', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    repo.listTemplates.mockResolvedValue([seedDraft()]);
    repo.reapplySeedDraft.mockResolvedValue(seedDraft());
    repo.publishTemplate.mockRejectedValue(new TemplateError('incomplete_template', 'no body'));
    expect(await seedBuiltinTemplates()).toBe('seeded_draft');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('incomplete_template'));
    warn.mockRestore();
  });
});
