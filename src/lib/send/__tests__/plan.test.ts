import { beforeEach, describe, expect, it, vi } from 'vitest';
const policies = vi.hoisted(() => ({ resolvePolicy: vi.fn() }));
const templates = vi.hoisted(() => ({ resolveTemplate: vi.fn() }));
vi.mock('../../policies/repo', () => policies);
vi.mock('../../templates/repo', () => templates);

import { planSend } from '../plan';
import { SendError } from '../errors';
import { TemplateError } from '../../templates/errors';
import { V1NotifySchema } from '../request';

const v = (name: string, extra = {}) => ({ name, required: true, type: 'string', sensitive: false, raw: false, ...extra });
const tpl = (over: Record<string, unknown>) => ({
  id: 'id', network: 'n', channel: 'sms', templateKey: 'k', locale: 'en', version: 1, status: 'active',
  subject: null, bodyHtml: null, bodyText: null, variables: [], provider: 'msg91', providerTemplateId: 'flow',
  senderId: null, dltEntityId: null, dltHeaderId: null, dltTagId: null, approvalRef: null, defaultDeadlineS: null,
  createdBy: 't', publishedBy: null, createdAt: new Date(), updatedAt: new Date(), publishedAt: null, retiredAt: null, ...over,
});
const req = (b: Record<string, unknown>) => V1NotifySchema.parse(b);
async function codeOf(p: Promise<unknown>) { try { await p; return undefined; } catch (e) { return (e as SendError).code ?? (e as Error).message; } }

beforeEach(() => { policies.resolvePolicy.mockReset(); templates.resolveTemplate.mockReset(); });

const smsT = tpl({ channel: 'sms', templateKey: 'apply_sms', variables: [v('name')] });
const emailT = tpl({ channel: 'email', templateKey: 'apply_email', provider: 'smtp', providerTemplateId: null, subject: 'Hi {{name}}', bodyHtml: '<p>{{name}} {{link}}</p>', variables: [v('name'), v('link', { type: 'url' })] });

function policy(mode: 'first_available' | 'all') {
  policies.resolvePolicy.mockResolvedValue({ mode, channels: [{ channel: 'sms', template_key: 'apply_sms' }, { channel: 'email', template_key: 'apply_email' }] });
  templates.resolveTemplate.mockImplementation(async (channel: string) =>
    channel === 'sms' ? { template: smsT, renders: 'provider' } : { template: emailT, renders: 'ns' });
}

describe('planSend', () => {
  it('variables are checked against the union of planned contracts', async () => {
    policy('first_available');
    const plan = await planSend(req({ event_type: 'apply', to: { phone: '+919999999999', email: 'a@b.co' }, variables: { name: 'A', link: 'https://x.org/' } }));
    expect(plan.deliveries.map((d) => d.channel)).toEqual(['sms', 'email']);
    expect(plan.deliveries[0]!.rendered).toMatchObject({ mode: 'provider', variables: { name: 'A' } });
    expect(await codeOf(planSend(req({ event_type: 'apply', to: { phone: '+919999999999' }, variables: { name: 'A', bogus: 'x' } })))).toBe('unknown_variable');
  });

  it('drops channels without a contact point', async () => {
    policy('all');
    const plan = await planSend(req({ event_type: 'apply', to: { phone: '+919999999999' }, variables: { name: 'A' } }));
    expect(plan.deliveries.map((d) => d.channel)).toEqual(['sms']);
    expect(plan.mode).toBe('all');
  });

  it('no policy and no reachable channel are distinct errors', async () => {
    policies.resolvePolicy.mockResolvedValue(null);
    expect(await codeOf(planSend(req({ event_type: 'x', to: { phone: '+919999999999' } })))).toBe('no_policy');
    policy('all');
    templates.resolveTemplate.mockResolvedValue({ template: smsT, renders: 'provider' });
    policies.resolvePolicy.mockResolvedValue({ mode: 'all', channels: [{ channel: 'email', template_key: 'apply_email' }] });
    const e = await planSend(req({ event_type: 'apply', to: { phone: '+919999999999' } })).catch((x) => x);
    expect(e).toMatchObject({ code: 'no_reachable_channel', kind: 'caller' });
  });

  it('first_available skips a candidate whose template is missing', async () => {
    policy('first_available');
    templates.resolveTemplate.mockImplementation(async (channel: string) => {
      if (channel === 'sms') throw new TemplateError('not_found', 'no active sms template');
      return { template: emailT, renders: 'ns' };
    });
    const plan = await planSend(req({ event_type: 'apply', to: { phone: '+919999999999', email: 'a@b.co' }, variables: { name: 'A', link: 'https://x.org/' } }));
    expect(plan.deliveries.map((d) => d.channel)).toEqual(['email']);
  });

  it('single template_key reports a configuration error', async () => {
    templates.resolveTemplate.mockRejectedValue(new TemplateError('vendor_mismatch', 'x'));
    const e = await planSend(req({ template_key: 'login_otp', channel: 'sms', to: { phone: '+919999999999' } })).catch((x) => x);
    expect(e).toMatchObject({ code: 'vendor_mismatch', kind: 'configuration' });
  });

  it('caller variable errors fail the whole request', async () => {
    policy('first_available');
    const e = await planSend(req({ event_type: 'apply', to: { phone: '+919999999999', email: 'a@b.co' }, variables: { name: 'A', link: 'javascript:x' } })).catch((x) => x);
    expect(e).toMatchObject({ code: 'invalid_variable', kind: 'caller' });
  });

  it('redacts urgent sends and sends with sensitive variables', async () => {
    templates.resolveTemplate.mockResolvedValue({ template: tpl({ templateKey: 'login_otp', variables: [v('message', { sensitive: true })] }), renders: 'provider' });
    const normal = await planSend(req({ template_key: 'login_otp', channel: 'sms', to: { phone: '+919999999999' }, variables: { message: '1' } }));
    expect(normal.redact).toBe(true);
  });

  it('deadline: request → template default → urgent default', async () => {
    const now = Date.parse('2026-10-04T00:00:00Z');
    templates.resolveTemplate.mockResolvedValue({ template: tpl({ templateKey: 'k', defaultDeadlineS: 120 }), renders: 'provider' });
    const base = { template_key: 'k', channel: 'sms', to: { phone: '+919999999999' } };
    expect((await planSend(req({ ...base, deadline: '2026-10-04T00:05:00Z' }), now)).deadline).toBe(now + 300_000);
    expect((await planSend(req(base), now)).deadline).toBe(now + 120_000);
    templates.resolveTemplate.mockResolvedValue({ template: tpl({ templateKey: 'k' }), renders: 'provider' });
    expect((await planSend(req({ ...base, priority: 'urgent' }), now)).deadline).toBe(now + 600_000);
    expect((await planSend(req(base), now)).deadline).toBeUndefined();
  });
});
