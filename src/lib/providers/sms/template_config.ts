import { z } from 'zod';

/**
 * An SMS template config, as the providers read their OTP templates from env. It has the
 * same fields as a row of the notification-service template table, but is not stored
 * anywhere. Shared so Pinnacle and MSG91 accept the same shape.
 */

const VariableSpecSchema = z.looseObject({
  name: z.string().min(1),
  required: z.boolean().optional(),
  type: z.string().optional(),
  sensitive: z.boolean().optional(),
  raw: z.boolean().optional(),
  urlHosts: z.array(z.string().min(1)).optional(),
  // MSG91 only: the caller's variable name when the template's placeholder differs
  // (Keycloak sends `message`), and a fixed value sent instead of the caller's.
  from: z.string().min(1).optional(),
  value: z.string().min(1).optional(),
});

function templateConfigSchema<P extends string>(provider: P) {
  return z.looseObject({
    template_key: z.string().min(1),
    network: z.string().min(1),
    channel: z.literal('sms'),
    locale: z.string().min(1),
    provider: z.literal(provider),
    provider_template_id: z.string().trim().min(1),
    body_text: z.string().min(1),
    variables: z.array(VariableSpecSchema),
    version: z.number().int().optional(),
    approval_ref: z.string().optional(),
  });
}

const SCHEMAS = { pinnacle: templateConfigSchema('pinnacle'), msg91: templateConfigSchema('msg91') };

export type SmsTemplateProvider = keyof typeof SCHEMAS;
export type TemplateConfig = z.infer<(typeof SCHEMAS)[SmsTemplateProvider]>;

export function parseTemplateConfig(
  raw: string,
  expectedKey: string,
  provider: SmsTemplateProvider
): TemplateConfig | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { error: 'not valid JSON' };
  }
  const parsed = SCHEMAS[provider].safeParse(json);
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => i.path.join('.') || 'row').join(', ') + ' invalid or missing' };
  }
  const row = parsed.data;
  if (row.template_key !== expectedKey) {
    return { error: `template_key is '${row.template_key}', expected '${expectedKey}'` };
  }
  const placeholders = [...row.body_text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
  const declared = row.variables.map((v) => v.name);
  const undeclaredPlaceholders = placeholders.filter((v) => !declared.includes(v));
  if (undeclaredPlaceholders.length) return { error: `body_text uses undeclared variables: ${undeclaredPlaceholders.join(', ')}` };
  return row;
}
