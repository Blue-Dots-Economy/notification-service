import fs from 'fs';
import { isScope, type Scope } from './principal';

export interface HmacKey {
  secret: string;
  scopes: ReadonlySet<Scope>;
}

let KEYS = new Map<string, HmacKey>();

/**
 * Validate the `internal-secrets.json` shape:
 *   { "<keyId>": { "secret": "...", "scopes"?: ["notify:send" | "templates:admin", ...] } }
 * `scopes` defaults to ["notify:send"]: a key may send unless it is explicitly
 * granted administration.
 *
 * An entry whose `secret` is the empty string is skipped with a warning that
 * names the key id: deployments render an unset secret as `""`, and such a key
 * can never authenticate. Every other malformed entry throws so a bad file
 * fails the boot.
 */
export function parseSecrets(raw: unknown): Map<string, HmacKey> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('internal secrets must be a JSON object of key entries');
  }
  const keys = new Map<string, HmacKey>();
  for (const [id, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`internal secrets entry "${id}" must be an object`);
    }
    const { secret, scopes } = entry as { secret?: unknown; scopes?: unknown };
    if (typeof secret !== 'string') {
      throw new Error(`internal secrets entry "${id}" needs a "secret" string`);
    }
    let granted: Scope[] = ['notify:send'];
    if (scopes !== undefined) {
      if (!Array.isArray(scopes) || scopes.length === 0) {
        throw new Error(`internal secrets entry "${id}": "scopes" must be a non-empty array`);
      }
      scopes.forEach((s, index) => {
        if (!isScope(s)) {
          throw new Error(`internal secrets entry "${id}": scopes[${index}] is not a known scope`);
        }
      });
      granted = scopes as Scope[];
    }
    if (secret === '') {
      console.warn(`internal secrets entry "${id}" has an empty "secret"; skipping it`);
      continue;
    }
    keys.set(id, { secret, scopes: new Set(granted) });
  }
  return keys;
}

export function loadSecrets() {
  const path = process.env.INTERNAL_SECRETS_JSON;
  if (!path) throw new Error('INTERNAL_SECRETS_JSON not set');
  KEYS = parseSecrets(JSON.parse(fs.readFileSync(path, 'utf-8')));
  console.log(`Loaded ${KEYS.size} internal secrets`);
}

export function getKey(keyId: string): HmacKey | null {
  return KEYS.get(keyId) ?? null;
}
