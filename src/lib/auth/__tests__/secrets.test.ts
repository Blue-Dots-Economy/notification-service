import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getKey, loadSecrets, parseSecrets } from '../secrets';

describe('parseSecrets', () => {
  afterEach(() => vi.restoreAllMocks());

  it('defaults scopes to notify:send', () => {
    const keys = parseSecrets({ keycloak: { secret: 's1' } });
    expect([...keys.get('keycloak')!.scopes]).toEqual(['notify:send']);
  });

  it('keeps declared scopes', () => {
    const keys = parseSecrets({ ops: { secret: 's', scopes: ['notify:send', 'templates:admin'] } });
    expect(keys.get('ops')!.scopes.has('templates:admin')).toBe(true);
  });

  it('skips an entry with an empty secret and warns with its key id only', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const keys = parseSecrets({ keycloak: { secret: '' }, signals: { secret: 's2' } });
    expect(keys.has('keycloak')).toBe(false);
    expect(keys.get('signals')!.secret).toBe('s2');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('"keycloak"');
    expect(String(warn.mock.calls[0][0])).not.toContain('s2');
  });

  it.each([
    [{ a: { secret: 1 } }, /secret/],
    [{ a: {} }, /secret/],
    [{ a: { secret: 's', scopes: [] } }, /scopes/],
    [{ a: { secret: '', scopes: 'notify:send' } }, /scopes/],
    [{ a: 'plain-string' }, /entry/],
    [[], /object/],
    [null, /object/],
  ])('rejects %j', (raw, message) => {
    expect(() => parseSecrets(raw)).toThrow(message);
  });

  it('names an unknown scope by its index, without echoing the value', () => {
    expect(() => parseSecrets({ a: { secret: 's', scopes: ['notify:send', 'sekrit-value'] } })).toThrow(
      /scopes\[1\] is not a known scope/,
    );
    try {
      parseSecrets({ a: { secret: 's', scopes: ['sekrit-value'] } });
    } catch (err) {
      expect((err as Error).message).not.toContain('sekrit-value');
    }
  });

  it('does not resolve prototype names as key ids', () => {
    const keys = parseSecrets({ a: { secret: 's' } });
    expect(keys.get('constructor')).toBeUndefined();
    expect(keys.get('__proto__')).toBeUndefined();
  });
});

describe('loadSecrets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-secrets-'));
  const file = path.join(dir, 'internal-secrets.json');
  const previous = process.env.INTERNAL_SECRETS_JSON;

  afterEach(() => {
    vi.restoreAllMocks();
    if (previous === undefined) delete process.env.INTERNAL_SECRETS_JSON;
    else process.env.INTERNAL_SECRETS_JSON = previous;
  });

  it('replaces the previous key set on reload', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.INTERNAL_SECRETS_JSON = file;
    fs.writeFileSync(file, JSON.stringify({ old: { secret: 's1' } }));
    loadSecrets();
    expect(getKey('old')).not.toBeNull();

    fs.writeFileSync(file, JSON.stringify({ fresh: { secret: 's2' } }));
    loadSecrets();
    expect(getKey('old')).toBeNull();
    expect(getKey('fresh')!.secret).toBe('s2');
  });

  it('getKey returns null for an entry skipped for its empty secret', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.INTERNAL_SECRETS_JSON = file;
    fs.writeFileSync(file, JSON.stringify({ keycloak: { secret: '' }, signals: { secret: 's' } }));
    loadSecrets();
    expect(getKey('keycloak')).toBeNull();
    expect(getKey('signals')).not.toBeNull();
  });
});
