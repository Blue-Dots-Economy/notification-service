import type { TemplateRow, VariableSpec } from '../db/schema';
import { MAX_LENGTH, messageType } from '../providers/sms/render';
import { checkTokensMatchContract, VariableContractSchema } from './contract';
import { TemplateError } from './errors';

const VALID_TOKEN = /\{\{\w+\}\}/g;

/**
 * Reject a `{{` or `}}` that is not part of a valid `{{name}}` token, e.g.
 * `{{ name }}`: it would otherwise be sent to recipients verbatim.
 */
function checkNoMalformedTokens(texts: (string | null | undefined)[]): void {
  for (const text of texts) {
    if (!text) continue;
    const rest = text.replace(VALID_TOKEN, '');
    if (rest.includes('{{') || rest.includes('}}')) {
      throw new TemplateError('undeclared_token', 'malformed token: use {{name}} with letters, digits and underscore only', {
        malformed: true,
      });
    }
  }
}

const URL_ATTR = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

/**
 * A variable inside an href/src attribute value controls where a link points
 * or what loads, so it must be a `url` variable (scheme- and host-checked at
 * send time); HTML-escaping a string does not stop `javascript:`.
 */
function checkUrlAttributes(html: string | null, contract: VariableSpec[]): void {
  if (!html) return;
  const byName = new Map(contract.map((s) => [s.name, s]));
  for (const m of html.matchAll(URL_ATTR)) {
    const value = m[1] ?? m[2] ?? m[3] ?? '';
    for (const t of value.matchAll(VALID_TOKEN)) {
      const name = t[0].slice(2, -2);
      if (byName.get(name)?.type !== 'url') {
        throw new TemplateError('invalid_contract', `${name} is used in an href/src attribute and must be type url`, {
          variable: name,
        });
      }
    }
  }
}

/** Everything that must be true before a template may become active. */
export function validateForPublish(
  t: TemplateRow,
  vendor: { vendor: string; renders: 'ns' | 'provider' } | undefined,
): void {
  if (!vendor) throw new TemplateError('unknown_channel', `no provider for channel ${t.channel}`);
  if (t.provider !== vendor.vendor) {
    throw new TemplateError('vendor_mismatch', `template is for ${t.provider}; this deployment sends ${t.channel} via ${vendor.vendor}`);
  }
  const parsed = VariableContractSchema.safeParse(t.variables);
  if (!parsed.success) throw new TemplateError('invalid_contract', 'variable contract is invalid');
  const contract = parsed.data;

  if (t.channel === 'email') {
    if (!t.subject || (!t.bodyHtml && !t.bodyText)) {
      throw new TemplateError('incomplete_template', 'email needs a subject and a body');
    }
    checkNoMalformedTokens([t.subject, t.bodyHtml, t.bodyText]);
    checkTokensMatchContract([t.subject, t.bodyHtml, t.bodyText], contract);
    checkUrlAttributes(t.bodyHtml, contract);
    return;
  }

  if (contract.some((s) => s.raw)) {
    throw new TemplateError('invalid_contract', 'raw applies only to email variables');
  }
  if (!t.providerTemplateId) throw new TemplateError('incomplete_template', 'provider template id is missing');
  if (vendor.renders === 'ns' && !t.bodyText) {
    throw new TemplateError('incomplete_template', `${vendor.vendor} needs the approved body text`);
  }
  if (t.bodyText) {
    checkNoMalformedTokens([t.bodyText]);
    checkTokensMatchContract([t.bodyText], contract);
    const type = messageType(t.bodyText);
    if (t.bodyText.length > MAX_LENGTH[type]) {
      throw new TemplateError('body_too_long', `body exceeds ${MAX_LENGTH[type]} characters`);
    }
  }
}
