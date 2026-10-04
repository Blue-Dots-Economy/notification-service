import { describe, expect, it } from 'vitest';
import { currentNetwork, defaultLocale, NetworkNotConfigured } from '../network';

describe('currentNetwork', () => {
  it('returns the trimmed NS_NETWORK', () => {
    expect(currentNetwork({ NS_NETWORK: ' blue_dot ' })).toBe('blue_dot');
  });
  it('throws NetworkNotConfigured when unset or blank', () => {
    expect(() => currentNetwork({})).toThrow(NetworkNotConfigured);
    expect(() => currentNetwork({ NS_NETWORK: '  ' })).toThrow(NetworkNotConfigured);
  });
});

describe('defaultLocale', () => {
  it('defaults to en', () => {
    expect(defaultLocale({})).toBe('en');
    expect(defaultLocale({ NS_DEFAULT_LOCALE: 'hi' })).toBe('hi');
  });
});
