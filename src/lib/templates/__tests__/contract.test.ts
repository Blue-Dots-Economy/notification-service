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
