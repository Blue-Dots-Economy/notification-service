import { describe, expect, it } from 'vitest';

import { MAX_LENGTH, messageType, renderBody, UnresolvedTemplateVariables } from '../render';

describe('renderBody', () => {
  it('substitutes every declared token', () => {
    expect(renderBody('Hi {{name}}, see {{link}}', { name: 'Asha', link: 'https://x' })).toBe(
      'Hi Asha, see https://x'
    );
  });

  it('substitutes a repeated token everywhere it appears', () => {
    expect(renderBody('{{code}} / {{code}}', { code: '42' })).toBe('42 / 42');
  });

  it('throws rather than shipping an unsubstituted token to a handset', () => {
    expect(() => renderBody('Hi {{name}}, see {{link}}', { name: 'Asha' })).toThrowError(
      UnresolvedTemplateVariables
    );
  });

  it('treats an empty string as missing — a blank in DLT text is still drift', () => {
    expect(() => renderBody('Hi {{name}}', { name: '' })).toThrowError(
      UnresolvedTemplateVariables
    );
  });

  it('reports each missing name once', () => {
    try {
      renderBody('{{a}} {{a}} {{b}}', {});
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as UnresolvedTemplateVariables).missing).toEqual(['a', 'b']);
    }
  });

  it('leaves a body with no tokens untouched', () => {
    expect(renderBody('No variables here.', {})).toBe('No variables here.');
  });

  it('coerces non-string values', () => {
    expect(renderBody('{{n}}', { n: 7 })).toBe('7');
  });
});

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
