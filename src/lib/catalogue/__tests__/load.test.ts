import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The providers registry auto-discovers built providers; loading a file needs none.
vi.mock('../../providers', () => ({ providers: {} }));

import { loadCatalogueFile } from '../seed';

let dir: string;
beforeAll(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ns-catalogue-')); });
afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });
beforeEach(() => { vi.restoreAllMocks(); });

async function write(name: string, content: string): Promise<string> {
  const p = path.join(dir, name);
  await fs.writeFile(p, content);
  return p;
}

const valid = {
  version: 'v1',
  templates: [{ channel: 'email', template_key: 'item.paused', subject: 'Paused', body_html: '<p>Hi {{name}}</p>', variables: [{ name: 'name' }] }],
  policies: [{ domain: 'seeker', event_type: 'item.paused', mode: 'first_available', channels: [{ channel: 'email', template_key: 'item.paused' }] }],
};

describe('loadCatalogueFile', () => {
  it('returns the parsed catalogue for a valid file', async () => {
    const c = await loadCatalogueFile(await write('valid.json', JSON.stringify(valid)));
    expect(c?.version).toBe('v1');
    expect(c?.templates).toHaveLength(1);
    expect(c?.policies).toHaveLength(1);
  });

  it('returns null and logs once for a missing file', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadCatalogueFile(path.join(dir, 'missing.json'))).toBeNull();
    expect(err).toHaveBeenCalledTimes(1);
  });

  it('returns null for a file over 1 MiB', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const big = JSON.stringify({ ...valid, pad: 'x'.repeat(1024 * 1024) });
    expect(await loadCatalogueFile(await write('big.json', big))).toBeNull();
    expect(String(err.mock.calls[0]?.[0])).toMatch(/too large/);
  });

  it('returns null for a file that is not JSON, without quoting it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadCatalogueFile(await write('bad.json', '{ secret-body-text'))).toBeNull();
    const msg = String(err.mock.calls[0]?.[0]);
    expect(msg).toMatch(/not valid JSON/);
    expect(msg).not.toContain('secret-body-text');
  });

  it('returns null for an invalid entry, naming the path and not the value', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = { ...valid, templates: [{ ...valid.templates[0], template_key: 'Not A Slug SECRETVALUE' }] };
    expect(await loadCatalogueFile(await write('invalid.json', JSON.stringify(bad)))).toBeNull();
    const msg = String(err.mock.calls[0]?.[0]);
    expect(msg).toContain('templates.0.template_key');
    expect(msg).not.toContain('SECRETVALUE');
  });
});
