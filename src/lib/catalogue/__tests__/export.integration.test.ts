import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Def = { name: string; vendor: string; renders: 'ns' | 'provider'; templates: Record<string, string>; bodies?: Record<string, string> };
const msg91: Def = { name: 'sms', vendor: 'msg91', renders: 'provider', templates: { login_otp: 'flow-otp' } };
vi.mock('../../providers', () => ({
  providers: {
    sms: { name: 'sms', vendor: 'msg91', renders: 'provider', templates: { login_otp: 'flow-otp' } },
    email: { name: 'email', vendor: 'smtp', renders: 'ns', templates: {} },
  },
}));
void msg91;

import { closeDb, getPool } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { listPolicies, retirePolicy } from '../../policies/repo';
import { createTemplateDraft, listTemplates, retireTemplate } from '../../templates/repo';
import { exportCatalogue } from '../export';
import { parseCatalogue } from '../schema';
import { seedCatalogue } from '../seed';

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

beforeAll(async () => { await runMigrations(); });
afterAll(async () => { delete process.env.NS_NETWORK; await closeDb(); });
beforeEach(async () => {
  process.env.NS_NETWORK = 'net_a';
  await getPool().query(`DELETE FROM notification_policy; DELETE FROM template;`);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('exportCatalogue', () => {
  it('exports the active templates for current vendors and the policy, without ids or timestamps', async () => {
    await seedCatalogue(cat());
    const out = await exportCatalogue('x');
    expect(parseCatalogue(out)).toEqual(out);
    expect(out.version).toBe('x');
    expect(out.templates.map((t) => `${t.channel}/${t.template_key}/${t.provider}`)).toEqual([
      'email/item.paused/smtp',
      'sms/login_otp/msg91',
    ]);
    expect(out.policies).toEqual([
      { domain: 'seeker', event_type: 'item.paused', mode: 'first_available', channels: [{ channel: 'email', template_key: 'item.paused' }] },
    ]);
    const text = JSON.stringify(out);
    for (const k of ['"id"', 'created_at', 'updated_at', 'created_by', 'published_at', '"version":"v', '"network"', 'status']) {
      expect(text).not.toContain(k);
    }
  });

  it('round-trips: seeding an empty network from an export reproduces the export', async () => {
    await seedCatalogue(cat());
    const a = await exportCatalogue('x');

    process.env.NS_NETWORK = 'net_b';
    expect(await listTemplates({})).toHaveLength(0);
    await seedCatalogue(a);
    const b = await exportCatalogue('x');
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('never exports draft or retired rows', async () => {
    await seedCatalogue(cat());
    await createTemplateDraft({ channel: 'email', templateKey: 'draft.only', subject: 'D', bodyHtml: '<p>d</p>' }, 'admin');
    const [email] = await listTemplates({ channel: 'email', templateKey: 'item.paused' });
    await retireTemplate(email!.id);
    const [policy] = await listPolicies({ eventType: 'item.paused' });
    await retirePolicy(policy!.id);

    const out = await exportCatalogue('x');
    expect(out.templates.map((t) => t.template_key)).toEqual(['login_otp']);
    expect(out.policies).toEqual([]);
  });
});
