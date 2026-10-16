import type { TemplateRow } from '../db/schema';
import { defaultLocale } from '../network';
import { isContentVariable, validateVariables } from '../templates/contract';
import { TemplateError } from '../templates/errors';
import { resolveContent } from './resolver';
import type { ContentRef } from './types';

/** The resolved template's locale, its language, then NS_DEFAULT_LOCALE. */
export function templateLocaleChain(locale: string): string[] {
  const base = locale.split('-')[0]!;
  return [...new Set([locale, base, defaultLocale()])];
}

/**
 * Fill a template's content_ref variables from the content resolver.
 * Content is never caller input: a caller value under a content variable's
 * name is refused. Content values pass the same type checks as caller values,
 * and a failure is a configuration error that names the key, never the value.
 */
export function withContent(
  t: Pick<TemplateRow, 'locale' | 'variables'>,
  input: Record<string, unknown>,
): { input: Record<string, unknown>; refs: ContentRef[] } {
  const specs = t.variables.filter(isContentVariable);
  if (specs.length === 0) return { input, refs: [] };

  const supplied = specs.filter((s) => Object.prototype.hasOwnProperty.call(input, s.name)).map((s) => s.name);
  if (supplied.length) {
    throw new TemplateError('unknown_variable', `unknown variables: ${supplied.join(', ')}`, { variables: supplied });
  }

  const chain = templateLocaleChain(t.locale);
  const out: Record<string, unknown> = { ...input };
  const refs: ContentRef[] = [];
  for (const spec of specs) {
    const key = spec.contentKey!;
    const { value, ref } = resolveContent(key, chain);
    try {
      validateVariables([{ ...spec, source: 'request' }], { [spec.name]: value });
    } catch (e) {
      if (!(e instanceof TemplateError)) throw e;
      throw new TemplateError('invalid_content', `content ${key} is not a valid value for ${spec.name}`, {
        key,
        variable: spec.name,
      });
    }
    out[spec.name] = value;
    refs.push(ref);
  }
  return { input: out, refs };
}
