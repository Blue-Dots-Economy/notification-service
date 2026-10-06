import { describe, expect, it } from 'vitest';
import { parseCatalogue, TemplateCreateSchema } from '../schema';

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

  it('requires provider on non-email entries; email may omit it', () => {
    expect(parseCatalogue({ version: 'v1', templates: [tpl()] }).templates[0].provider).toBeUndefined();
    for (const channel of ['sms', 'whatsapp']) {
      expect(() => parseCatalogue({ version: 'v1', templates: [tpl({ channel, body_html: undefined, body_text: 'x {{name}} {{noun}}' })] }))
        .toThrow('catalogue is invalid at: templates.0.provider');
    }
  });

  it('keeps provider off the admin create body', () => {
    expect(TemplateCreateSchema.safeParse(tpl({ provider: 'smtp' })).success).toBe(false);
    expect(TemplateCreateSchema.safeParse(tpl()).success).toBe(true);
  });

  it.each([
    [{ version: 'v1', templates: [tpl({ template_key: 'Item.Paused' })] }, 'templates.0.template_key'],
    [{ version: 'v1', templates: [tpl({ variables: [{ name: 'name', type: 'date' }] })] }, 'templates.0.variables.0.type'],
    [{ version: 'v1', templates: [tpl({ id: 'x' })] }, 'templates.0'],
    [{ version: 'v1', policies: [pol({ mode: 'single' })] }, 'policies.0.mode'],
    [{ version: 'bad version', templates: [] }, 'version'],
    [{ version: 'v1', extra: 1 }, '(root)'],
  ])('rejects the whole file on one invalid entry: %#', (raw, path) => {
    expect(() => parseCatalogue(raw)).toThrow(`catalogue is invalid at: ${path}`);
  });

  it('never echoes values in the error', () => {
    const bad = { version: 'v1', templates: [tpl({ template_key: 'SECRET-VALUE-X' })] };
    expect(() => parseCatalogue(bad)).toThrow('catalogue is invalid at: templates.0.template_key');
    try {
      parseCatalogue(bad);
    } catch (e) {
      expect((e as Error).message).not.toContain('SECRET-VALUE-X');
    }
  });

  it('rejects duplicate template and policy entries', () => {
    expect(() => parseCatalogue({ version: 'v1', templates: [tpl(), tpl()] })).toThrow(/duplicate template/);
    expect(() => parseCatalogue({ version: 'v1', policies: [pol(), pol()] })).toThrow(/duplicate policy/);
    expect(() => parseCatalogue({ version: 'v1', templates: [tpl(), tpl({ locale: 'hi' })] })).not.toThrow();
  });

  it('caps list sizes at 500', () => {
    const templates = (n: number) => Array.from({ length: n }, (_, i) => tpl({ template_key: `k${i}` }));
    const policies = (n: number) => Array.from({ length: n }, (_, i) => pol({ event_type: `e${i}` }));
    expect(parseCatalogue({ version: 'v1', templates: templates(500), policies: policies(500) }).templates).toHaveLength(500);
    expect(() => parseCatalogue({ version: 'v1', templates: templates(501) })).toThrow('catalogue is invalid at: templates');
    expect(() => parseCatalogue({ version: 'v1', policies: policies(501) })).toThrow('catalogue is invalid at: policies');
  });
});
