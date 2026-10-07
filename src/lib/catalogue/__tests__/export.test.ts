import { beforeEach, describe, expect, it, vi } from 'vitest';

const repo = vi.hoisted(() => ({ listTemplates: vi.fn(), listPolicies: vi.fn() }));
vi.mock('../../templates/repo', () => ({ listTemplates: repo.listTemplates }));
vi.mock('../../policies/repo', () => ({ listPolicies: repo.listPolicies }));
vi.mock('../../templates/vendors', () => ({
  channelVendor: (c: string) => (c === 'email' ? { vendor: 'smtp', renders: 'ns' } : c === 'sms' ? { vendor: 'msg91', renders: 'provider' } : undefined),
}));

import { TemplateError } from '../../templates/errors';
import { exportCatalogue } from '../export';

const row = (o: Record<string, unknown>) => ({
  channel: 'email', templateKey: 'k', locale: 'en', provider: 'smtp',
  subject: 'S', bodyHtml: '<p>SECRETBODY</p>', bodyText: null, variables: [],
  providerTemplateId: null, senderId: null, dltEntityId: null, dltHeaderId: null, dltTagId: null,
  approvalRef: null, defaultDeadlineS: null, ...o,
});
const policy = (o: Record<string, unknown>) => ({ domain: null, eventType: null, mode: 'all', channels: [{ channel: 'email', template_key: 'k' }], ...o });

beforeEach(() => {
  repo.listTemplates.mockReset().mockResolvedValue([]);
  repo.listPolicies.mockReset().mockResolvedValue([]);
});

describe('exportCatalogue', () => {
  it('sorts by code point, field by field', async () => {
    repo.listTemplates.mockResolvedValue([
      row({ templateKey: 'ab' }),
      row({ templateKey: 'a_b' }),
      row({ templateKey: 'a', locale: 'hi' }),
      row({ templateKey: 'a0' }),
      row({ templateKey: 'a.b' }),
      row({ templateKey: 'a', locale: 'en' }),
      row({ templateKey: 'a-b' }),
    ]);
    repo.listPolicies.mockResolvedValue([
      policy({ domain: 'seeker_x', eventType: 'a' }),
      policy({ domain: 'seeker', eventType: 'z' }),
      policy({ domain: 'seeker', eventType: null }),
      policy({ domain: 'seeker.x', eventType: 'a' }),
    ]);
    const out = await exportCatalogue('x');
    // Code points: '-' < '.' < '0' < '_' < 'a' (a locale collation would put '_' first);
    // a key sorts before its own extensions.
    expect(out.templates.map((t) => `${t.template_key}/${t.locale}`)).toEqual(['a/en', 'a/hi', 'a-b/en', 'a.b/en', 'a0/en', 'a_b/en', 'ab/en']);
    expect(out.policies.map((p) => `${p.domain}/${p.event_type}`)).toEqual(['seeker/null', 'seeker/z', 'seeker.x/a', 'seeker_x/a']);
  });

  it('answers export_invalid naming paths only when the store does not fit the catalogue format', async () => {
    repo.listTemplates.mockResolvedValue(Array.from({ length: 501 }, (_, i) => row({ templateKey: `k${i}` })));
    const err = await exportCatalogue('x').then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(TemplateError);
    expect((err as TemplateError).code).toBe('export_invalid');
    expect((err as TemplateError).message).toBe('export does not fit the catalogue format at: templates');
    expect((err as TemplateError).message).not.toContain('SECRETBODY');
  });
});
