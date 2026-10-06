import { z } from 'zod';
import { VariableContractSchema } from '../templates/contract';

const nullableText = (max: number) => z.string().max(max).nullable().optional();
const Slug = (max: number) => z.string().regex(/^[a-z0-9_.-]+$/).max(max);

/** The admin template create body; the catalogue entry is this plus `provider`. */
export const TemplatePatchSchema = z
  .object({
    subject: nullableText(998),
    body_html: nullableText(200_000),
    body_text: nullableText(10_000),
    variables: VariableContractSchema.optional(),
    provider_template_id: nullableText(255),
    sender_id: nullableText(64),
    dlt_entity_id: nullableText(64),
    dlt_header_id: nullableText(64),
    dlt_tag_id: nullableText(64),
    approval_ref: nullableText(255),
    default_deadline_s: z.number().int().positive().max(86_400).nullable().optional(),
  })
  .strict();

export const TemplateCreateSchema = TemplatePatchSchema.extend({
  channel: z.string().min(1).max(32),
  template_key: Slug(128),
  locale: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/).optional(),
}).strict();

const Channels = z.array(z.object({ channel: z.string().min(1).max(32), template_key: Slug(128) }).strict()).max(10);
export const PolicyModeSchema = z.enum(['first_available', 'all']);
export const PolicyChannelsSchema = Channels;
export const PolicyCreateSchema = z
  .object({ domain: Slug(64).nullable().optional(), event_type: Slug(64).nullable().optional(), mode: PolicyModeSchema, channels: Channels })
  .strict();

export const TemplateEntrySchema = TemplateCreateSchema.extend({ provider: z.string().min(1).max(32).optional() }).strict();
export const PolicyEntrySchema = PolicyCreateSchema;

export const CatalogueSchema = z
  .object({
    version: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    templates: z.array(TemplateEntrySchema).max(500).default([]),
    policies: z.array(PolicyEntrySchema).max(500).default([]),
  })
  .strict();

export type Catalogue = z.infer<typeof CatalogueSchema>;
export type TemplateEntry = z.infer<typeof TemplateEntrySchema>;
export type PolicyEntry = z.infer<typeof PolicyEntrySchema>;

/**
 * Validate a catalogue as a whole: one invalid entry rejects the file, so a
 * seed is never partial. Errors name paths only — template bodies are not log data.
 */
export function parseCatalogue(raw: unknown): Catalogue {
  const parsed = CatalogueSchema.safeParse(raw);
  if (!parsed.success) {
    const where = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)'))].join(', ');
    throw new Error(`catalogue is invalid at: ${where}`);
  }
  const c = parsed.data;
  const seenT = new Set<string>();
  c.templates.forEach((t, i) => {
    const k = [t.channel, t.template_key, t.locale ?? '', t.provider ?? ''].join('\u0000');
    if (seenT.has(k)) throw new Error(`catalogue has a duplicate template at templates.${i}`);
    seenT.add(k);
  });
  const seenP = new Set<string>();
  c.policies.forEach((p, i) => {
    const k = [p.domain ?? '', p.event_type ?? ''].join('\u0000');
    if (seenP.has(k)) throw new Error(`catalogue has a duplicate policy at policies.${i}`);
    seenP.add(k);
  });
  return c;
}
