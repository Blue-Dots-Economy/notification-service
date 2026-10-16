import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configmapProvider, parseContentDocument } from '../configmap';

const dirs: string[] = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-content-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const doc = {
  version: '2026-09-01',
  entries: { 'tnc.in_force.url': { en: 'https://example.org/tnc/v3', hi: 'https://example.org/hi/tnc/v3' } },
};

describe('parseContentDocument', () => {
  it('builds a snapshot', () => {
    const s = parseContentDocument(doc);
    expect(s.version).toBe('2026-09-01');
    expect([...s.keys]).toEqual(['tnc.in_force.url']);
    expect(s.get('tnc.in_force.url', 'hi')).toBe('https://example.org/hi/tnc/v3');
    expect(s.get('tnc.in_force.url', 'ta')).toBeUndefined();
    expect(s.get('constructor', 'en')).toBeUndefined();
  });

  it.each([
    [{ ...doc, version: '' }],
    [{ ...doc, version: 'a b' }],
    [{ version: 'v', entries: { TNC: { en: 'x' } } }],
    [{ version: 'v', entries: { 'tnc.url': { english: 'x' } } }],
    [{ version: 'v', entries: { 'tnc.url': { en: '' } } }],
    [{ version: 'v', entries: { 'tnc.url': { en: '   ' } } }],
    [{ version: 'v', entries: { 'tnc.url': { en: 'x'.repeat(2001) } } }],
    [{ version: 'v', entries: {}, extra: 1 }],
    [[]],
    [null],
  ])('rejects %j without echoing values', (raw) => {
    expect(() => parseContentDocument(raw)).toThrow();
    try { parseContentDocument(raw); } catch (e) { expect(String((e as Error).message)).not.toContain('xxxxxxxxxx'); }
  });

  it('rejects more than 500 keys', () => {
    const entries = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`k.k${i}`, { en: 'v' }]));
    expect(() => parseContentDocument({ version: 'v', entries })).toThrow();
  });
});

describe('parseContentDocument prototype keys', () => {
  it('rejects __proto__ as an entry key', () => {
    expect(() => parseContentDocument(JSON.parse('{"version":"v","entries":{"__proto__":{"en":"x"}}}'))).toThrow();
  });
  it('rejects __proto__ as a locale', () => {
    expect(() => parseContentDocument(JSON.parse('{"version":"v","entries":{"tnc.url":{"__proto__":"x"}}}'))).toThrow();
  });
});

describe('configmapProvider', () => {
  it('rejects a file over 1 MiB with a size-only message', async () => {
    const file = path.join(tempDir(), 'big.json');
    fs.writeFileSync(file, ' '.repeat(1_048_577));
    await expect(configmapProvider(file).load()).rejects.toThrow(/too large/);
  });

  it('loads the file', async () => {
    const file = path.join(tempDir(), 'content.json');
    fs.writeFileSync(file, JSON.stringify(doc));
    expect((await configmapProvider(file).load()).version).toBe('2026-09-01');
  });

  it('fails on unreadable or non-JSON files', async () => {
    const dir = tempDir();
    await expect(configmapProvider(path.join(dir, 'missing.json')).load()).rejects.toThrow();
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json');
    await expect(configmapProvider(path.join(dir, 'bad.json')).load()).rejects.toThrow();
  });
});
