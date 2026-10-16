import fs from 'node:fs/promises';
import { defaultLocale } from '../network';
import { createPolicyDraft, policyRowExists, publishPolicy } from '../policies/repo';
import { TemplateError } from '../templates/errors';
import { createTemplateDraft, publishTemplate, templateRowExists } from '../templates/repo';
import { channelVendor } from '../templates/vendors';
import { parseCatalogue, type Catalogue } from './schema';

const MAX_BYTES = 1024 * 1024;
const ACTOR = 'system:catalogue';

export interface SeedReport {
  templates: Record<'created_active' | 'created_draft' | 'exists' | 'skipped_vendor' | 'skipped_channel', number>;
  policies: Record<'created_active' | 'created_draft' | 'exists', number>;
}

/** Read and validate the catalogue file; null (logged, no values) on any problem. */
export async function loadCatalogueFile(path: string): Promise<Catalogue | null> {
  try {
    const stat = await fs.stat(path);
    if (stat.size > MAX_BYTES) throw new Error(`catalogue file is too large (${stat.size} bytes, limit ${MAX_BYTES})`);
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(path, 'utf8'));
    } catch (e) {
      // A filesystem error carries a code and names the path only; a JSON
      // parse error can quote file content, so it is replaced.
      if ((e as NodeJS.ErrnoException).code) throw e;
      throw new Error('catalogue file is not valid JSON');
    }
    return parseCatalogue(raw);
  } catch (e) {
    console.error(`catalogue not seeded: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Create and publish every catalogue entry that has no row yet. An existing row
 * of any status wins: copy is owned by NS and edited through the admin API, so
 * the catalogue only bootstraps an empty deployment. Templates go first, since a
 * policy publish needs its templates active. Call under the seed lock.
 */
export async function seedCatalogue(c: Catalogue): Promise<SeedReport> {
  const report: SeedReport = {
    templates: { created_active: 0, created_draft: 0, exists: 0, skipped_vendor: 0, skipped_channel: 0 },
    policies: { created_active: 0, created_draft: 0, exists: 0 },
  };

  for (const t of c.templates) {
    const vendor = channelVendor(t.channel);
    if (!vendor) { report.templates.skipped_channel++; continue; }
    if (t.provider && t.provider !== vendor.vendor) { report.templates.skipped_vendor++; continue; }
    const locale = t.locale ?? defaultLocale();
    if (await templateRowExists(t.channel, t.template_key, locale, vendor.vendor)) { report.templates.exists++; continue; }
    const draft = await createTemplateDraft(
      {
        channel: t.channel, templateKey: t.template_key, locale,
        subject: t.subject ?? null, bodyHtml: t.body_html ?? null, bodyText: t.body_text ?? null,
        variables: t.variables ?? [], providerTemplateId: t.provider_template_id ?? null,
        senderId: t.sender_id ?? null, dltEntityId: t.dlt_entity_id ?? null, dltHeaderId: t.dlt_header_id ?? null,
        dltTagId: t.dlt_tag_id ?? null, approvalRef: t.approval_ref ?? null, defaultDeadlineS: t.default_deadline_s ?? null,
      },
      ACTOR,
    );
    try {
      await publishTemplate(draft.id, ACTOR);
      report.templates.created_active++;
    } catch (e) {
      // A non-rule error (e.g. the database) also leaves the draft behind: say
      // so, then let it fail the seed.
      const code = e instanceof TemplateError ? e.code : 'db_error';
      console.warn(`catalogue template ${t.channel}/${t.template_key}/${locale} left as draft: ${code}`);
      if (!(e instanceof TemplateError)) throw e;
      report.templates.created_draft++;
    }
  }

  for (const p of c.policies) {
    const domain = p.domain ?? null;
    const eventType = p.event_type ?? null;
    if (await policyRowExists(domain, eventType)) { report.policies.exists++; continue; }
    const draft = await createPolicyDraft({ domain, eventType, mode: p.mode, channels: p.channels }, ACTOR);
    try {
      await publishPolicy(draft.id, ACTOR);
      report.policies.created_active++;
    } catch (e) {
      const code = e instanceof TemplateError ? e.code : 'db_error';
      console.warn(`catalogue policy ${domain ?? '*'}/${eventType ?? '*'} left as draft: ${code}`);
      if (!(e instanceof TemplateError)) throw e;
      report.policies.created_draft++;
    }
  }
  return report;
}
