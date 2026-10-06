import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const policies = vi.hoisted(() => ({ resolvePolicy: vi.fn() }));
const templates = vi.hoisted(() => ({ resolveTemplate: vi.fn() }));
vi.mock('../../policies/repo', () => policies);
vi.mock('../../templates/repo', () => templates);

import { planSend } from '../plan';
import { clearResolveCache } from '../resolver-cache';
import { SendError, classify } from '../errors';
import { TemplateError } from '../../templates/errors';
import { V1NotifySchema } from '../request';
import { parseContentDocument } from '../../content/configmap';
import { setContentForTests } from '../../content/resolver';
import { contentRefsFor } from '../../content/refs';

const v = (name: string, extra = {}) => ({ name, required: true, type: 'string', sensitive: false, raw: false, ...extra });
const tpl = (over: Record<string, unknown>) => ({
  id: 'id', network: 'n', channel: 'sms', templateKey: 'k', locale: 'en', version: 1, status: 'active',
  subject: null, bodyHtml: null, bodyText: null, variables: [], provider: 'msg91', providerTemplateId: 'flow',
  senderId: null, dltEntityId: null, dltHeaderId: null, dltTagId: null, approvalRef: null, defaultDeadlineS: null,
  createdBy: 't', publishedBy: null, createdAt: new Date(), updatedAt: new Date(), publishedAt: null, retiredAt: null, ...over,
});
const req = (b: Record<string, unknown>) => V1NotifySchema.parse(b);
async function codeOf(p: Promise<unknown>) { try { await p; return undefined; } catch (e) { return (e as SendError).code ?? (e as Error).message; } }

beforeEach(() => {
  process.env.NS_NETWORK = 'n';
  policies.resolvePolicy.mockReset();
  templates.resolveTemplate.mockReset();
  clearResolveCache();
});

const smsT = tpl({ channel: 'sms', templateKey: 'apply_sms', variables: [v('name')] });
const emailT = tpl({ channel: 'email', templateKey: 'apply_email', provider: 'smtp', providerTemplateId: null, subject: 'Hi {{name}}', bodyHtml: '<p>{{name}} {{link}}</p>', variables: [v('name'), v('link', { type: 'url' })] });

function policy(mode: 'first_available' | 'all') {
  policies.resolvePolicy.mockResolvedValue({ mode, channels: [{ channel: 'sms', template_key: 'apply_sms' }, { channel: 'email', template_key: 'apply_email' }] });
  templates.resolveTemplate.mockImplementation(async (channel: string) =>
    channel === 'sms' ? { template: smsT, renders: 'provider' } : { template: emailT, renders: 'ns' });
}

describe('planSend', () => {
  it('each planned template renders only its own variables', async () => {
    policy('first_available');
    const plan = await planSend(req({ event_type: 'apply', to: { phone: '+919999999999', email: 'a@b.co' }, variables: { name: 'A', link: 'https://x.org/' } }));
    expect(plan.deliveries.map((d) => d.channel)).toEqual(['sms', 'email']);
    expect(plan.deliveries[0]!.rendered).toMatchObject({ mode: 'provider', variables: { name: 'A' } });
    expect(plan.deliveries[1]!.rendered).toMatchObject({ mode: 'ns' });
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
    clearResolveCache(); // the template changed under the same key
    expect((await planSend(req({ ...base, priority: 'urgent' }), now)).deadline).toBe(now + 600_000);
    expect((await planSend(req(base), now)).deadline).toBeUndefined();
  });

  it('urgent is redacted even without sensitive variables; normal non-sensitive is not', async () => {
    templates.resolveTemplate.mockResolvedValue({ template: smsT, renders: 'provider' });
    const base = { template_key: 'apply_sms', channel: 'sms', to: { phone: '+919999999999' }, variables: { name: 'A' } };
    expect((await planSend(req({ ...base, priority: 'urgent' }))).redact).toBe(true);
    expect((await planSend(req(base))).redact).toBe(false);
  });

  it('when every candidate is skipped, the first remembered configuration error is thrown', async () => {
    policy('first_available');
    templates.resolveTemplate.mockImplementation(async (channel: string) => {
      if (channel === 'sms') throw new TemplateError('vendor_mismatch', 'sms');
      throw new TemplateError('not_found', 'email');
    });
    const e = await planSend(req({ event_type: 'apply', to: { phone: '+919999999999', email: 'a@b.co' } })).catch((x) => x);
    expect(e).toMatchObject({ code: 'vendor_mismatch', kind: 'configuration' });
  });

  it('all: a configuration render error skips that channel while another succeeds', async () => {
    policy('all');
    const brokenSms = tpl({ channel: 'sms', templateKey: 'apply_sms', providerTemplateId: null, variables: [v('name')] });
    templates.resolveTemplate.mockImplementation(async (channel: string) =>
      channel === 'sms' ? { template: brokenSms, renders: 'provider' } : { template: emailT, renders: 'ns' });
    const plan = await planSend(req({ event_type: 'apply', to: { phone: '+919999999999', email: 'a@b.co' }, variables: { name: 'A', link: 'https://x.org/' } }));
    expect(plan.mode).toBe('all');
    expect(plan.deliveries.map((d) => d.channel)).toEqual(['email']);
  });

  it('a caller error overrides an earlier skipped configuration error', async () => {
    policy('first_available');
    const brokenSms = tpl({ channel: 'sms', templateKey: 'apply_sms', providerTemplateId: null, variables: [v('name')] });
    templates.resolveTemplate.mockImplementation(async (channel: string) =>
      channel === 'sms' ? { template: brokenSms, renders: 'provider' } : { template: emailT, renders: 'ns' });
    const e = await planSend(req({ event_type: 'apply', to: { phone: '+919999999999', email: 'a@b.co' }, variables: { name: 'A', link: 'javascript:x' } })).catch((x) => x);
    expect(e).toMatchObject({ code: 'invalid_variable', kind: 'caller' });
  });

  it.each(['__proto__', 'constructor'])('a %s variable key is unknown_variable', async (key) => {
    templates.resolveTemplate.mockResolvedValue({ template: smsT, renders: 'provider' });
    // Zod's record drops a __proto__ key and Fastify rejects one in a JSON body;
    // planSend must still refuse it if it ever arrives as an own property.
    const variables = JSON.parse(`{"name":"A","${key}":"x"}`) as Record<string, unknown>;
    const parsed = { ...req({ template_key: 'apply_sms', channel: 'sms', to: { phone: '+919999999999' } }), variables };
    const e = await planSend(parsed).catch((x) => x);
    expect(e).toMatchObject({ code: 'unknown_variable', kind: 'caller' });
  });

  it('deadline: the smallest default_deadline_s among planned templates wins', async () => {
    const now = Date.parse('2026-10-04T00:00:00Z');
    policy('all');
    templates.resolveTemplate.mockImplementation(async (channel: string) =>
      channel === 'sms'
        ? { template: { ...smsT, defaultDeadlineS: 300 }, renders: 'provider' }
        : { template: { ...emailT, defaultDeadlineS: 90 }, renders: 'ns' });
    const plan = await planSend(req({ event_type: 'apply', to: { phone: '+919999999999', email: 'a@b.co' }, variables: { name: 'A', link: 'https://x.org/' } }), now);
    expect(plan.deadline).toBe(now + 90_000);
  });

  it('variables are the validated (normalised) values the templates rendered with', async () => {
    templates.resolveTemplate.mockResolvedValue({ template: emailT, renders: 'ns' });
    const plan = await planSend(req({ template_key: 'apply_email', channel: 'email', to: { email: 'a@b.co' }, variables: { name: 'A', link: 'https://X.org' } }));
    expect(plan.variables).toEqual({ name: 'A', link: 'https://x.org/' });
  });

  it.each(['unknown_content_key', 'content_unavailable', 'content_unresolved', 'invalid_content'])('content error %s classifies as configuration', (code) => {
    expect(classify(code)).toBe('configuration');
  });
});

describe('planSend — event variables span every policy template', () => {
  const guardianEmail = tpl({ channel: 'email', templateKey: 'guardian.account', provider: 'smtp', providerTemplateId: null, subject: 'S', bodyHtml: '<p>{{message}} {{parentName}}</p>', variables: [v('message'), v('parentName')] });
  const loginOtp = tpl({ channel: 'sms', templateKey: 'login_otp', variables: [v('message')] });
  const phoneOnly = { phone: '+919999999999' };
  const setup = (emailResolves = true) => {
    policies.resolvePolicy.mockResolvedValue({ mode: 'first_available', channels: [{ channel: 'email', template_key: 'guardian.account' }, { channel: 'sms', template_key: 'login_otp' }] });
    templates.resolveTemplate.mockImplementation(async (channel: string) => {
      if (channel === 'email') {
        if (!emailResolves) throw new TemplateError('not_found', 'no active email template');
        return { template: guardianEmail, renders: 'ns' };
      }
      return { template: loginOtp, renders: 'provider' };
    });
  };

  it('phone-only event accepts email-only variables', async () => {
    setup();
    const plan = await planSend(req({ event_type: 'guardian.otp.account', to: phoneOnly, variables: { message: '123456', parentName: 'P' } }));
    expect(plan.deliveries).toHaveLength(1);
    expect(plan.deliveries[0]!.channel).toBe('sms');
    expect(plan.deliveries[0]!.rendered).toMatchObject({ mode: 'provider', variables: { message: '123456' } });
    expect(Object.keys((plan.deliveries[0]!.rendered as { variables: object }).variables)).toEqual(['message']);
  });

  it('an event variable no template uses is ignored', async () => {
    setup();
    const plan = await planSend(req({ event_type: 'guardian.otp.account', to: phoneOnly, variables: { message: '1', bogus: 'x' } }));
    expect(plan.deliveries[0]!.rendered).toMatchObject({ variables: { message: '1' } });
    expect(Object.keys((plan.deliveries[0]!.rendered as { variables: object }).variables)).toEqual(['message']);
  });

  it('planning resolves only the delivered candidate', async () => {
    setup();
    await planSend(req({ event_type: 'guardian.otp.account', to: phoneOnly, variables: { message: '1', parentName: 'P' } }));
    expect(templates.resolveTemplate).toHaveBeenCalledTimes(1);
    expect(templates.resolveTemplate.mock.calls[0]![0]).toBe('sms');
  });

  it('template_key send with an unknown variable is still unknown_variable', async () => {
    templates.resolveTemplate.mockResolvedValue({ template: loginOtp, renders: 'provider' });
    const e = await planSend(req({ template_key: 'login_otp', channel: 'sms', to: phoneOnly, variables: { message: '1', bogus: 'x' } })).catch((x) => x);
    expect(e).toMatchObject({ code: 'unknown_variable', kind: 'caller' });
  });

  it('event send missing a required variable of a planned template is missing_variable', async () => {
    setup();
    expect(await codeOf(planSend(req({ event_type: 'guardian.otp.account', to: phoneOnly, variables: { parentName: 'P' } })))).toBe('missing_variable');
  });
});

describe('planSend — content_ref variables', () => {
  const tncV = v('tnc_url', { type: 'url', source: 'content_ref', contentKey: 'tnc.in_force.url', urlHosts: ['example.org'] });
  const tncSms = tpl({ channel: 'sms', templateKey: 'tnc_sms', variables: [v('name'), tncV] });
  const plainEmail = tpl({ channel: 'email', templateKey: 'tnc_email', provider: 'smtp', providerTemplateId: null, subject: 'Hi {{name}}', bodyText: 'Hi {{name}}', variables: [v('name')] });
  const loadTnc = () => setContentForTests(parseContentDocument({ version: 'v3', entries: { 'tnc.in_force.url': { en: 'https://example.org/tnc' } } }));
  afterEach(() => setContentForTests(null));

  it('unresolved content refuses the send', async () => {
    templates.resolveTemplate.mockResolvedValue({ template: tncSms, renders: 'provider' });
    const e = await planSend(req({ template_key: 'tnc_sms', channel: 'sms', to: { phone: '+919999999999' }, variables: { name: 'A' } })).catch((x) => x);
    expect(e).toBeInstanceOf(SendError);
    expect(e).toMatchObject({ code: 'content_unavailable', kind: 'configuration' });
  });

  it('a caller naming a content variable is unknown_variable', async () => {
    loadTnc();
    templates.resolveTemplate.mockResolvedValue({ template: tncSms, renders: 'provider' });
    const e = await planSend(req({ template_key: 'tnc_sms', channel: 'sms', to: { phone: '+919999999999' }, variables: { name: 'A', tnc_url: 'https://example.org/other' } })).catch((x) => x);
    expect(e).toMatchObject({ code: 'unknown_variable', kind: 'caller', details: { variables: ['tnc_url'] } });
  });

  it('content renders into the delivery and contentRefs is set', async () => {
    loadTnc();
    templates.resolveTemplate.mockResolvedValue({ template: tncSms, renders: 'provider' });
    const plan = await planSend(req({ template_key: 'tnc_sms', channel: 'sms', to: { phone: '+919999999999' }, variables: { name: 'A' } }));
    expect(plan.deliveries[0]!.rendered).toMatchObject({ mode: 'provider', variables: { name: 'A', tnc_url: 'https://example.org/tnc' } });
    expect(plan.deliveries[0]!.contentRefs).toEqual([{ key: 'tnc.in_force.url', version: 'v3', locale: 'en' }]);
  });

  it('two content variables on one key: the per-channel map records the ref once', async () => {
    loadTnc();
    const tncV2 = v('tnc_link', { type: 'url', source: 'content_ref', contentKey: 'tnc.in_force.url' });
    const twice = tpl({ channel: 'sms', templateKey: 'tnc_sms', variables: [v('name'), tncV, tncV2] });
    templates.resolveTemplate.mockResolvedValue({ template: twice, renders: 'provider' });
    const plan = await planSend(req({ template_key: 'tnc_sms', channel: 'sms', to: { phone: '+919999999999' }, variables: { name: 'A' } }));
    expect(plan.deliveries[0]!.rendered).toMatchObject({ variables: { tnc_url: 'https://example.org/tnc', tnc_link: 'https://example.org/tnc' } });
    expect(contentRefsFor(plan.deliveries)).toEqual({ contentRefs: { sms: [{ key: 'tnc.in_force.url', version: 'v3', locale: 'en' }] } });
  });

  it('a delivery with no content variables has empty contentRefs', async () => {
    policy('first_available');
    const plan = await planSend(req({ event_type: 'apply', to: { phone: '+919999999999' }, variables: { name: 'A' } }));
    expect(plan.deliveries[0]!.contentRefs).toEqual([]);
  });

  it('first_available skips a candidate whose content is unresolved and uses the next', async () => {
    policies.resolvePolicy.mockResolvedValue({ mode: 'first_available', channels: [{ channel: 'sms', template_key: 'tnc_sms' }, { channel: 'email', template_key: 'tnc_email' }] });
    templates.resolveTemplate.mockImplementation(async (channel: string) =>
      channel === 'sms' ? { template: tncSms, renders: 'provider' } : { template: plainEmail, renders: 'ns' });
    const plan = await planSend(req({ event_type: 'tnc', to: { phone: '+919999999999', email: 'a@b.co' }, variables: { name: 'A' } }));
    expect(plan.deliveries.map((d) => d.channel)).toEqual(['email']);
    expect(plan.deliveries[0]!.contentRefs).toEqual([]);
  });

  it('an event send renders the resolved content value in every delivered template', async () => {
    loadTnc();
    const tncEmail = tpl({ channel: 'email', templateKey: 'tnc_email', provider: 'smtp', providerTemplateId: null, subject: 'Hi {{name}}', bodyText: 'Terms: {{tnc_url}}', variables: [v('name'), tncV] });
    policies.resolvePolicy.mockResolvedValue({ mode: 'all', channels: [{ channel: 'sms', template_key: 'tnc_sms' }, { channel: 'email', template_key: 'tnc_email' }] });
    templates.resolveTemplate.mockImplementation(async (channel: string) =>
      channel === 'sms' ? { template: tncSms, renders: 'provider' } : { template: tncEmail, renders: 'ns' });
    const plan = await planSend(req({ event_type: 'tnc', to: { phone: '+919999999999', email: 'a@b.co' }, variables: { name: 'A' } }));
    expect(plan.deliveries.map((d) => d.channel)).toEqual(['sms', 'email']);
    expect(plan.deliveries[0]!.rendered).toMatchObject({ mode: 'provider', variables: { name: 'A', tnc_url: 'https://example.org/tnc' } });
    expect(plan.deliveries[1]!.rendered).toMatchObject({ mode: 'ns', channel: 'email', text: 'Terms: https://example.org/tnc' });
    for (const d of plan.deliveries) expect(d.contentRefs).toEqual([{ key: 'tnc.in_force.url', version: 'v3', locale: 'en' }]);
  });

  it('an event send carrying a content variable name renders the content value, not the caller value', async () => {
    loadTnc();
    policies.resolvePolicy.mockResolvedValue({ mode: 'first_available', channels: [{ channel: 'sms', template_key: 'tnc_sms' }] });
    templates.resolveTemplate.mockResolvedValue({ template: tncSms, renders: 'provider' });
    const plan = await planSend(req({ event_type: 'tnc', to: { phone: '+919999999999' }, variables: { name: 'A', tnc_url: 'https://example.org/other' } }));
    expect(plan.deliveries[0]!.rendered).toMatchObject({ mode: 'provider', variables: { name: 'A', tnc_url: 'https://example.org/tnc' } });
    expect(plan.deliveries[0]!.contentRefs).toEqual([{ key: 'tnc.in_force.url', version: 'v3', locale: 'en' }]);
  });

  it('first_available: when every candidate fails on content, the first configuration error is thrown', async () => {
    const tncEmail = tpl({ channel: 'email', templateKey: 'tnc_email', provider: 'smtp', providerTemplateId: null, subject: 'Hi {{name}}', bodyText: '{{tnc_url}}', variables: [v('name'), tncV] });
    policies.resolvePolicy.mockResolvedValue({ mode: 'first_available', channels: [{ channel: 'sms', template_key: 'tnc_sms' }, { channel: 'email', template_key: 'tnc_email' }] });
    templates.resolveTemplate.mockImplementation(async (channel: string) =>
      channel === 'sms' ? { template: tncSms, renders: 'provider' } : { template: tncEmail, renders: 'ns' });
    const e = await planSend(req({ event_type: 'tnc', to: { phone: '+919999999999', email: 'a@b.co' }, variables: { name: 'A' } })).catch((x) => x);
    expect(e).toBeInstanceOf(SendError);
    expect(e).toMatchObject({ code: 'content_unavailable', kind: 'configuration' });
  });
});
