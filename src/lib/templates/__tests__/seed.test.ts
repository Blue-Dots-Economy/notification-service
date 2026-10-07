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
vi.mock('../../providers', () => ({ providers: { sms: { name: 'sms', vendor: 'msg91', renders: 'provider' } } }));
vi.mock('../repo', async (importOriginal) => ({ ...(await importOriginal<typeof import('../repo')>()), ...repo }));

const { configuredLoginOtp, seedBuiltinTemplates } = await import('../seed');

const textOf = (q: string | { text: string }) => (typeof q === 'string' ? q : q.text);

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
    client.query.mockImplementation(async (q: string | { text: string }) => {
      if (textOf(q).includes('pg_advisory_unlock')) throw unlockErr;
      return { rows: [] };
    });
    await expect(seedBuiltinTemplates()).rejects.toBe(unlockErr);
    expect(client.release).toHaveBeenCalledWith(unlockErr);
  });

  it('releases the connection normally when the unlock succeeds', async () => {
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

// login_otp seeds from explicit env only; the provider definitions no longer
// carry a template map or bodies.
describe('configuredLoginOtp', () => {
  const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;

  it('msg91 seeds SMS_LOGIN_OTP_TEMPLATE_ID, trimmed, with no body', () => {
    expect(configuredLoginOtp('msg91', env({ SMS_LOGIN_OTP_TEMPLATE_ID: ' flow-otp ' }))).toEqual({ id: 'flow-otp', body: null });
  });

  it('msg91 never seeds the old hardcoded fallback flow id: unset or blank is skipped', () => {
    expect(configuredLoginOtp('msg91', env({}))).toBeUndefined();
    expect(configuredLoginOtp('msg91', env({ SMS_LOGIN_OTP_TEMPLATE_ID: '   ' }))).toBeUndefined();
    expect(configuredLoginOtp('msg91', env({ PINNACLE_LOGIN_OTP_TEMPLATE_ID: '1107' }))).toBeUndefined();
  });

  it('msg91 carries SMS_LOGIN_OTP_BODY when it is set, as before', () => {
    expect(configuredLoginOtp('msg91', env({ SMS_LOGIN_OTP_TEMPLATE_ID: 'f', SMS_LOGIN_OTP_BODY: '{{message}} is your OTP' })))
      .toEqual({ id: 'f', body: '{{message}} is your OTP' });
  });

  it('pinnacle seeds PINNACLE_LOGIN_OTP_TEMPLATE_ID with SMS_LOGIN_OTP_BODY, byte-exact', () => {
    expect(configuredLoginOtp('pinnacle', env({ PINNACLE_LOGIN_OTP_TEMPLATE_ID: '1107', SMS_LOGIN_OTP_BODY: '{{message}} is your OTP ' })))
      .toEqual({ id: '1107', body: '{{message}} is your OTP ' });
  });

  it('pinnacle without a body still seeds the id (publish leaves it a draft)', () => {
    expect(configuredLoginOtp('pinnacle', env({ PINNACLE_LOGIN_OTP_TEMPLATE_ID: '1107' }))).toEqual({ id: '1107', body: null });
    expect(configuredLoginOtp('pinnacle', env({ PINNACLE_LOGIN_OTP_TEMPLATE_ID: '1107', SMS_LOGIN_OTP_BODY: '' }))).toEqual({ id: '1107', body: null });
  });

  it('pinnacle with an unset or blank id is skipped, and ignores the msg91 variable', () => {
    expect(configuredLoginOtp('pinnacle', env({ SMS_LOGIN_OTP_BODY: '{{message}}' }))).toBeUndefined();
    expect(configuredLoginOtp('pinnacle', env({ PINNACLE_LOGIN_OTP_TEMPLATE_ID: ' ' }))).toBeUndefined();
    expect(configuredLoginOtp('pinnacle', env({ SMS_LOGIN_OTP_TEMPLATE_ID: 'flow-otp' }))).toBeUndefined();
  });

  it('any other vendor has no login_otp to seed', () => {
    expect(configuredLoginOtp('twilio', env({ SMS_LOGIN_OTP_TEMPLATE_ID: 'f', PINNACLE_LOGIN_OTP_TEMPLATE_ID: 'p' }))).toBeUndefined();
  });
});
