import { listPolicies } from '../policies/repo';
import { listTemplates } from '../templates/repo';
import { channelVendor } from '../templates/vendors';
import { CatalogueSchema, type Catalogue } from './schema';

const strip = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;

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
    .sort((a, b) => `${a.channel}\u0000${a.template_key}\u0000${a.locale}`.localeCompare(`${b.channel}\u0000${b.template_key}\u0000${b.locale}`));
  const policies = (await listPolicies({ status: 'active' }))
    .map((p) => ({ domain: p.domain, event_type: p.eventType, mode: p.mode, channels: p.channels }))
    .sort((a, b) => `${a.domain ?? ''}\u0000${a.event_type ?? ''}`.localeCompare(`${b.domain ?? ''}\u0000${b.event_type ?? ''}`));
  // Parse so a store that somehow holds an invalid row fails here, not at the next seed.
  return CatalogueSchema.parse({ version, templates, policies });
}
