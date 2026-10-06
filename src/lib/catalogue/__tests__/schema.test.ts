import { describe, expect, it } from 'vitest';
import { parseCatalogue } from '../schema';

const tpl = (over: Record<string, unknown> = {}) => ({
  channel: 'email',
  template_key: 'item.paused',
  subject: 'Your {{noun}} is paused',
  body_html: '<p>Hi {{name}}, your {{noun}} is paused.</p>',
  variables: [{ name: 'name' }, { name: 'noun' }],
  ...over,
});
const pol = (over: Record<string, unknown> = {}) => ({
  domain: 'seeker',
  event_type: 'item.paused',
  mode: 'first_available',
  channels: [{ channel: 'email', template_key: 'item.paused' }],
  ...over,
});

describe('parseCatalogue', () => {
  it('accepts templates and policies, defaulting empty lists', () => {
    const c = parseCatalogue({ version: '2026-10-06', templates: [tpl()], policies: [pol()] });
    expect(c.templates[0].template_key).toBe('item.paused');
    expect(c.templates[0].variables?.[0]).toMatchObject({ name: 'name', required: true, source: 'request' });
    expect(parseCatalogue({ version: 'v1' })).toEqual({ version: 'v1', templates: [], policies: [] });
  });

  it('allows a provider on template entries', () => {
    const c = parseCatalogue({ version: 'v1', templates: [tpl({ channel: 'sms', provider: 'pinnacle', body_html: undefined, body_text: 'x {{name}} {{noun}}' })] });
    expect(c.templates[0].provider).toBe('pinnacle');
  });

  it.each([
    [{ version: 'v1', templates: [tpl({ template_key: 'Item.Paused' })] }, 'templates.0.template_key'],
    [{ version: 'v1', templates: [tpl({ variables: [{ name: 'name', type: 'date' }] })] }, 'templates.0.variables'],
    [{ version: 'v1', templates: [tpl({ id: 'x' })] }, 'templates.0'],
    [{ version: 'v1', policies: [pol({ mode: 'single' })] }, 'policies.0.mode'],
    [{ version: 'bad version', templates: [] }, 'version'],
    [{ version: 'v1', extra: 1 }, '(root)'],
  ])('rejects the whole file on one invalid entry: %#', (raw, path) => {
    expect(() => parseCatalogue(raw)).toThrow(path);
  });

  it('never echoes values in the error', () => {
    try {
      parseCatalogue({ version: 'v1', templates: [tpl({ template_key: 'SECRET-VALUE-X' })] });
    } catch (e) {
      expect((e as Error).message).not.toContain('SECRET-VALUE-X');
    }
  });

  it('rejects duplicate template and policy entries', () => {
    expect(() => parseCatalogue({ version: 'v1', templates: [tpl(), tpl()] })).toThrow(/duplicate template/);
    expect(() => parseCatalogue({ version: 'v1', policies: [pol(), pol()] })).toThrow(/duplicate policy/);
    expect(() => parseCatalogue({ version: 'v1', templates: [tpl(), tpl({ locale: 'hi' })] })).not.toThrow();
  });

  it('caps list sizes', () => {
    const many = Array.from({ length: 501 }, (_, i) => tpl({ template_key: `k${i}` }));
    expect(() => parseCatalogue({ version: 'v1', templates: many })).toThrow('templates');
  });
});
