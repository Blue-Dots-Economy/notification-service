import { describe, expect, it } from 'vitest';

import { MAX_LENGTH, messageType } from '../render';

describe('messageType', () => {
  it('is TXT for plain ASCII', () => {
    expect(messageType('123456 is your OTP')).toBe('TXT');
  });

  it('is UNI for Devanagari — getting this wrong garbles rather than fails', () => {
    expect(messageType('आपका OTP 123456 है')).toBe('UNI');
  });

  it('is UNI for an emoji', () => {
    expect(messageType('done ✅')).toBe('UNI');
  });

  it('caps UNI far below TXT, per the vendor limits', () => {
    expect(MAX_LENGTH.UNI).toBeLessThan(MAX_LENGTH.TXT);
  });
});
