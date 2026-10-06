import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Def = { name: string; vendor: string; renders: 'ns' | 'provider'; templates: Record<string, string>; bodies?: Record<string, string> };
const msg91: Def = { name: 'sms', vendor: 'msg91', renders: 'provider', templates: { login_otp: 'flow-otp' } };
const pinnacle: Def = { name: 'sms', vendor: 'pinnacle', renders: 'ns', templates: { login_otp: '' }, bodies: { login_otp: '' } };
const state = vi.hoisted(() => ({ sms: undefined as unknown as Def }));
vi.mock('../../providers', () => ({
  providers: {
    get sms() { return state.sms; },
    email: { name: 'email', vendor: 'smtp', renders: 'ns', templates: {} },
  },
}));

import { closeDb, getPool } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { listPolicies, resolvePolicy, retirePolicy } from '../../policies/repo';
import { createTemplateDraft, listTemplates, resolveTemplate } from '../../templates/repo';
import { seedBuiltinTemplates } from '../../templates/seed';
import { parseCatalogue } from '../schema';
import { seedCatalogue, type SeedReport } from '../seed';

const raw = (over: Record<string, unknown> = {}) => ({
  version: 'v1',
  templates: [
    { channel: 'email', template_key: 'item.paused', subject: 'Paused', body_html: '<p>Hi {{name}}</p>', variables: [{ name: 'name' }] },
    { channel: 'sms', template_key: 'login_otp', provider: 'pinnacle', provider_template_id: 'P1', body_text: 'Code {{message}}', variables: [{ name: 'message', sensitive: true }] },
    { channel: 'sms', template_key: 'login_otp', provider: 'msg91', provider_template_id: 'M1', variables: [{ name: 'message', sensitive: true }] },
  ],
  policies: [{ domain: 'seeker', event_type: 'item.paused', mode: 'first_available', channels: [{ channel: 'email', template_key: 'item.paused' }] }],
  ...over,
});
const cat = (over: Record<string, unknown> = {}) => parseCatalogue(raw(over));

const tpl = (o: Partial<SeedReport['templates']>): SeedReport['templates'] => ({
  created_active: 0, created_draft: 0, exists: 0, skipped_vendor: 0, skipped_channel: 0, ...o,
});
const pol = (o: Partial<SeedReport['policies']>): SeedReport['policies'] => ({ created_active: 0, created_draft: 0, exists: 0, ...o });

let dir: string;
beforeAll(async () => {
  await runMigrations();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ns-catalogue-it-'));
});
afterAll(async () => {
  delete process.env.NS_SEED_FILE;
  delete process.env.SMS_LOGIN_OTP_TEMPLATE_ID;
  await fs.rm(dir, { recursive: true, force: true });
  await closeDb();
});
beforeEach(async () => {
  process.env.NS_NETWORK = 'test_net';
  delete process.env.NS_SEED_FILE;
  delete process.env.SMS_LOGIN_OTP_TEMPLATE_ID;
  delete process.env.SMS_LOGIN_OTP_BODY;
  state.sms = msg91;
  await getPool().query(`DELETE FROM notification_policy; DELETE FROM template;`);
});
afterEach(() => { vi.restoreAllMocks(); });

async function seedFile(content: unknown): Promise<string> {
  const p = path.join(dir, `catalogue-${Math.random().toString(36).slice(2)}.json`);
  await fs.writeFile(p, JSON.stringify(content));
  return p;
}

describe('seedCatalogue', () => {
  it('seeds absent entries and publishes them', async () => {
    const report = await seedCatalogue(cat());
    expect(report).toEqual({ templates: tpl({ created_active: 2, skipped_vendor: 1 }), policies: pol({ created_active: 1 }) });

    const { template } = await resolveTemplate('email', 'item.paused');
    expect(template).toMatchObject({ subject: 'Paused', locale: 'en', provider: 'smtp', createdBy: 'system:catalogue', publishedBy: 'system:catalogue' });
    const otp = await listTemplates({ templateKey: 'login_otp' });
    expect(otp).toHaveLength(1);
    expect(otp[0]).toMatchObject({ provider: 'msg91', providerTemplateId: 'M1', status: 'active', createdBy: 'system:catalogue' });
    const policy = await resolvePolicy('seeker', 'item.paused');
    expect(policy).toMatchObject({ domain: 'seeker', eventType: 'item.paused', status: 'active', createdBy: 'system:catalogue' });
  });

  it('is idempotent', async () => {
    await seedCatalogue(cat());
    const before = { t: (await listTemplates({})).length, p: (await listPolicies({})).length };
    const report = await seedCatalogue(cat());
    expect(report).toEqual({ templates: tpl({ exists: 2, skipped_vendor: 1 }), policies: pol({ exists: 1 }) });
    expect((await listTemplates({})).length).toBe(before.t);
    expect((await listPolicies({})).length).toBe(before.p);
  });

  it('never overwrites: active, draft and retired rows all count as existing', async () => {
    await seedCatalogue(cat());
    const draft = await createTemplateDraft({ channel: 'email', templateKey: 'item.paused', subject: 'Admin draft', bodyHtml: '<p>x</p>' }, 'admin');
    const [policy] = await listPolicies({ eventType: 'item.paused' });
    await retirePolicy(policy!.id);

    const changed = raw();
    (changed.templates[0] as { subject: string }).subject = 'Catalogue changed';
    const report = await seedCatalogue(parseCatalogue(changed));
    expect(report).toEqual({ templates: tpl({ exists: 2, skipped_vendor: 1 }), policies: pol({ exists: 1 }) });

    const rows = await listTemplates({ channel: 'email', templateKey: 'item.paused' });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.status === 'active')).toMatchObject({ subject: 'Paused', version: 1 });
    expect(rows.find((r) => r.status === 'draft')).toMatchObject({ id: draft.id, subject: 'Admin draft', createdBy: 'admin', updatedAt: draft.updatedAt });
    const policies = await listPolicies({ eventType: 'item.paused' });
    expect(policies).toHaveLength(1);
    expect(policies[0]!.status).toBe('retired');
    expect(await resolvePolicy('seeker', 'item.paused')).toBeNull();
  });

  it("a vendor switch seeds the new vendor's row", async () => {
    await seedCatalogue(cat());
    state.sms = pinnacle;
    const report = await seedCatalogue(cat());
    expect(report).toEqual({ templates: tpl({ created_active: 1, exists: 1, skipped_vendor: 1 }), policies: pol({ exists: 1 }) });

    const rows = await listTemplates({ templateKey: 'login_otp' });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.provider === 'msg91')).toMatchObject({ status: 'retired', providerTemplateId: 'M1' });
    expect(rows.find((r) => r.provider === 'pinnacle')).toMatchObject({ status: 'active', providerTemplateId: 'P1', bodyText: 'Code {{message}}', version: 2 });
    expect((await resolveTemplate('sms', 'login_otp')).template.provider).toBe('pinnacle');
  });

  it('a policy whose template is not active is left as a draft', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = '<p>Hi {{undeclared}} SECRETBODY</p>';
    const report = await seedCatalogue(cat({
      templates: [{ channel: 'email', template_key: 'item.paused', subject: 'Paused', body_html: body, variables: [{ name: 'name' }] }],
    }));
    expect(report).toEqual({ templates: tpl({ created_draft: 1 }), policies: pol({ created_draft: 1 }) });
    expect(await resolvePolicy('seeker', 'item.paused')).toBeNull();
    expect((await listTemplates({ templateKey: 'item.paused' }))[0]!.status).toBe('draft');
    expect((await listPolicies({ eventType: 'item.paused' }))[0]!.status).toBe('draft');

    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('catalogue template email/item.paused/en left as draft: undeclared_token');
    expect(logged).toContain('catalogue policy seeker/item.paused left as draft: incomplete_template');
    expect(logged).not.toContain('SECRETBODY');

    // Boot-style seeding does not throw on the same catalogue.
    await getPool().query(`DELETE FROM notification_policy; DELETE FROM template;`);
    process.env.NS_SEED_FILE = await seedFile(raw({
      templates: [{ channel: 'email', template_key: 'item.paused', subject: 'Paused', body_html: body, variables: [{ name: 'name' }] }],
    }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(seedBuiltinTemplates()).resolves.toBe('skipped_no_id');
    expect(await resolvePolicy('seeker', 'item.paused')).toBeNull();
  });

  it('skips a channel this deployment has no provider for', async () => {
    const report = await seedCatalogue(cat({
      templates: [{ channel: 'whatsapp', template_key: 'item.paused', provider_template_id: 'W1' }],
      policies: [],
    }));
    expect(report).toEqual({ templates: tpl({ skipped_channel: 1 }), policies: pol({}) });
    expect(await listTemplates({})).toHaveLength(0);
  });
});

describe('seedBuiltinTemplates with NS_SEED_FILE', () => {
  it('concurrent seeding creates each entry once', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.NS_SEED_FILE = await seedFile(raw());
    const outcomes = await Promise.all([seedBuiltinTemplates(), seedBuiltinTemplates()]);
    // Serialised by the lock: the second seeder finds the msg91 login_otp the
    // first one's catalogue step created.
    expect([...outcomes].sort()).toEqual(['exists', 'skipped_no_id']);

    const rows = await listTemplates({});
    const keys = rows.map((r) => `${r.channel}/${r.templateKey}/${r.locale}/${r.provider}`).sort();
    expect(keys).toEqual(['email/item.paused/en/smtp', 'sms/login_otp/en/msg91']);
    expect(rows.every((r) => r.status === 'active')).toBe(true);
    expect(await listPolicies({})).toHaveLength(1);
  });

  it("login_otp env seeding runs first; the catalogue's msg91 login_otp is then exists", async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.SMS_LOGIN_OTP_TEMPLATE_ID = 'ENV1';
    process.env.NS_SEED_FILE = await seedFile(raw());
    expect(await seedBuiltinTemplates()).toBe('seeded_active');

    const otp = await listTemplates({ templateKey: 'login_otp' });
    expect(otp).toHaveLength(1);
    expect(otp[0]).toMatchObject({ provider: 'msg91', providerTemplateId: 'ENV1', createdBy: 'system:seed', status: 'active' });

    const line = log.mock.calls.map((c) => String(c[0])).find((m) => m.startsWith('catalogue v1 seeded: '));
    expect(line).toBeDefined();
    const report = JSON.parse(line!.slice('catalogue v1 seeded: '.length)) as SeedReport;
    expect(report).toEqual({ templates: tpl({ created_active: 1, exists: 1, skipped_vendor: 1 }), policies: pol({ created_active: 1 }) });
    // Counts only: no body or subject reaches the log.
    expect(line).not.toContain('Paused');
    expect(line).not.toContain('{{');
  });

  it('a missing or invalid seed file is logged and skipped; login_otp seeding still runs', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.SMS_LOGIN_OTP_TEMPLATE_ID = 'ENV1';
    process.env.NS_SEED_FILE = path.join(dir, 'does-not-exist.json');
    expect(await seedBuiltinTemplates()).toBe('seeded_active');
    process.env.NS_SEED_FILE = await seedFile({ version: 'v1', templates: [{ channel: 'email' }] });
    expect(await seedBuiltinTemplates()).toBe('exists');
    expect(err).toHaveBeenCalledTimes(2);
    expect(await listTemplates({})).toHaveLength(1);
    expect(await listPolicies({})).toHaveLength(0);
  });
});
