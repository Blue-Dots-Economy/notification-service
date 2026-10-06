import { listPolicies } from '../policies/repo';
import { listTemplates } from '../templates/repo';
import { TemplateError } from '../templates/errors';
import { channelVendor } from '../templates/vendors';
import { CatalogueSchema, type Catalogue } from './schema';

const strip = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;

/** Code-point order, field by field: stable across locales and runtimes. */
function compareKeys(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
}

/** Active templates (current vendors only) and policies, as a seedable catalogue. */
export async function exportCatalogue(version: string): Promise<Catalogue> {
  const templates = (await listTemplates({ status: 'active' }))
    .filter((t) => channelVendor(t.channel)?.vendor === t.provider)
    .map((t) => strip({
      channel: t.channel, template_key: t.templateKey, locale: t.locale, provider: t.provider,
      subject: t.subject, body_html: t.bodyHtml, body_text: t.bodyText, variables: t.variables,
      provider_template_id: t.providerTemplateId, sender_id: t.senderId, dlt_entity_id: t.dltEntityId,
      dlt_header_id: t.dltHeaderId, dlt_tag_id: t.dltTagId, approval_ref: t.approvalRef,
      default_deadline_s: t.defaultDeadlineS,
    }))
    .sort((a, b) => compareKeys([a.channel!, a.template_key!, a.locale ?? ''], [b.channel!, b.template_key!, b.locale ?? '']));
  const policies = (await listPolicies({ status: 'active' }))
    .map((p) => ({ domain: p.domain, event_type: p.eventType, mode: p.mode, channels: p.channels }))
    .sort((a, b) => compareKeys([a.domain ?? '', a.event_type ?? ''], [b.domain ?? '', b.event_type ?? '']));
  // Parse so a store that does not fit the catalogue format (e.g. more than 500
  // active rows) fails here, not at the next seed. The error names paths only.
  const parsed = CatalogueSchema.safeParse({ version, templates, policies });
  if (!parsed.success) {
    const where = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)'))].join(', ');
    throw new TemplateError('export_invalid', `export does not fit the catalogue format at: ${where}`);
  }
  return parsed.data;
}
