import { describe, expect, it } from 'vitest';
import {
  checkTokensMatchContract,
  sensitiveVariables,
  tokensIn,
  validateVariables,
  VariableContractSchema,
} from '../contract';
import { TemplateError } from '../errors';
import type { VariableSpec } from '../../db/schema';

const v = (over: Partial<VariableSpec> & { name: string }): VariableSpec => ({
  required: true, type: 'string', sensitive: false, raw: false, ...over,
});

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { return e instanceof TemplateError ? e.code : 'other'; }
  return undefined;
}

describe('VariableContractSchema', () => {
  it('rejects unknown keys in a variable spec', () => {
    expect(VariableContractSchema.safeParse([{ name: 'a', bogus: true }]).success).toBe(false);
  });

  it('fills defaults', () => {
    expect(VariableContractSchema.parse([{ name: 'name' }])).toEqual([
      { name: 'name', required: true, type: 'string', sensitive: false, raw: false },
    ]);
  });
  it('rejects duplicate names, bad names and urlHosts on non-url', () => {
    expect(VariableContractSchema.safeParse([{ name: 'a' }, { name: 'a' }]).success).toBe(false);
    expect(VariableContractSchema.safeParse([{ name: 'a-b' }]).success).toBe(false);
    expect(VariableContractSchema.safeParse([{ name: 'a', urlHosts: ['x.org'] }]).success).toBe(false);
  });
});

describe('tokens', () => {
  it('collects {{tokens}} across texts', () => {
    expect([...tokensIn('Hi {{name}}', null, '{{link}} and {{name}}')].sort()).toEqual(['link', 'name']);
  });
  it('rejects a token with no declared variable', () => {
    expect(code(() => checkTokensMatchContract(['Hi {{name}}'], []))).toBe('undeclared_token');
  });
  it('rejects a declared variable no body uses', () => {
    expect(code(() => checkTokensMatchContract(['Hi'], [v({ name: 'name' })]))).toBe('unused_variable');
  });
  it('accepts a matching contract', () => {
    expect(code(() => checkTokensMatchContract(['Hi {{name}}'], [v({ name: 'name' })]))).toBeUndefined();
  });
});

describe('validateVariables', () => {
  const contract = [
    v({ name: 'name' }),
    v({ name: 'count', type: 'number', required: false }),
    v({ name: 'link', type: 'url', urlHosts: ['blue-dots.org'] }),
  ];
  const ok = { name: 'Asha', link: 'https://app.blue-dots.org/x' };

  it('normalises values to strings and omits absent optionals', () => {
    expect(validateVariables(contract, { ...ok, count: 3 })).toEqual({
      name: 'Asha', count: '3', link: 'https://app.blue-dots.org/x',
    });
    expect(validateVariables(contract, ok)).toEqual(ok);
  });
  it('rejects unknown variables', () => {
    expect(code(() => validateVariables(contract, { ...ok, extra: 'x' }))).toBe('unknown_variable');
  });
  it('rejects a missing or empty required variable', () => {
    expect(code(() => validateVariables(contract, { link: ok.link }))).toBe('missing_variable');
    expect(code(() => validateVariables(contract, { ...ok, name: '' }))).toBe('missing_variable');
  });
  it('rejects non-numeric numbers and object values', () => {
    expect(code(() => validateVariables(contract, { ...ok, count: 'three' }))).toBe('invalid_variable');
    expect(code(() => validateVariables(contract, { ...ok, name: { a: 1 } }))).toBe('invalid_variable');
  });
  it('rejects non-http schemes', () => {
    expect(code(() => validateVariables(contract, { ...ok, link: 'javascript:alert(1)' }))).toBe('invalid_variable');
    expect(code(() => validateVariables(contract, { ...ok, link: 'not a url' }))).toBe('invalid_variable');
  });
  it('rejects lookalike hosts and accepts subdomains', () => {
    expect(code(() => validateVariables(contract, { ...ok, link: 'https://evil-blue-dots.org/' }))).toBe('invalid_variable');
    expect(code(() => validateVariables(contract, { ...ok, link: 'https://blue-dots.org.evil.com/' }))).toBe('invalid_variable');
    expect(validateVariables(contract, { ...ok, link: 'https://blue-dots.org/' }).link).toBe('https://blue-dots.org/');
  });
  it('lists sensitive variables', () => {
    expect(sensitiveVariables([v({ name: 'otp', sensitive: true }), v({ name: 'name' })])).toEqual(['otp']);
  });
});

describe('security hardening', () => {
  it('rejects reserved names in contract schema', () => {
    expect(VariableContractSchema.safeParse([{ name: 'constructor' }]).success).toBe(false);
    expect(VariableContractSchema.safeParse([{ name: '__proto__' }]).success).toBe(false);
    expect(VariableContractSchema.safeParse([{ name: 'toString' }]).success).toBe(false);
    expect(VariableContractSchema.safeParse([{ name: 'hasOwnProperty' }]).success).toBe(false);
  });

  it('rejects __proto__ injection via JSON.parse', () => {
    const contract = [v({ name: 'user' })];
    // Simulate a caller passing JSON with __proto__ key
    const input = JSON.parse('{"user":"test","__proto__":{"admin":true}}');
    expect(code(() => validateVariables(contract, input))).toBe('unknown_variable');
  });

  it('accepts null-prototype input', () => {
    const contract = [v({ name: 'user' })];
    const input = Object.create(null);
    input.user = 'test';
    expect(validateVariables(contract, input)).toEqual({ user: 'test' });
  });

  it('accepts uppercase host and normalizes with url.href', () => {
    const contract = [v({ name: 'link', type: 'url', urlHosts: ['blue-dots.org'] })];
    const result = validateVariables(contract, { link: 'https://BLUE-DOTS.ORG/path' });
    // url.href normalizes hostname to lowercase
    expect(result.link).toBe('https://blue-dots.org/path');
  });

  it('accepts trailing dot and strips for host comparison', () => {
    const contract = [v({ name: 'link', type: 'url', urlHosts: ['blue-dots.org'] })];
    const result = validateVariables(contract, { link: 'https://blue-dots.org./path' });
    // url.href preserves the trailing dot, but we strip it from hostname for allowlist comparison
    expect(result.link).toBe('https://blue-dots.org./path');
    // Negative case: lookalike with trailing dot should still be rejected
    expect(code(() => validateVariables(contract, { link: 'https://evil-blue-dots.org./' }))).toBe('invalid_variable');
  });

  it('rejects URLs with credentials', () => {
    const contract = [v({ name: 'link', type: 'url', urlHosts: ['blue-dots.org'] })];
    expect(code(() => validateVariables(contract, { link: 'https://u:p@blue-dots.org/' }))).toBe('invalid_variable');
    expect(code(() => validateVariables(contract, { link: 'https://blue-dots.org@evil.com/' }))).toBe('invalid_variable');
  });

  it('rejects function, symbol, and bigint values', () => {
    const contract = [v({ name: 'val' })];
    expect(code(() => validateVariables(contract, { val: () => {} }))).toBe('invalid_variable');
    expect(code(() => validateVariables(contract, { val: Symbol('test') }))).toBe('invalid_variable');
    expect(code(() => validateVariables(contract, { val: BigInt(123) }))).toBe('invalid_variable');
  });

  it('rejects whitespace and hex strings for number type', () => {
    const contract = [v({ name: 'count', type: 'number' })];
    expect(code(() => validateVariables(contract, { count: '   ' }))).toBe('invalid_variable');
    expect(code(() => validateVariables(contract, { count: '0x10' }))).toBe('invalid_variable');
    expect(code(() => validateVariables(contract, { count: '1.2.3' }))).toBe('invalid_variable');
  });

  it('accepts valid number formats after trim', () => {
    const contract = [v({ name: 'count', type: 'number' })];
    expect(validateVariables(contract, { count: '  42  ' })).toEqual({ count: '42' });
    expect(validateVariables(contract, { count: '-3.14' })).toEqual({ count: '-3.14' });
    expect(validateVariables(contract, { count: 0 })).toEqual({ count: '0' });
  });

  it('rejects non-finite numbers (NaN, Infinity) for all types', () => {
    const stringContract = [v({ name: 'name', type: 'string' })];
    const numberContract = [v({ name: 'count', type: 'number' })];
    const urlContract = [v({ name: 'link', type: 'url', urlHosts: ['blue-dots.org'] })];
    expect(code(() => validateVariables(stringContract, { name: NaN }))).toBe('invalid_variable');
    expect(code(() => validateVariables(stringContract, { name: Infinity }))).toBe('invalid_variable');
    expect(code(() => validateVariables(stringContract, { name: -Infinity }))).toBe('invalid_variable');
    expect(code(() => validateVariables(numberContract, { count: NaN }))).toBe('invalid_variable');
    expect(code(() => validateVariables(numberContract, { count: Infinity }))).toBe('invalid_variable');
    expect(code(() => validateVariables(urlContract, { link: NaN }))).toBe('invalid_variable');
  });

  it('returns url.href as normalized URL', () => {
    const contract = [v({ name: 'link', type: 'url', urlHosts: ['blue-dots.org'] })];
    const result = validateVariables(contract, { link: 'HTTPS://blue-dots.org/path' });
    // url.href should normalize the scheme to lowercase
    expect(result.link).toBe('https://blue-dots.org/path');
  });

  it('does not expose sensitive values in error messages', () => {
    const contract = [v({ name: 'otp', sensitive: true, type: 'string' })];
    try {
      validateVariables(contract, { otp: { nested: 'SECRET_VALUE' } });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TemplateError);
      const err = e as TemplateError;
      const msg = err.message;
      const details = JSON.stringify(err.details || {});
      expect(msg).not.toContain('SECRET_VALUE');
      expect(details).not.toContain('SECRET_VALUE');
    }
  });
});
