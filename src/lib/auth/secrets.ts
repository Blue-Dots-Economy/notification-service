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
 * granted administration. Throws on anything else so a bad file fails the boot.
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
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new Error(`internal secrets entry "${id}" needs a non-empty "secret"`);
    }
    let granted: Scope[] = ['notify:send'];
    if (scopes !== undefined) {
      if (!Array.isArray(scopes) || scopes.length === 0) {
        throw new Error(`internal secrets entry "${id}": "scopes" must be a non-empty array`);
      }
      for (const s of scopes) {
        if (!isScope(s)) throw new Error(`internal secrets entry "${id}": unknown scope "${String(s)}"`);
      }
      granted = scopes as Scope[];
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

/** Transitional: removed with request-auth.ts in Task 3. */
export function getSecret(keyId: string): string | null {
  return getKey(keyId)?.secret ?? null;
}
