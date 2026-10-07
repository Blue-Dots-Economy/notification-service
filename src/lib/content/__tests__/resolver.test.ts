import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const metrics = vi.hoisted(() => ({ incr: vi.fn(async () => {}), setGauge: vi.fn(async () => {}) }));
vi.mock('../../metrics', () => metrics);
import { parseContentDocument } from '../configmap';
import type { ContentSnapshot } from '../types';
import { contentConfig, currentContent, resolveContent, setContentForTests, startContent, startWithProvider, stopContent } from '../resolver';

const snap = (version: string, url = 'https://example.org/tnc') =>
  parseContentDocument({ version, entries: { 'tnc.in_force.url': { en: url, 'hi-IN': 'https://example.org/hi' } } });

const dirs: string[] = [];
const tempFile = (name: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-content-'));
  dirs.push(dir);
  return path.join(dir, name);
};

afterEach(() => {
  stopContent();
  setContentForTests(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  metrics.incr.mockClear();
  metrics.setGauge.mockClear();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** A provider whose loads return `results` in order; a deferred result stays pending until settled. */
function scripted(results: Array<ContentSnapshot | Promise<ContentSnapshot>>) {
  let i = 0;
  const load = vi.fn(() => Promise.resolve(results[Math.min(i++, results.length - 1)]!));
  return { name: 'stub', load };
}

const fp12 = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('resolveContent', () => {
  it('walks the locale chain and reports the ref', () => {
    setContentForTests(snap('v1'));
    expect(resolveContent('tnc.in_force.url', ['hi-IN', 'hi', 'en'])).toEqual({
      value: 'https://example.org/hi',
      ref: { key: 'tnc.in_force.url', version: 'v1', locale: 'hi-IN', fingerprint: fp12('https://example.org/hi') },
    });
    expect(resolveContent('tnc.in_force.url', ['ta', 'en']).ref.locale).toBe('en');
  });

  it('the ref pins the exact text: an edit that keeps the version changes the fingerprint', () => {
    setContentForTests(snap('v1', 'https://example.org/A'));
    const a = resolveContent('tnc.in_force.url', ['en']).ref;
    setContentForTests(snap('v1', 'https://example.org/B'));
    const b = resolveContent('tnc.in_force.url', ['en']).ref;
    expect(a.version).toBe(b.version);
    expect(a.fingerprint).toBe(fp12('https://example.org/A'));
    expect(b.fingerprint).toBe(fp12('https://example.org/B'));
    expect(a.fingerprint).toMatch(/^[0-9a-f]{12}$/);
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
    const file = tempFile('content.json');
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
    const file = tempFile('content.json');
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

  it('skips ticks while a reload is still pending, then resumes', async () => {
    const slow = deferred<ContentSnapshot>();
    const provider = scripted([snap('v1'), slow.promise, snap('v3')]);
    await startWithProvider(provider, 5);
    expect(currentContent()?.version).toBe('v1');
    await vi.waitFor(() => expect(provider.load).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await tick(50); // many ticks pass while the second load is pending
    expect(provider.load).toHaveBeenCalledTimes(2);
    slow.resolve(snap('v2'));
    await vi.waitFor(() => expect(provider.load.mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 2000 });
    await vi.waitFor(() => expect(currentContent()?.version).toBe('v3'), { timeout: 2000 });
  });

  it('a load pending across stop never installs its snapshot', async () => {
    const stale = deferred<ContentSnapshot>();
    const provider = scripted([snap('v1'), stale.promise]);
    await startWithProvider(provider, 5);
    await vi.waitFor(() => expect(provider.load).toHaveBeenCalledTimes(2), { timeout: 2000 });
    stopContent();
    stale.resolve(snap('stale'));
    await tick(20);
    expect(currentContent()?.version).toBe('v1');
  });

  it('a stale load from before a restart neither installs nor clears the new run\'s pending flag', async () => {
    const stale = deferred<ContentSnapshot>();
    const old = scripted([snap('a1'), stale.promise]);
    await startWithProvider(old, 5);
    await vi.waitFor(() => expect(old.load).toHaveBeenCalledTimes(2), { timeout: 2000 });

    const pending = deferred<ContentSnapshot>();
    const next = scripted([snap('b1'), pending.promise, snap('b3')]);
    await startWithProvider(next, 5);
    await vi.waitFor(() => expect(next.load).toHaveBeenCalledTimes(2), { timeout: 2000 });

    stale.resolve(snap('a2'));
    await tick(50);
    expect(old.load).toHaveBeenCalledTimes(2);
    expect(next.load).toHaveBeenCalledTimes(2); // still guarded by the new run's pending load
    expect(currentContent()?.version).toBe('b1');

    pending.resolve(snap('b2'));
    await vi.waitFor(() => expect(currentContent()?.version).toBe('b3'), { timeout: 2000 });
  });

  it('warns on a same-version reload only when both fingerprints exist and differ', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fp = (fingerprint?: string) => ({ ...snap('v1'), ...(fingerprint ? { fingerprint } : {}) });
    const run = async (a: ContentSnapshot, b: ContentSnapshot) => {
      warn.mockClear();
      const provider = scripted([a, b]);
      await startWithProvider(provider, 5);
      await vi.waitFor(() => expect(currentContent()).toBe(b), { timeout: 2000 });
      stopContent();
      return warn.mock.calls.length;
    };
    expect(await run(fp(), fp('x'))).toBe(0);
    expect(await run(fp('x'), fp())).toBe(0);
    expect(await run(fp('x'), fp('x'))).toBe(0);
    expect(await run(fp('x'), fp('y'))).toBe(1);
  });

  it('counts every failed load and records the loaded content on every success', async () => {
    const file = tempFile('content.json');
    const doc = JSON.stringify({ version: 'v1', entries: { 'tnc.in_force.url': { en: 'https://a.example/1' } } });
    fs.writeFileSync(file, doc);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await startContent({ NS_CONTENT_FILE: file, NS_CONTENT_RELOAD_MS: '20' });
    expect(metrics.setGauge).toHaveBeenCalledWith('ns_content_loaded', expect.any(Number), {
      provider: 'configmap', version: 'v1', fingerprint: fp12(doc),
    });
    const [, seconds] = metrics.setGauge.mock.calls[0]!;
    expect(Math.abs((seconds as number) - Date.now() / 1000)).toBeLessThan(60);
    expect(metrics.incr).not.toHaveBeenCalled();

    fs.writeFileSync(file, '{ broken');
    await vi.waitFor(() => expect(metrics.incr).toHaveBeenCalledWith('ns_content_load_failures_total', { provider: 'configmap' }), { timeout: 2000 });
  });

  it('a provider without a fingerprint is recorded as fingerprint none', async () => {
    await startWithProvider(scripted([snap('v1')]), 1000);
    expect(metrics.setGauge).toHaveBeenCalledWith('ns_content_loaded', expect.any(Number), { provider: 'stub', version: 'v1', fingerprint: 'none' });
  });

  it('a missing file at start counts as a failed load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await startContent({ NS_CONTENT_FILE: '/nonexistent/content.json' });
    expect(metrics.incr).toHaveBeenCalledWith('ns_content_load_failures_total', { provider: 'configmap' });
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
