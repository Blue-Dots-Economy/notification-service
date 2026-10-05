import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseContentDocument } from '../configmap';
import { contentConfig, currentContent, resolveContent, setContentForTests, startContent, startWithProvider, stopContent } from '../resolver';

const snap = (version: string, url = 'https://example.org/tnc') =>
  parseContentDocument({ version, entries: { 'tnc.in_force.url': { en: url, 'hi-IN': 'https://example.org/hi' } } });

afterEach(() => { stopContent(); setContentForTests(null); vi.useRealTimers(); });

describe('resolveContent', () => {
  it('walks the locale chain and reports the ref', () => {
    setContentForTests(snap('v1'));
    expect(resolveContent('tnc.in_force.url', ['hi-IN', 'hi', 'en'])).toEqual({
      value: 'https://example.org/hi', ref: { key: 'tnc.in_force.url', version: 'v1', locale: 'hi-IN' },
    });
    expect(resolveContent('tnc.in_force.url', ['ta', 'en']).ref.locale).toBe('en');
  });

  it('throws content_unavailable with no snapshot', () => {
    expect(() => resolveContent('tnc.in_force.url', ['en'])).toThrow(expect.objectContaining({ code: 'content_unavailable' }));
  });

  it('throws unknown_content_key for a key outside the snapshot', () => {
    setContentForTests(snap('v1'));
    expect(() => resolveContent('tnc.on_offer.url', ['en'])).toThrow(expect.objectContaining({ code: 'unknown_content_key' }));
  });

  it('throws content_unresolved when no locale in the chain has a value', () => {
    setContentForTests(snap('v1'));
    expect(() => resolveContent('tnc.in_force.url', ['ta', 'kn'])).toThrow(expect.objectContaining({ code: 'content_unresolved' }));
  });

  it('memoises per (key, locale, version) and drops the memo on a new version', () => {
    const s1 = snap('v1');
    const get = vi.spyOn(s1, 'get');
    setContentForTests(s1);
    resolveContent('tnc.in_force.url', ['en']);
    resolveContent('tnc.in_force.url', ['en']);
    expect(get).toHaveBeenCalledTimes(1);
    setContentForTests(snap('v2', 'https://example.org/tnc/v2'));
    expect(resolveContent('tnc.in_force.url', ['en']).value).toBe('https://example.org/tnc/v2');
  });
});

describe('startContent (configmap reload)', () => {
  // Real timers on purpose: the reload does real file I/O, which fake timers do not wait for.
  it('loads at start, picks up a new version, and keeps the last good snapshot on a bad reload', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ns-content-')), 'content.json');
    fs.writeFileSync(file, JSON.stringify({ version: 'v1', entries: { 'tnc.in_force.url': { en: 'https://a.example/1' } } }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await startContent({ NS_CONTENT_FILE: file, NS_CONTENT_RELOAD_MS: '20' });
    expect(currentContent()?.version).toBe('v1');

    fs.writeFileSync(file, '{ broken');
    await vi.waitFor(() => expect(error).toHaveBeenCalled(), { timeout: 2000 });
    expect(currentContent()?.version).toBe('v1');
    expect(error.mock.calls.flat().join(' ')).not.toContain('https://a.example');

    fs.writeFileSync(file, JSON.stringify({ version: 'v2', entries: { 'tnc.in_force.url': { en: 'https://a.example/2' } } }));
    await vi.waitFor(() => expect(currentContent()?.version).toBe('v2'), { timeout: 2000 });
  });

  it('serves the new value after an edit that keeps the version, and warns', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ns-content-')), 'content.json');
    const write = (url: string) => fs.writeFileSync(file, JSON.stringify({ version: 'v1', entries: { 'tnc.in_force.url': { en: url } } }));
    write('https://a.example/A');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await startContent({ NS_CONTENT_FILE: file, NS_CONTENT_RELOAD_MS: '20' });
    expect(resolveContent('tnc.in_force.url', ['en']).value).toBe('https://a.example/A');
    write('https://a.example/B');
    await vi.waitFor(() => expect(resolveContent('tnc.in_force.url', ['en']).value).toBe('https://a.example/B'), { timeout: 2000 });
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).not.toContain('a.example');
  });

  it('skips a tick while a load is still pending', async () => {
    const load = vi.fn(() => new Promise<never>(() => {}));
    void startWithProvider({ name: 'stub', load }, 5);
    await new Promise((r) => setTimeout(r, 60));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('never throws when the file is missing at start; content stays unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(startContent({ NS_CONTENT_FILE: '/nonexistent/content.json' })).resolves.toBeUndefined();
    expect(currentContent()).toBeNull();
  });
});

describe('contentConfig', () => {
  it('is off without a file', () => expect(contentConfig({})).toBeNull());
  it('defaults provider and reload', () =>
    expect(contentConfig({ NS_CONTENT_FILE: '/x.json' })).toEqual({ provider: 'configmap', file: '/x.json', reloadMs: 30000 }));
  it('validates the other settings even without a file', () => {
    expect(() => contentConfig({ NS_CONTENT_PROVIDER: 'db' })).toThrow();
    expect(() => contentConfig({ NS_CONTENT_RELOAD_MS: 'abc' })).toThrow();
  });
  it('bounds the reload interval to 1..3600000', () => {
    expect(contentConfig({ NS_CONTENT_FILE: '/x', NS_CONTENT_RELOAD_MS: '1' })?.reloadMs).toBe(1);
    expect(contentConfig({ NS_CONTENT_FILE: '/x', NS_CONTENT_RELOAD_MS: '3600000' })?.reloadMs).toBe(3600000);
    expect(() => contentConfig({ NS_CONTENT_FILE: '/x', NS_CONTENT_RELOAD_MS: '3600001' })).toThrow();
  });
  it.each([{ NS_CONTENT_FILE: '/x', NS_CONTENT_PROVIDER: 'db' }, { NS_CONTENT_FILE: '/x', NS_CONTENT_RELOAD_MS: '0' }, { NS_CONTENT_FILE: '/x', NS_CONTENT_RELOAD_MS: 'abc' }])(
    'rejects %j', (env) => expect(() => contentConfig(env)).toThrow(),
  );
});
