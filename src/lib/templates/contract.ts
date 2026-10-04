import { z } from 'zod';
import type { VariableSpec } from '../db/schema';
import { TemplateError } from './errors';

const VariableSpecSchema = z
  .object({
    name: z.string().regex(/^\w+$/, 'letters, digits and underscore only').max(64),
    required: z.boolean().default(true),
    type: z.enum(['string', 'number', 'url']).default('string'),
    sensitive: z.boolean().default(false),
    raw: z.boolean().default(false),
    urlHosts: z.array(z.string().min(1).max(253)).min(1).optional(),
  })
  .strict()
  .refine((s) => s.type === 'url' || s.urlHosts === undefined, {
    message: 'urlHosts applies only to url variables',
    path: ['urlHosts'],
  })
  .refine((s) => !(s.name in Object.prototype), {
    message: 'variable name is reserved',
    path: ['name'],
  });

export const VariableContractSchema = z
  .array(VariableSpecSchema)
  .max(50)
  .refine((specs) => new Set(specs.map((s) => s.name)).size === specs.length, {
    message: 'variable names must be unique',
  }) as unknown as z.ZodType<VariableSpec[]>;

const TOKEN = /\{\{(\w+)\}\}/g;

export function tokensIn(...texts: (string | null | undefined)[]): Set<string> {
  const found = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(TOKEN)) found.add(m[1]!);
  }
  return found;
}

/** Every token is declared and every declared variable is used. */
export function checkTokensMatchContract(
  texts: (string | null | undefined)[],
  contract: VariableSpec[],
): void {
  const tokens = tokensIn(...texts);
  const declared = new Set(contract.map((s) => s.name));
  const undeclared = [...tokens].filter((t) => !declared.has(t));
  if (undeclared.length) {
    throw new TemplateError('undeclared_token', `undeclared tokens: ${undeclared.join(', ')}`, { tokens: undeclared });
  }
  const unused = [...declared].filter((d) => !tokens.has(d));
  if (unused.length) {
    throw new TemplateError('unused_variable', `declared but unused: ${unused.join(', ')}`, { variables: unused });
  }
}

function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((a) => {
    const base = a.toLowerCase();
    return h === base || h.endsWith(`.${base}`);
  });
}

function normalise(spec: VariableSpec, value: unknown): string {
  // Reject non-finite JS numbers (NaN, Infinity, -Infinity) for all variable types
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TemplateError('invalid_variable', `${spec.name} must be a scalar`, { variable: spec.name });
  }

  // Reject non-scalar types: object, function, symbol, bigint
  const valueType = typeof value;
  if (valueType === 'object' || valueType === 'function' || valueType === 'symbol' || valueType === 'bigint') {
    throw new TemplateError('invalid_variable', `${spec.name} must be a scalar`, { variable: spec.name });
  }

  let s = String(value);

  if (spec.type === 'number') {
    s = s.trim();
    if (!s || !/^-?\d+(\.\d+)?$/.test(s)) {
      throw new TemplateError('invalid_variable', `${spec.name} must be a number`, { variable: spec.name });
    }
  }

  if (spec.type === 'url') {
    let url: URL;
    try {
      url = new URL(s);
    } catch {
      throw new TemplateError('invalid_variable', `${spec.name} must be a URL`, { variable: spec.name });
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new TemplateError('invalid_variable', `${spec.name} must be http(s)`, { variable: spec.name });
    }
    if (url.username || url.password) {
      throw new TemplateError('invalid_variable', `${spec.name} host is not allowed`, { variable: spec.name });
    }
    // Strip one trailing dot from hostname before allowlist comparison
    let hostname = url.hostname;
    if (hostname.endsWith('.')) {
      hostname = hostname.slice(0, -1);
    }
    if (spec.urlHosts && !hostAllowed(hostname, spec.urlHosts)) {
      throw new TemplateError('invalid_variable', `${spec.name} host is not allowed`, { variable: spec.name });
    }
    // Return the normalized URL form
    return url.href;
  }

  return s;
}

/**
 * Validate send-time variables against a contract, before any vendor call.
 * Returns the values as strings; absent optional variables are omitted.
 */
export function validateVariables(
  contract: VariableSpec[],
  input: Record<string, unknown>,
): Record<string, string> {
  const byName = new Map(contract.map((s) => [s.name, s]));
  const unknown = Object.keys(input).filter((k) => !byName.has(k));
  if (unknown.length) {
    throw new TemplateError('unknown_variable', `unknown variables: ${unknown.join(', ')}`, { variables: unknown });
  }
  const out: Record<string, string> = {};
  for (const spec of contract) {
    // Use hasOwnProperty to read only own properties, avoiding inherited prototype pollution
    const value = Object.prototype.hasOwnProperty.call(input, spec.name) ? input[spec.name] : undefined;
    const empty = value === undefined || value === null || value === '';
    if (empty) {
      if (spec.required) {
        throw new TemplateError('missing_variable', `missing variable: ${spec.name}`, { variable: spec.name });
      }
      continue;
    }
    out[spec.name] = normalise(spec, value);
  }
  return out;
}

export function sensitiveVariables(contract: VariableSpec[]): string[] {
  return contract.filter((s) => s.sensitive).map((s) => s.name);
}
