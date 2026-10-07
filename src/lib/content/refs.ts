import type { ContentRef } from './types';

/**
 * The content each channel of the send carries, keyed by channel and
 * de-duplicated by (key, version, locale, fingerprint). Absent when there is none.
 */
export function contentRefsFor(
  deliveries: { channel: string; contentRefs: ContentRef[] }[],
): { contentRefs?: Record<string, ContentRef[]> } {
  const byChannel: Record<string, ContentRef[]> = {};
  for (const d of deliveries) {
    if (!d.contentRefs.length) continue;
    const list = (byChannel[d.channel] ??= []);
    for (const r of d.contentRefs) {
      if (!list.some((x) => x.key === r.key && x.version === r.version && x.locale === r.locale && x.fingerprint === r.fingerprint)) list.push(r);
    }
  }
  return Object.keys(byChannel).length ? { contentRefs: byChannel } : {};
}
