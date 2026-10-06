import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sms = vi.hoisted(() => ({
  current: { name: 'sms', vendor: 'msg91', renders: 'provider' as 'ns' | 'provider' },
}));
vi.mock('../../providers', () => ({ providers: { get sms() { return sms.current; } } }));
vi.mock('../vendors', () => ({ channelVendor: (c: string) => (c === 'sms' ? { vendor: sms.current.vendor, renders: sms.current.renders } : undefined) }));

import { closeDb, getPool } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { listTemplates, createTemplateDraft } from '../repo';
import { seedBuiltinTemplates } from '../seed';

beforeAll(async () => { await runMigrations(); });
// login_otp seeds from explicit env: SMS_LOGIN_OTP_TEMPLATE_ID (msg91),
// PINNACLE_LOGIN_OTP_TEMPLATE_ID + SMS_LOGIN_OTP_BODY (pinnacle).
const ENV_KEYS = ['SMS_LOGIN_OTP_TEMPLATE_ID', 'PINNACLE_LOGIN_OTP_TEMPLATE_ID', 'SMS_LOGIN_OTP_BODY'];
const usePinnacle = (id: string, body?: string) => {
  sms.current = { name: 'sms', vendor: 'pinnacle', renders: 'ns' };
  process.env.PINNACLE_LOGIN_OTP_TEMPLATE_ID = id;
  if (body === undefined) delete process.env.SMS_LOGIN_OTP_BODY;
  else process.env.SMS_LOGIN_OTP_BODY = body;
};
afterAll(async () => { for (const k of ENV_KEYS) delete process.env[k]; await closeDb(); });
beforeEach(async () => {
  process.env.NS_NETWORK = 'test_net';
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.SMS_LOGIN_OTP_TEMPLATE_ID = 'flow-otp';
  sms.current = { name: 'sms', vendor: 'msg91', renders: 'provider' };
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
    usePinnacle('1107', '{{message}} is your OTP');
    expect(await seedBuiltinTemplates()).toBe('seeded_active');
    const [t] = await listTemplates({ channel: 'sms', templateKey: 'login_otp' });
    expect(t!.bodyText).toBe('{{message}} is your OTP');
  });

  it('leaves an invalid seed as a draft (pinnacle with no body)', async () => {
    usePinnacle('1107', '');
    expect(await seedBuiltinTemplates()).toBe('seeded_draft');
    await getPool().query(`DELETE FROM template;`);
    usePinnacle('1107');
    expect(await seedBuiltinTemplates()).toBe('seeded_draft');
  });

  it('never publishes msg91\'s hardcoded fallback id when SMS_LOGIN_OTP_TEMPLATE_ID is unset', async () => {
    delete process.env.SMS_LOGIN_OTP_TEMPLATE_ID;
    expect(await seedBuiltinTemplates()).toBe('skipped_no_id');
    expect(await listTemplates({ templateKey: 'login_otp' })).toHaveLength(0);
    process.env.SMS_LOGIN_OTP_TEMPLATE_ID = '   ';
    expect(await seedBuiltinTemplates()).toBe('skipped_no_id');
    expect(await listTemplates({ templateKey: 'login_otp' })).toHaveLength(0);
  });

  it('seeds the new vendor and retires the old vendor\'s active row on a vendor flip', async () => {
    expect(await seedBuiltinTemplates()).toBe('seeded_active');
    usePinnacle('1107', '{{message}} is your OTP');
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
    // The seeding connection went back to the pool at the normal bound: check out
    // every idle connection at once (the seeding one is among them unless it was
    // destroyed) and read each one's own setting.
    const pool = getPool();
    const idle = pool.idleCount;
    expect(idle).toBeGreaterThan(0);
    const clients = await Promise.all(Array.from({ length: idle }, () => pool.connect()));
    try {
      for (const c of clients) {
        const r = await c.query<{ statement_timeout: string }>('SHOW statement_timeout');
        expect(r.rows[0]!.statement_timeout).toBe('5s');
      }
    } finally {
      for (const c of clients) c.release();
    }
  }, 30_000);

  it('skips without a network or an id', async () => {
    delete process.env.NS_NETWORK;
    expect(await seedBuiltinTemplates()).toBe('skipped_no_network');
    process.env.NS_NETWORK = 'test_net';
    usePinnacle('', '{{message}}');
    expect(await seedBuiltinTemplates()).toBe('skipped_no_id');
    usePinnacle('   ', '{{message}}');
    expect(await seedBuiltinTemplates()).toBe('skipped_no_id');
    expect(await listTemplates({ templateKey: 'login_otp' })).toHaveLength(0);
  });
});
