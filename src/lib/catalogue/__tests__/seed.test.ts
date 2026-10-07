import { beforeEach, describe, expect, it, vi } from 'vitest';

const repo = vi.hoisted(() => ({
  templateRowExists: vi.fn(),
  createTemplateDraft: vi.fn(),
  publishTemplate: vi.fn(),
  policyRowExists: vi.fn(),
  createPolicyDraft: vi.fn(),
  publishPolicy: vi.fn(),
}));
vi.mock('../../templates/repo', () => ({
  templateRowExists: repo.templateRowExists,
  createTemplateDraft: repo.createTemplateDraft,
  publishTemplate: repo.publishTemplate,
}));
vi.mock('../../policies/repo', () => ({
  policyRowExists: repo.policyRowExists,
  createPolicyDraft: repo.createPolicyDraft,
  publishPolicy: repo.publishPolicy,
}));
vi.mock('../../templates/vendors', () => ({ channelVendor: () => ({ vendor: 'smtp', renders: 'ns' }) }));

import { parseCatalogue } from '../schema';
import { seedCatalogue } from '../seed';

const body = '<p>SECRETBODY {{name}}</p>';
const cat = parseCatalogue({
  version: 'v1',
  templates: [{ channel: 'email', template_key: 'item.paused', subject: 'Paused', body_html: body, variables: [{ name: 'name' }] }],
  policies: [{ domain: 'seeker', event_type: 'item.paused', mode: 'all', channels: [{ channel: 'email', template_key: 'item.paused' }] }],
});

beforeEach(() => {
  vi.restoreAllMocks();
  Object.values(repo).forEach((f) => f.mockReset());
  repo.templateRowExists.mockResolvedValue(false);
  repo.policyRowExists.mockResolvedValue(false);
  repo.createTemplateDraft.mockResolvedValue({ id: 't1' });
  repo.createPolicyDraft.mockResolvedValue({ id: 'p1' });
  repo.publishTemplate.mockResolvedValue({});
  repo.publishPolicy.mockResolvedValue({});
});

describe('seedCatalogue on a non-rule publish error', () => {
  it('logs the template left as a draft, then rethrows', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dbErr = new Error('connection terminated');
    repo.publishTemplate.mockRejectedValue(dbErr);
    await expect(seedCatalogue(cat)).rejects.toBe(dbErr);
    expect(warn).toHaveBeenCalledWith('catalogue template email/item.paused/en left as draft: db_error');
    expect(repo.createPolicyDraft).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join('\n')).not.toContain('SECRETBODY');
  });

  it('logs the policy left as a draft, then rethrows', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dbErr = new Error('connection terminated');
    repo.publishPolicy.mockRejectedValue(dbErr);
    await expect(seedCatalogue(cat)).rejects.toBe(dbErr);
    expect(warn).toHaveBeenCalledWith('catalogue policy seeker/item.paused left as draft: db_error');
  });
});
