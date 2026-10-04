import { describe, expect, it } from 'vitest';
import { parseSecrets } from '../secrets';

describe('parseSecrets', () => {
  it('defaults scopes to notify:send', () => {
    const keys = parseSecrets({ keycloak: { secret: 's1' } });
    expect([...keys.get('keycloak')!.scopes]).toEqual(['notify:send']);
  });

  it('keeps declared scopes', () => {
    const keys = parseSecrets({ ops: { secret: 's', scopes: ['notify:send', 'templates:admin'] } });
    expect(keys.get('ops')!.scopes.has('templates:admin')).toBe(true);
  });

  it.each([
    [{ a: { secret: '' } }, /secret/],
    [{ a: { secret: 1 } }, /secret/],
    [{ a: { secret: 's', scopes: [] } }, /scopes/],
    [{ a: { secret: 's', scopes: ['admin'] } }, /unknown scope "admin"/],
    [{ a: 'plain-string' }, /entry/],
    [[], /object/],
    [null, /object/],
  ])('rejects %j', (raw, message) => {
    expect(() => parseSecrets(raw)).toThrow(message);
  });

  it('does not resolve prototype names as key ids', () => {
    const keys = parseSecrets({ a: { secret: 's' } });
    expect(keys.get('constructor')).toBeUndefined();
    expect(keys.get('__proto__')).toBeUndefined();
  });
});
