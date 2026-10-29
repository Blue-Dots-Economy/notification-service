/**
 * Body rendering for SMS vendors that do not render (Pinnacle takes final text
 * plus DLT ids; MSG91 Flow renders the DLT-approved text itself).
 */

const TOKEN = /\{\{(\w+)\}\}/g;

export class UnresolvedTemplateVariables extends Error {
  constructor(public readonly missing: string[]) {
    super(`unresolved template variables: ${missing.join(', ')}`);
    this.name = 'UnresolvedTemplateVariables';
  }
}

/**
 * Substitute `{{token}}` placeholders in `body` from `variables`.
 *
 * Throws UnresolvedTemplateVariables on any token with no (or an empty) value:
 * an unsubstituted `{{name}}` would reach the handset verbatim and no longer
 * match the DLT-approved text.
 */
export function renderBody(body: string, variables: Record<string, unknown>): string {
  const missing: string[] = [];

  const out = body.replace(TOKEN, (_match, name: string) => {
    const value = variables?.[name];
    if (value === undefined || value === null || value === '') {
      missing.push(name);
      return '';
    }
    return String(value);
  });

  if (missing.length) throw new UnresolvedTemplateVariables([...new Set(missing)]);
  return out;
}

/**
 * Pinnacle's `messagetype`: `TXT` for Latin-1 text, `UNI` for anything else.
 * A wrong type garbles the message on the handset rather than failing the send,
 * and deployments carry Hindi copy, so it is detected from the text.
 *
 * Uses `\u` escapes, not literal characters: a raw high byte would make git
 * treat the file as binary and hide it from diffs.
 */
export function messageType(text: string): 'TXT' | 'UNI' {
  // eslint-disable-next-line no-control-regex
  return /[^\u0000-\u00ff]/.test(text) ? 'UNI' : 'TXT';
}

/** Per-message character ceiling Pinnacle documents, by message type. */
export const MAX_LENGTH: Record<'TXT' | 'UNI', number> = { TXT: 2000, UNI: 750 };
