import type { TemplateRow } from '../db/schema';
import { MAX_LENGTH, messageType } from '../providers/sms/render';
import { checkTokensMatchContract, VariableContractSchema } from './contract';
import { TemplateError } from './errors';

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
    checkTokensMatchContract([t.subject, t.bodyHtml, t.bodyText], contract);
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
    checkTokensMatchContract([t.bodyText], contract);
    const type = messageType(t.bodyText);
    if (t.bodyText.length > MAX_LENGTH[type]) {
      throw new TemplateError('body_too_long', `body exceeds ${MAX_LENGTH[type]} characters`);
    }
  }
}
