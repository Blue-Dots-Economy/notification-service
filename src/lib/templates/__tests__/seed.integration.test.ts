import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sms = vi.hoisted(() => ({
  current: { name: 'sms', vendor: 'msg91', renders: 'provider', templates: { login_otp: 'flow-otp' }, bodies: undefined as Record<string, string> | undefined },
}));
vi.mock('../../providers', () => ({ providers: { get sms() { return sms.current; } } }));
vi.mock('../vendors', () => ({ channelVendor: (c: string) => (c === 'sms' ? { vendor: sms.current.vendor, renders: sms.current.renders } : undefined) }));

import { closeDb, getPool } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { listTemplates, createTemplateDraft } from '../repo';
import { seedBuiltinTemplates } from '../seed';

beforeAll(async () => { await runMigrations(); });
afterAll(async () => { await closeDb(); });
beforeEach(async () => {
  process.env.NS_NETWORK = 'test_net';
  delete process.env.SMS_LOGIN_OTP_BODY;
  sms.current = { name: 'sms', vendor: 'msg91', renders: 'provider', templates: { login_otp: 'flow-otp' }, bodies: undefined };
  await getPool().query(`DELETE FROM notification_policy; DELETE FROM template;`);
});

describe('seedBuiltinTemplates', () => {
  it('seeds an active msg91 login_otp from the provider id', async () => {
    expect(await seedBuiltinTemplates()).toBe('seeded_active');
    const [t] = await listTemplates({ channel: 'sms', templateKey: 'login_otp' });
    expect(t).toMatchObject({ status: 'active', provider: 'msg91', providerTemplateId: 'flow-otp', createdBy: 'system:seed' });
    expect(t!.variables).toEqual([{ name: 'message', required: true, type: 'string', sensitive: true, raw: false }]);
  });

  it('seeds pinnacle with its body', async () => {
    sms.current = { name: 'sms', vendor: 'pinnacle', renders: 'ns', templates: { login_otp: '1107' }, bodies: { login_otp: '{{message}} is your OTP' } };
    expect(await seedBuiltinTemplates()).toBe('seeded_active');
    const [t] = await listTemplates({ channel: 'sms', templateKey: 'login_otp' });
    expect(t!.bodyText).toBe('{{message}} is your OTP');
  });

  it('leaves an invalid seed as a draft', async () => {
    sms.current = { name: 'sms', vendor: 'pinnacle', renders: 'ns', templates: { login_otp: '1107' }, bodies: { login_otp: '' } };
    expect(await seedBuiltinTemplates()).toBe('seeded_draft');
  });

  it('never touches an existing login_otp', async () => {
    await createTemplateDraft({ channel: 'sms', templateKey: 'login_otp', providerTemplateId: 'admin-made' }, 'admin');
    expect(await seedBuiltinTemplates()).toBe('exists');
    expect(await listTemplates({ templateKey: 'login_otp' })).toHaveLength(1);
  });

  it('is idempotent across concurrent seeders', async () => {
    const outcomes = await Promise.all([seedBuiltinTemplates(), seedBuiltinTemplates()]);
    expect([...outcomes].sort()).toEqual(['exists', 'seeded_active']);
    expect(await listTemplates({ templateKey: 'login_otp' })).toHaveLength(1);
  });

  it('skips without a network or an id', async () => {
    delete process.env.NS_NETWORK;
    expect(await seedBuiltinTemplates()).toBe('skipped_no_network');
    process.env.NS_NETWORK = 'test_net';
    sms.current = { ...sms.current, templates: { login_otp: '' } };
    expect(await seedBuiltinTemplates()).toBe('skipped_no_id');
  });
});
