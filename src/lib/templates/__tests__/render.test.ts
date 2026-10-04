import { describe, expect, it } from 'vitest';
import { escapeHtml, renderTemplate } from '../render';
import { TemplateError } from '../errors';
import type { TemplateRow, VariableSpec } from '../../db/schema';

const v = (over: Partial<VariableSpec> & { name: string }): VariableSpec => ({
  required: true, type: 'string', sensitive: false, raw: false, ...over,
});

function row(over: Partial<TemplateRow>): TemplateRow {
  return {
    id: 'id', network: 'n', channel: 'email', templateKey: 'k', locale: 'en', version: 1,
    status: 'active', subject: null, bodyHtml: null, bodyText: null, variables: [],
    provider: 'smtp', providerTemplateId: null, senderId: null, dltEntityId: null,
    dltHeaderId: null, dltTagId: null, approvalRef: null, defaultDeadlineS: null,
    createdBy: 't', publishedBy: null, createdAt: new Date(), updatedAt: new Date(),
    publishedAt: null, retiredAt: null, ...over,
  };
}

describe('escapeHtml', () => {
  it('escapes the five html metacharacters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});

describe('renderTemplate — email', () => {
  const t = row({
    subject: 'Hello {{name}}',
    bodyHtml: '<p>{{name}}</p><div>{{snippet}}</div>',
    bodyText: 'Hi {{name}}',
    variables: [v({ name: 'name' }), v({ name: 'snippet', raw: true, required: false })],
  });

  it('escapes html by default and only raw is verbatim', () => {
    const r = renderTemplate(t, 'ns', { name: '<script>x</script>', snippet: '<b>ok</b>' });
    expect(r).toMatchObject({ mode: 'ns', channel: 'email' });
    if (r.mode !== 'ns' || r.channel !== 'email') throw new Error('unreachable');
    expect(r.html).toBe('<p>&lt;script&gt;x&lt;/script&gt;</p><div><b>ok</b></div>');
    expect(r.text).toBe('Hi <script>x</script>');
  });

  it('collapses CR/LF in the subject', () => {
    const r = renderTemplate(t, 'ns', { name: 'A\r\nBcc: x@y.z' });
    if (r.mode !== 'ns' || r.channel !== 'email') throw new Error('unreachable');
    expect(r.subject).toBe('Hello A Bcc: x@y.z');
  });

  it('renders an absent optional variable as empty', () => {
    const r = renderTemplate(t, 'ns', { name: 'A' });
    if (r.mode !== 'ns' || r.channel !== 'email') throw new Error('unreachable');
    expect(r.html).toBe('<p>A</p><div></div>');
  });

  it('validates variables before rendering', () => {
    expect(() => renderTemplate(t, 'ns', {})).toThrow(TemplateError);
  });

  it('never picks up an inherited Object.prototype value for a token', () => {
    const bad = row({
      bodyHtml: '<p>{{toString}}</p>', subject: 's', variables: [],
    });
    const r = renderTemplate(bad, 'ns', {});
    if (r.mode !== 'ns' || r.channel !== 'email') throw new Error('unreachable');
    expect(r.html).toBe('<p></p>');
  });
});

describe('renderTemplate — sms', () => {
  it('renders an ns-rendered sms body without escaping and reports its type', () => {
    const t = row({
      channel: 'sms', provider: 'pinnacle', providerTemplateId: '1107',
      bodyText: '{{message}} is your OTP & valid 5 min', variables: [v({ name: 'message', sensitive: true })],
    });
    expect(renderTemplate(t, 'ns', { message: '123456' })).toEqual({
      mode: 'ns', channel: 'sms', text: '123456 is your OTP & valid 5 min', messageType: 'TXT',
    });
  });

  it('refuses a rendered body over the vendor ceiling', () => {
    const t = row({
      channel: 'sms', provider: 'pinnacle', providerTemplateId: '1', bodyText: '{{x}}',
      variables: [v({ name: 'x' })],
    });
    try {
      renderTemplate(t, 'ns', { x: 'a'.repeat(2001) });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as TemplateError).code).toBe('body_too_long');
    }
  });

  it('passes id + validated variables through for vendor-rendered templates', () => {
    const t = row({
      channel: 'sms', provider: 'msg91', providerTemplateId: 'flow-1',
      variables: [v({ name: 'message', sensitive: true })],
    });
    expect(renderTemplate(t, 'provider', { message: '42' })).toEqual({
      mode: 'provider', channel: 'sms', providerTemplateId: 'flow-1', variables: { message: '42' },
    });
  });

  it('fails incomplete templates', () => {
    const t = row({ channel: 'sms', provider: 'pinnacle', providerTemplateId: '1', variables: [] });
    try {
      renderTemplate(t, 'ns', {});
      throw new Error('expected throw');
    } catch (e) {
      expect((e as TemplateError).code).toBe('incomplete_template');
    }
  });
});
