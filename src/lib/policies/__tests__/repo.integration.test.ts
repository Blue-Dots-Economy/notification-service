import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../templates/vendors', () => ({
  channelVendor: (c: string) =>
    c === 'sms' ? { vendor: 'msg91', renders: 'provider' } : c === 'email' ? { vendor: 'smtp', renders: 'ns' } : undefined,
}));

import { closeDb, getPool } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { createTemplateDraft, publishTemplate } from '../../templates/repo';
import { createPolicyDraft, getPolicy, listPolicies, publishPolicy, resolvePolicy, retirePolicy, updatePolicyDraft } from '../repo';
import { TemplateError } from '../../templates/errors';

process.env.NS_NETWORK = 'test_net';

beforeAll(async () => { await runMigrations(); });
afterAll(async () => { await closeDb(); });
beforeEach(async () => {
  await getPool().query(`DELETE FROM notification_policy; DELETE FROM template;`);
  const t = await createTemplateDraft({ channel: 'sms', templateKey: 'otp_sms', providerTemplateId: 'flow-1' }, 'a');
  await publishTemplate(t.id, 'a');
});

async function codeOf(p: Promise<unknown>) {
  try { await p; return undefined; } catch (e) { return (e as TemplateError).code; }
}
const sms = [{ channel: 'sms', template_key: 'otp_sms' }];
async function active(domain: string | null, eventType: string | null, key = 'otp_sms') {
  const p = await createPolicyDraft({ domain, eventType, mode: 'first_available', channels: [{ channel: 'sms', template_key: key }] }, 'a');
  return publishPolicy(p.id, 'a');
}

describe('policy repository', () => {
  it('publish requires an active template per channel', async () => {
    const p = await createPolicyDraft({ eventType: 'apply', mode: 'all', channels: [{ channel: 'email', template_key: 'nope' }] }, 'a');
    expect(await codeOf(publishPolicy(p.id, 'a'))).toBe('incomplete_template');
    expect((await getPolicy(p.id)).status).toBe('draft');
  });

  it('rejects empty, duplicated and unknown channels', async () => {
    const empty = await createPolicyDraft({ mode: 'all', channels: [] }, 'a');
    expect(await codeOf(publishPolicy(empty.id, 'a'))).toBe('incomplete_template');
    const dup = await createPolicyDraft({ mode: 'all', channels: [...sms, ...sms] }, 'a');
    expect(await codeOf(publishPolicy(dup.id, 'a'))).toBe('invalid_contract');
    const fax = await createPolicyDraft({ mode: 'all', channels: [{ channel: 'fax', template_key: 'x' }] }, 'a');
    expect(await codeOf(publishPolicy(fax.id, 'a'))).toBe('unknown_channel');
  });

  it('most specific wins: (domain,event) > (null,event) > (domain,null) > (null,null)', async () => {
    const def = await active(null, null);
    expect((await resolvePolicy('seeker', 'apply'))?.id).toBe(def.id);
    const dom = await active('seeker', null);
    expect((await resolvePolicy('seeker', 'apply'))?.id).toBe(dom.id);
    const evt = await active(null, 'apply');
    expect((await resolvePolicy('seeker', 'apply'))?.id).toBe(evt.id);
    const exact = await active('seeker', 'apply');
    expect((await resolvePolicy('seeker', 'apply'))?.id).toBe(exact.id);
    expect((await resolvePolicy('provider', 'apply'))?.id).toBe(evt.id);
    expect((await resolvePolicy(undefined, 'shortlist'))?.id).toBe(def.id);
  });

  it('no policy at all → null', async () => {
    expect(await resolvePolicy('seeker', 'apply')).toBeNull();
  });

  it('publishing retires the previous active policy for the same scope; drafts only are editable', async () => {
    const v1 = await active(null, 'apply');
    const v2 = await active(null, 'apply');
    expect((await getPolicy(v1.id)).status).toBe('retired');
    expect(await codeOf(updatePolicyDraft(v2.id, { mode: 'all' }))).toBe('invalid_state');
    expect((await retirePolicy(v2.id)).status).toBe('retired');
    expect(await resolvePolicy(undefined, 'apply')).toBeNull();
  });

  it('concurrent publishes of different drafts for one scope leave exactly one active', async () => {
    const draft = () => createPolicyDraft({ eventType: 'apply', mode: 'first_available', channels: sms }, 'a');
    const a = await draft();
    const b = await draft();
    await Promise.all([publishPolicy(a.id, 'x'), publishPolicy(b.id, 'y')]);
    expect(await listPolicies({ eventType: 'apply', status: 'active' })).toHaveLength(1);
    expect(await listPolicies({ eventType: 'apply', status: 'retired' })).toHaveLength(1);
  });
});
