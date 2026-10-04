import type { TemplateRow, VariableSpec } from '../db/schema';
import { MAX_LENGTH, messageType } from '../providers/sms/render';
import { validateVariables } from './contract';
import { TemplateError } from './errors';

export type Rendered =
  | { mode: 'ns'; channel: 'email'; subject: string; html: string | null; text: string | null }
  | { mode: 'ns'; channel: string; text: string; messageType: 'TXT' | 'UNI' }
  | { mode: 'provider'; channel: string; providerTemplateId: string; variables: Record<string, string> };

const TOKEN = /\{\{(\w+)\}\}/g;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function substitute(
  text: string,
  values: Record<string, string>,
  contract: VariableSpec[],
  escape: boolean,
): string {
  const raw = new Set(contract.filter((s) => s.raw).map((s) => s.name));
  return text.replace(TOKEN, (_m, name: string) => {
    const value = Object.prototype.hasOwnProperty.call(values, name) ? values[name] : '';
    return escape && !raw.has(name) ? escapeHtml(value) : value;
  });
}

/**
 * Turn a template + send-time variables into what the vendor receives.
 * Variables are validated against the contract first, so nothing reaches a
 * vendor with a missing, unknown or malformed value.
 */
export function renderTemplate(
  t: TemplateRow,
  renders: 'ns' | 'provider',
  input: Record<string, unknown>,
): Rendered {
  const values = validateVariables(t.variables, input);

  if (renders === 'provider') {
    if (!t.providerTemplateId) {
      throw new TemplateError('incomplete_template', 'provider template id is missing');
    }
    return { mode: 'provider', channel: t.channel, providerTemplateId: t.providerTemplateId, variables: values };
  }

  if (t.channel === 'email') {
    if (!t.subject || (!t.bodyHtml && !t.bodyText)) {
      throw new TemplateError('incomplete_template', 'email needs a subject and a body');
    }
    return {
      mode: 'ns',
      channel: 'email',
      subject: substitute(t.subject, values, t.variables, false).replace(/[\r\n]+/g, ' '),
      html: t.bodyHtml ? substitute(t.bodyHtml, values, t.variables, true) : null,
      text: t.bodyText ? substitute(t.bodyText, values, t.variables, false) : null,
    };
  }

  if (!t.bodyText) throw new TemplateError('incomplete_template', 'body text is missing');
  const text = substitute(t.bodyText, values, t.variables, false);
  const type = messageType(text);
  if (text.length > MAX_LENGTH[type]) {
    throw new TemplateError('body_too_long', `rendered body exceeds ${MAX_LENGTH[type]} characters`, {
      length: text.length,
      messageType: type,
    });
  }
  return { mode: 'ns', channel: t.channel, text, messageType: type };
}
