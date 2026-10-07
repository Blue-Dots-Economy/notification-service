import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const vendor = vi.hoisted(() => ({ current: { vendor: 'pinnacle', renders: 'ns' as 'ns' | 'provider' } }));
vi.mock('../vendors', () => ({
  channelVendor: (channel: string) =>
    channel === 'sms' ? vendor.current : channel === 'email' ? { vendor: 'smtp', renders: 'ns' } : undefined,
}));

import { closeDb, getPool } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import {
  createTemplateDraft, getTemplate, hasActiveTemplate, listTemplates,
  publishTemplate, resolveTemplate, retireTemplate, updateTemplateDraft,
} from '../repo';
import { TemplateError } from '../errors';

process.env.NS_NETWORK = 'test_net';

beforeAll(async () => { await runMigrations(); });
afterAll(async () => { await closeDb(); });
beforeEach(async () => {
  vendor.current = { vendor: 'pinnacle', renders: 'ns' };
  await getPool().query(`DELETE FROM notification_policy; DELETE FROM template;`);
});

const otp = (locale = 'en') => ({
  channel: 'sms', templateKey: 'login_otp', locale, providerTemplateId: '1107',
  bodyText: '{{message}} is your OTP',
  variables: [{ name: 'message', required: true, type: 'string' as const, sensitive: true, raw: false }],
});

async function codeOf(p: Promise<unknown>) {
  try { await p; return undefined; } catch (e) { return (e as TemplateError).code; }
}

describe('template repository', () => {
  it('creates drafts with increasing versions under the deployment vendor and network', async () => {
    const a = await createTemplateDraft(otp(), 'admin');
    const b = await createTemplateDraft(otp(), 'admin');
    expect([a.version, b.version]).toEqual([1, 2]);
    expect(a).toMatchObject({ status: 'draft', provider: 'pinnacle', network: 'test_net', createdBy: 'admin' });
  });

  it('only edits drafts', async () => {
    const d = await createTemplateDraft(otp(), 'admin');
    const edited = await updateTemplateDraft(d.id, { approvalRef: 'DLT-9' });
    expect(edited.approvalRef).toBe('DLT-9');
    await publishTemplate(d.id, 'admin');
    expect(await codeOf(updateTemplateDraft(d.id, { approvalRef: 'x' }))).toBe('invalid_state');
  });

  it('publishing retires the previous active version', async () => {
    const v1 = await createTemplateDraft(otp(), 'admin');
    await publishTemplate(v1.id, 'admin');
    const v2 = await createTemplateDraft(otp(), 'admin');
    const published = await publishTemplate(v2.id, 'publisher');
    expect(published).toMatchObject({ status: 'active', publishedBy: 'publisher' });
    expect((await getTemplate(v1.id)).status).toBe('retired');
  });

  it('concurrent publishes leave exactly one active', async () => {
    const a = await createTemplateDraft(otp(), 'admin');
    const b = await createTemplateDraft(otp(), 'admin');
    await Promise.all([publishTemplate(a.id, 'x'), publishTemplate(b.id, 'y')]);
    const active = await listTemplates({ templateKey: 'login_otp', status: 'active' });
    expect(active).toHaveLength(1);
  });

  it('refuses to publish an invalid draft and leaves it a draft', async () => {
    const d = await createTemplateDraft({ ...otp(), bodyText: 'no token' }, 'admin');
    expect(await codeOf(publishTemplate(d.id, 'admin'))).toBe('unused_variable');
    expect((await getTemplate(d.id)).status).toBe('draft');
  });

  it('retires without deleting', async () => {
    const d = await createTemplateDraft(otp(), 'admin');
    await publishTemplate(d.id, 'admin');
    expect((await retireTemplate(d.id)).status).toBe('retired');
    expect(await codeOf(retireTemplate(d.id))).toBe('invalid_state');
    expect(await hasActiveTemplate('sms', 'login_otp')).toBe(false);
  });

  it('resolves with locale fallback xx-YY → xx → default', async () => {
    const en = await createTemplateDraft(otp('en'), 'admin');
    await publishTemplate(en.id, 'admin');
    const hi = await createTemplateDraft(otp('hi'), 'admin');
    await publishTemplate(hi.id, 'admin');
    expect((await resolveTemplate('sms', 'login_otp', 'hi-IN')).template.locale).toBe('hi');
    expect((await resolveTemplate('sms', 'login_otp', 'ta-IN')).template.locale).toBe('en');
    expect((await resolveTemplate('sms', 'login_otp')).template.locale).toBe('en');
    expect(await codeOf(resolveTemplate('sms', 'nope'))).toBe('not_found');
  });

  it('resolve refuses a template for another vendor', async () => {
    const d = await createTemplateDraft(otp(), 'admin');
    await publishTemplate(d.id, 'admin');
    vendor.current = { vendor: 'msg91', renders: 'provider' };
    expect(await codeOf(resolveTemplate('sms', 'login_otp'))).toBe('vendor_mismatch');
  });

  it('scopes everything to NS_NETWORK', async () => {
    await createTemplateDraft(otp(), 'admin');
    process.env.NS_NETWORK = 'other_net';
    try {
      expect(await listTemplates({})).toHaveLength(0);
    } finally {
      process.env.NS_NETWORK = 'test_net';
    }
  });
});
