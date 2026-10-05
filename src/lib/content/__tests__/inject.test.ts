import { afterEach, describe, expect, it } from 'vitest';
import { parseContentDocument } from '../configmap';
import { setContentForTests } from '../resolver';
import { templateLocaleChain, withContent } from '../inject';

const t = (variables: any[], locale = 'hi-IN') => ({ locale, variables }) as any;
const tnc = { name: 'tnc_url', required: true, type: 'url', sensitive: false, raw: false, source: 'content_ref', contentKey: 'tnc.in_force.url', urlHosts: ['example.org'] };
const name = { name: 'name', required: true, type: 'string', sensitive: false, raw: false };

afterEach(() => setContentForTests(null));
const load = (entries: Record<string, Record<string, string>>, version = 'v3') =>
  setContentForTests(parseContentDocument({ version, entries }));

describe('withContent', () => {
  it('fills content variables from the template locale chain and reports refs', () => {
    load({ 'tnc.in_force.url': { hi: 'https://example.org/hi/tnc', en: 'https://example.org/tnc' } });
    const out = withContent(t([name, tnc]), { name: 'Asha' });
    expect(out.input).toEqual({ name: 'Asha', tnc_url: 'https://example.org/hi/tnc' });
    expect(out.refs).toEqual([{ key: 'tnc.in_force.url', version: 'v3', locale: 'hi' }]);
  });

  it('caller cannot override content', () => {
    load({ 'tnc.in_force.url': { en: 'https://example.org/tnc' } });
    expect(() => withContent(t([tnc], 'en'), { tnc_url: 'https://evil.example/x' })).toThrow(
      expect.objectContaining({ code: 'unknown_variable' }),
    );
  });

  it.each([
    ['https://other.example/tnc'],
    ['javascript:alert(1)'],
    ['ftp://example.org/tnc'],
  ])('invalid content value %s is a configuration error naming no value', (bad) => {
    load({ 'tnc.in_force.url': { en: bad } });
    try {
      withContent(t([tnc], 'en'), {});
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe('invalid_content');
      expect(e.details).toEqual({ key: 'tnc.in_force.url', variable: 'tnc_url' });
      expect(e.message).not.toContain(bad);
    }
  });

  it('propagates unavailable / unknown / unresolved', () => {
    expect(() => withContent(t([tnc], 'en'), {})).toThrow(expect.objectContaining({ code: 'content_unavailable' }));
    load({ 'tnc.on_offer.url': { en: 'https://example.org/x' } });
    expect(() => withContent(t([tnc], 'en'), {})).toThrow(expect.objectContaining({ code: 'unknown_content_key' }));
    load({ 'tnc.in_force.url': { ta: 'https://example.org/ta' } });
    expect(() => withContent(t([tnc], 'kn'), {})).toThrow(expect.objectContaining({ code: 'content_unresolved' }));
  });

  it('a template with no content variables passes input through untouched', () => {
    const input = { name: 'Asha' };
    expect(withContent(t([name]), input)).toEqual({ input, refs: [] });
  });
});

describe('templateLocaleChain', () => {
  it('locale, language, default — de-duplicated', () => {
    expect(templateLocaleChain('hi-IN')).toEqual(['hi-IN', 'hi', 'en']);
    expect(templateLocaleChain('en')).toEqual(['en']);
  });
});
