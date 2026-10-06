/**
 * SMS text helpers shared by template rendering/validation and the Pinnacle
 * adapter: message type detection and the per-type length ceiling.
 */

/**
 * Pinnacle's `messagetype`: `TXT` for Latin-1 text, `UNI` for anything else.
 * Getting this wrong does not fail the send — it garbles the message on the
 * handset — and these deployments carry Hindi copy, so it is detected from the
 * text rather than configured.
 *
 * Written with `\u` escapes rather than literal characters on purpose: a raw
 * high byte here makes the whole file non-UTF-8 to git, which silently turns
 * the one module deciding what text reaches a handset into an unreviewable
 * binary blob in every diff.
 */
export function messageType(text: string): 'TXT' | 'UNI' {
  // eslint-disable-next-line no-control-regex
  return /[^\u0000-\u00ff]/.test(text) ? 'UNI' : 'TXT';
}

/** Per-message character ceiling Pinnacle documents, by message type. */
export const MAX_LENGTH: Record<'TXT' | 'UNI', number> = { TXT: 2000, UNI: 750 };
