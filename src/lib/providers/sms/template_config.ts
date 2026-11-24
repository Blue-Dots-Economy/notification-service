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
});

// MSG91 only: the caller's variable name when the template's placeholder differs
// (Keycloak sends `message`), and a fixed value sent instead of the caller's.
// Pinnacle renders its own body and does not read them, so it rejects them.
const VARIABLE_SCHEMAS = {
  pinnacle: VariableSpecSchema.extend({ from: z.never().optional(), value: z.never().optional() }),
  msg91: VariableSpecSchema.extend({ from: z.string().min(1).optional(), value: z.string().min(1).optional() }),
};

function templateConfigSchema<P extends keyof typeof VARIABLE_SCHEMAS>(provider: P) {
  return z.looseObject({
    template_key: z.string().min(1),
    network: z.string().min(1),
    channel: z.literal('sms'),
    locale: z.string().min(1),
    provider: z.literal(provider),
    provider_template_id: z.string().trim().min(1),
    body_text: z.string().min(1),
    variables: z.array(VARIABLE_SCHEMAS[provider]),
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

/** Allowed link hosts per url variable, lowercased; empty when the config limits none. */
export function urlHostsOf(config: TemplateConfig): Record<string, string[]> {
  return Object.fromEntries(
    config.variables
      .filter((v) => v.type === 'url' && v.urlHosts)
      .map((v) => [v.name, v.urlHosts!.map((h) => h.trim().toLowerCase())])
  );
}

/** Why a url variable may not be sent, or undefined when every link is on its allowed hosts. */
export function linkNotAllowed(
  hostsByVariable: Record<string, string[]> | undefined,
  variables: Record<string, string>
): string | undefined {
  for (const [name, hosts] of Object.entries(hostsByVariable ?? {})) {
    const value = variables[name];
    if (value === undefined) continue;
    let host = '';
    try {
      host = new URL(value).host;
    } catch {
      // not a URL; reported below like any other disallowed host
    }
    if (!hosts.includes(host)) return `${name} host '${host || value}' not in urlHosts`;
  }
  return undefined;
}
