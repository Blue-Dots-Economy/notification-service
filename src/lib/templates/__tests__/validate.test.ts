import { describe, expect, it } from 'vitest';
import { validateForPublish } from '../validate';
import { TemplateError } from '../errors';
import type { TemplateRow, VariableSpec } from '../../db/schema';

const v = (over: Partial<VariableSpec> & { name: string }): VariableSpec => ({
  required: true, type: 'string', sensitive: false, raw: false, ...over,
});
function row(over: Partial<TemplateRow>): TemplateRow {
  return {
    id: 'id', network: 'n', channel: 'sms', templateKey: 'k', locale: 'en', version: 1,
    status: 'draft', subject: null, bodyHtml: null, bodyText: null, variables: [],
    provider: 'pinnacle', providerTemplateId: '1107', senderId: null, dltEntityId: null,
    dltHeaderId: null, dltTagId: null, approvalRef: null, defaultDeadlineS: null,
    createdBy: 't', publishedBy: null, createdAt: new Date(), updatedAt: new Date(),
    publishedAt: null, retiredAt: null, ...over,
  };
}
const codeOf = (fn: () => void) => { try { fn(); return undefined; } catch (e) { return (e as TemplateError).code; } };
const pinnacle = { vendor: 'pinnacle', renders: 'ns' as const };
const msg91 = { vendor: 'msg91', renders: 'provider' as const };

describe('validateForPublish', () => {
  it('requires a known channel and the deployment vendor', () => {
    expect(codeOf(() => validateForPublish(row({}), undefined))).toBe('unknown_channel');
    expect(codeOf(() => validateForPublish(row({ provider: 'msg91' }), pinnacle))).toBe('vendor_mismatch');
  });
  it('requires an id, and a body when NS renders', () => {
    expect(codeOf(() => validateForPublish(row({ providerTemplateId: null }), pinnacle))).toBe('incomplete_template');
    expect(codeOf(() => validateForPublish(row({}), pinnacle))).toBe('incomplete_template');
    expect(codeOf(() => validateForPublish(row({ provider: 'msg91' }), msg91))).toBeUndefined();
  });
  it('checks tokens both ways when a body is stored', () => {
    expect(codeOf(() => validateForPublish(row({ bodyText: 'Hi {{name}}' }), pinnacle))).toBe('undeclared_token');
    expect(codeOf(() => validateForPublish(row({ bodyText: 'Hi', variables: [v({ name: 'name' })] }), pinnacle))).toBe('unused_variable');
    expect(codeOf(() => validateForPublish(row({ bodyText: 'Hi {{name}}', variables: [v({ name: 'name' })] }), pinnacle))).toBeUndefined();
  });
  it('limits stored sms length by message type', () => {
    expect(codeOf(() => validateForPublish(row({ bodyText: 'a'.repeat(2001) }), pinnacle))).toBe('body_too_long');
    expect(codeOf(() => validateForPublish(row({ bodyText: 'अ'.repeat(751) }), pinnacle))).toBe('body_too_long');
  });
  it('requires subject and body for email', () => {
    const smtp = { vendor: 'smtp', renders: 'ns' as const };
    const email = row({ channel: 'email', provider: 'smtp', providerTemplateId: null });
    expect(codeOf(() => validateForPublish(email, smtp))).toBe('incomplete_template');
    expect(codeOf(() => validateForPublish({ ...email, subject: 'S', bodyHtml: '<p>x</p>' }, smtp))).toBeUndefined();
  });
  it('rejects raw outside email and an unparseable contract', () => {
    expect(codeOf(() => validateForPublish(row({ bodyText: '{{a}}', variables: [v({ name: 'a', raw: true })] }), pinnacle))).toBe('invalid_contract');
    expect(codeOf(() => validateForPublish(row({ provider: 'msg91', variables: [{ name: 'a-b' } as VariableSpec] }), msg91))).toBe('invalid_contract');
  });
  it('rejects a malformed token on every channel', () => {
    const smtp = { vendor: 'smtp', renders: 'ns' as const };
    const email = row({ channel: 'email', provider: 'smtp', providerTemplateId: null, subject: 'S', variables: [v({ name: 'name' })] });
    const err = (() => { try { validateForPublish({ ...email, bodyHtml: '<p>Hi {{ name }}</p>' }, smtp); } catch (e) { return e as TemplateError; } })();
    expect(err).toMatchObject({ code: 'undeclared_token', details: { malformed: true } });
    expect(codeOf(() => validateForPublish({ ...email, subject: 'Hi {{name}', bodyHtml: '<p>{{name}}</p>' }, smtp))).toBe('undeclared_token');
    expect(codeOf(() => validateForPublish({ ...email, bodyHtml: '<p>{{name}}</p>', bodyText: 'x }} y' }, smtp))).toBe('undeclared_token');
    expect(codeOf(() => validateForPublish(row({ bodyText: 'Hi {{ name }}', variables: [v({ name: 'name' })] }), pinnacle))).toBe('undeclared_token');
    expect(codeOf(() => validateForPublish(row({ provider: 'msg91', bodyText: 'Hi {{na-me}}' }), msg91))).toBe('undeclared_token');
    expect(codeOf(() => validateForPublish({ ...email, bodyHtml: '<p>{{name}}</p>' }, smtp))).toBeUndefined();
  });
  it('requires href/src variables in email html to be url-typed', () => {
    const smtp = { vendor: 'smtp', renders: 'ns' as const };
    const email = row({ channel: 'email', provider: 'smtp', providerTemplateId: null, subject: 'S' });
    const withVar = (bodyHtml: string, type: VariableSpec['type']) =>
      codeOf(() => validateForPublish({ ...email, bodyHtml, variables: [v({ name: 'link', type })] }, smtp));
    for (const html of [
      '<a href="{{link}}">x</a>',
      "<a href='{{link}}'>x</a>",
      '<a href={{link}}>x</a>',
      '<img SRC = "https://cdn/{{link}}">',
    ]) {
      expect(withVar(html, 'string')).toBe('invalid_contract');
      expect(withVar(html, 'url')).toBeUndefined();
    }
    const err = (() => { try { validateForPublish({ ...email, bodyHtml: '<a href="{{link}}">x</a>', variables: [v({ name: 'link' })] }, smtp); } catch (e) { return e as TemplateError; } })();
    expect(err?.message).toContain('link');
    expect(err?.details).toEqual({ variable: 'link' });
    // Outside an attribute value a string variable is fine.
    expect(withVar('<a href="https://x.test">{{link}}</a>', 'string')).toBeUndefined();
  });
});
