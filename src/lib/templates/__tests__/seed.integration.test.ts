import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sms = vi.hoisted(() => ({
  current: { name: 'sms', vendor: 'msg91', renders: 'provider', templates: { login_otp: 'flow-otp' }, bodies: undefined as Record<string, string> | undefined },
}));
vi.mock('../../providers', () => ({ providers: { get sms() { return sms.current; } } }));
vi.mock('../vendors', () => ({ channelVendor: (c: string) => (c === 'sms' ? { vendor: sms.current.vendor, renders: sms.current.renders } : undefined) }));

import { closeDb, getPool } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { listTemplates, createTemplateDraft, updateTemplateDraft } from '../repo';
import { seedBuiltinTemplates } from '../seed';

beforeAll(async () => { await runMigrations(); });
afterAll(async () => { delete process.env.SMS_LOGIN_OTP_TEMPLATE_ID; await closeDb(); });
beforeEach(async () => {
  process.env.NS_NETWORK = 'test_net';
  delete process.env.SMS_LOGIN_OTP_BODY;
  process.env.SMS_LOGIN_OTP_TEMPLATE_ID = 'flow-otp';
  sms.current = { name: 'sms', vendor: 'msg91', renders: 'provider', templates: { login_otp: 'flow-otp' }, bodies: undefined };
  await getPool().query(`DELETE FROM notification_policy; DELETE FROM template;`);
});

describe('seedBuiltinTemplates', () => {
  it('seeds an active msg91 login_otp from SMS_LOGIN_OTP_TEMPLATE_ID', async () => {
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

  it('retries its own untouched draft on a later boot once the env is complete', async () => {
    // Pinnacle id set before SMS_LOGIN_OTP_BODY (chart default ""): the first boot leaves a draft.
    sms.current = { name: 'sms', vendor: 'pinnacle', renders: 'ns', templates: { login_otp: '1107' }, bodies: { login_otp: '' } };
    expect(await seedBuiltinTemplates()).toBe('seeded_draft');
    expect(await seedBuiltinTemplates()).toBe('seeded_draft');
    process.env.SMS_LOGIN_OTP_BODY = '{{message}} is your OTP';
    expect(await seedBuiltinTemplates()).toBe('seeded_active');
    const rows = await listTemplates({ templateKey: 'login_otp' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'active', version: 1, bodyText: '{{message}} is your OTP', providerTemplateId: '1107' });
    expect(await seedBuiltinTemplates()).toBe('exists');
  });

  it('leaves a seed draft an admin edited alone', async () => {
    sms.current = { name: 'sms', vendor: 'pinnacle', renders: 'ns', templates: { login_otp: '1107' }, bodies: { login_otp: '' } };
    expect(await seedBuiltinTemplates()).toBe('seeded_draft');
    const [d] = await listTemplates({ templateKey: 'login_otp' });
    await updateTemplateDraft(d!.id, { approvalRef: 'admin-note' });
    process.env.SMS_LOGIN_OTP_BODY = '{{message}} is your OTP';
    expect(await seedBuiltinTemplates()).toBe('exists');
    const rows = await listTemplates({ templateKey: 'login_otp' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'draft', bodyText: null, approvalRef: 'admin-note' });
  });

  it('never publishes msg91\'s hardcoded fallback id when SMS_LOGIN_OTP_TEMPLATE_ID is unset', async () => {
    delete process.env.SMS_LOGIN_OTP_TEMPLATE_ID;
    // The provider map still carries a literal fallback; the seed must ignore it.
    sms.current = { ...sms.current, templates: { login_otp: '6896c26d6eb66c66340e1242' } };
    expect(await seedBuiltinTemplates()).toBe('skipped_no_id');
    expect(await listTemplates({ templateKey: 'login_otp' })).toHaveLength(0);
    process.env.SMS_LOGIN_OTP_TEMPLATE_ID = '   ';
    expect(await seedBuiltinTemplates()).toBe('skipped_no_id');
    expect(await listTemplates({ templateKey: 'login_otp' })).toHaveLength(0);
  });

  it('seeds the new vendor and retires the old vendor\'s active row on a vendor flip', async () => {
    expect(await seedBuiltinTemplates()).toBe('seeded_active');
    sms.current = { name: 'sms', vendor: 'pinnacle', renders: 'ns', templates: { login_otp: '1107' }, bodies: { login_otp: '{{message}} is your OTP' } };
    expect(await seedBuiltinTemplates()).toBe('seeded_active');
    const rows = await listTemplates({ templateKey: 'login_otp' });
    expect(rows).toHaveLength(2);
    expect(rows.find((t) => t.provider === 'msg91')).toMatchObject({ status: 'retired', providerTemplateId: 'flow-otp' });
    expect(rows.find((t) => t.provider === 'pinnacle')).toMatchObject({ status: 'active', providerTemplateId: '1107', version: 2 });
    // A second boot on the new vendor leaves it alone.
    expect(await seedBuiltinTemplates()).toBe('exists');
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

  it('waits past the pool statement timeout for a replica still holding the seed lock, then seeds', async () => {
    // A replica still seeding holds the lock on its own connection for ~6 s,
    // longer than the pool's 5 s statement timeout.
    const holder = await getPool().connect();
    await holder.query(`SELECT pg_advisory_lock(hashtext('notification-service:seed'))`);
    const released = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        holder.query(`SELECT pg_advisory_unlock(hashtext('notification-service:seed'))`)
          .then(() => { holder.release(); resolve(); }, (e) => { holder.release(e); reject(e); });
      }, 6000);
    });
    const started = Date.now();
    const outcome = await seedBuiltinTemplates();
    await released;
    expect(Date.now() - started).toBeGreaterThanOrEqual(5500);
    expect(outcome).toBe('seeded_active');
    expect(await listTemplates({ templateKey: 'login_otp' })).toHaveLength(1);
    // The seeding connection went back to the pool at the normal bound.
    const settings = await Promise.all(
      Array.from({ length: 3 }, () => getPool().query<{ statement_timeout: string }>('SHOW statement_timeout')),
    );
    for (const r of settings) expect(r.rows[0]!.statement_timeout).not.toBe('2min');
  }, 30_000);

  it('skips without a network or an id', async () => {
    delete process.env.NS_NETWORK;
    expect(await seedBuiltinTemplates()).toBe('skipped_no_network');
    process.env.NS_NETWORK = 'test_net';
    sms.current = { name: 'sms', vendor: 'pinnacle', renders: 'ns', templates: { login_otp: '' }, bodies: { login_otp: '{{message}}' } };
    expect(await seedBuiltinTemplates()).toBe('skipped_no_id');
  });
});
