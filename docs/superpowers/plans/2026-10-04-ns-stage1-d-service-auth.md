# NS Stage 1 Plan D — Service Auth and Admin Scopes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace notification-service's single HMAC check with two credential types behind one auth boundary. Callers can present Keycloak bearer tokens (audience + `azp` allowlist + client roles) or a body-signing HMAC `v2`. A sending credential is separate from an administering one.

**Architecture:**
- **One preHandler factory, `authenticate({ scope })`.** It resolves a request to a `Principal` (`kind`, `id`, `scopes`) from either credential type. It then enforces the route's scope (`notify:send` or `templates:admin`).
- **Bearer tokens** are verified with `jose` against the realm JWKS. `jose` 6 is ESM-only, so it is loaded through a dynamic `import()`.
- **HMAC `v2`** signs `METHOD\npath\ntimestamp\nnonce\nsha256(body)` over the raw request bytes. A JSON content-type parser captures those bytes.
- **Keycloak changes.** The realm gains a bearer-only `notification-service` client with two client roles. A caller receives `aud: notification-service` by being granted one of those roles. Keycloak's built-in *audience resolve* mapper in the default `roles` scope adds it, so no existing client is modified.

**Tech Stack:** Fastify 5, TypeScript 7 (CommonJS output, `module`/`moduleResolution: Node16`), Zod 4, `jose` 6, ioredis 6, vitest 4, pnpm 10. Keycloak realm JSON (aggregator-dpg). Helm, Python and Bash in bluedots-automation.

**Spec:** `docs/superpowers/specs/2026-06-26-event-platform-design.md` (rev 2026-10-04) — §Auth and tenancy, §Security, §API sketch, §Stages item 8. Issue: notification-service#62.

## Global Constraints

- **One realm, shared by every service.** It is named per deployment, from `global.keycloak.realm` in automation. The resource-server client id is `notification-service`; NS never logs in with it.
- **Client roles:** `notify:send` and `templates:admin`. A credential holding `notify:send` must not be able to administer templates or policies.
- **Bearer tokens must carry `aud` = `notification-service` AND an `azp` on the configured allowlist.** Signature and issuer alone are not enough, because every service shares one realm and one signing key.
- **HMAC `v2` canonical string:** `METHOD\npath\ntimestamp\nnonce\nsha256(body)`. The digest is lowercase hex SHA-256 of the raw request body bytes, or of the empty string when there is no body. The header is `X-NS-Signature: v2=<64 lowercase hex>`. `path` is `req.url`, including the query string.
- **HMAC `v1` is not accepted on any route this plan touches.** The single exception is legacy `POST /notify`, which keeps `v1` until it is deleted in the cutover release (Plan F); see Ruling D1.
- **The signature is verified BEFORE the nonce is claimed.** Nonce key: `nonce:<keyId>:<nonce>`, `SET NX EX 60`. Allowed clock skew: 30 s.
- **No network claim.** Network comes from `NS_NETWORK` only. Tokens and requests never carry it.
- **Documentation and schema endpoints (`/`, `/openapi.json`) are off unless `NS_DOCS_ENABLED=true`.**
- **`GET /metrics` stays unauthenticated and content-free.**
- **TypeScript.**
  - Keep `module`/`moduleResolution: Node16`. Do not change tsconfig.
  - `jose` is ESM-only and must never be imported with a static `import` from CommonJS code; that is a TS1479 compile error. Load it with `await import('jose')`.
  - Imports in `src/lib` are extensionless.
- **Repos are public.** State requirements positively. No vulnerability narratives, exploit descriptions or PoCs in code comments, docs, commit messages or PR text.
- **Tests and commits.** Never run `vitest --root /`. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Branches.** Each repo gets its own branch, and nothing is pushed without explicit approval.
  - notification-service: `feat/ns-service-auth` off `feat/ns-send-api-v1` (PR #150).
  - aggregator-dpg: `feat/ns-keycloak-client` off `feature`.
  - bluedots-automation: `feat/ns-service-auth` off `feat/ns-network-config` (PR #261).

### Rulings made while writing this plan (review these)

- **D1 — legacy `v1` lives exactly as long as legacy `/notify`.**
  - `POST /notify` accepts HMAC `v1` or `v2`. Every other route accepts `v2` or bearer only.
  - Today's callers (the Keycloak SMS plugin, Signals) sign `v1` against `/notify`. If NS rejected `v1` outright, whichever of NS and the plugin deployed second would break login OTP.
  - With D1, Plan F moves each caller to `/v1/notify` with `v2` or bearer, then deletes `/notify` and the `v1` verifier in the same change.
- **D2 — `POST /failed/retry` requires `templates:admin`.** Replaying the dead-letter queue re-sends other callers' messages. That is an operator action, not a send. `GET /providers*` and `GET /metrics/queue` accept any authenticated principal.
- **D3 — HMAC keys carry scopes in `internal-secrets.json`.**
  - The format is `{ "<keyId>": { "secret": "...", "scopes": ["notify:send", "templates:admin"] } }`.
  - `scopes` defaults to `["notify:send"]`, so every existing entry keeps working unchanged.
  - This replaces Plan B's interim `NS_ADMIN_KEY_IDS`, which is removed.
- **D4 — audience comes from the role grant (*audience resolve*), not from a per-client audience mapper.**
  - Keycloak adds `aud: notification-service` to any token whose subject holds a `notification-service` client role, through the built-in `roles` client scope.
  - Granting a role is the whole act of authorising a caller, and no existing client definition changes.
  - This matters for deployment: `apply-realm-config.py` creates missing clients but never modifies existing ones.
- **D5 — both credential types on one request → `401 Ambiguous credentials`.** Silently preferring one would hide a misconfigured caller.

## Review Focus

1. **Body bytes vs parsed JSON.** The digest is over the bytes received. A client that signs compact JSON but sends pretty-printed JSON (or the reverse) must get `401 Invalid signature`. A non-ASCII body signed over its exact UTF-8 bytes must pass. → Task 3 tests "re-serialised body is rejected" and "non-ASCII body verifies".
2. **Keycloak or JWKS unreachable.** Bearer callers get `503 Auth service unavailable`, not `401`; a Keycloak outage must not read as every token being bad. HMAC callers keep working. → Task 2 tests "JWKS fetch failure → 503" and "JWKS timeout → 503".
3. **A token minted for another client in the same realm.**
   - A token whose `aud` lacks `notification-service` → `401`.
   - A token with the audience but an `azp` not on the allowlist → `401`.
   - A token with the audience and an allowlisted `azp` but no NS role → `403` on every scoped route.
   - An ID token (`typ: ID`) → `401`.
   → Task 2 and Task 3 tests.
4. **A sending credential calling the admin API.**
   - An HMAC key with default scopes, or a bearer token holding only `notify:send`, gets `403 Insufficient scope` on `/v1/admin/*` and `/failed/retry`.
   - A `v1` signature on `/v1/notify` gets `401 Signature version not accepted`.
   → Task 3 tests.
5. **Requests that are easy to mis-sign.**
   - GET with a query string: the signed path includes the query.
   - POST with an empty body: the digest of the empty string.
   - The largest attachment body allowed by the `/notify` body limit.
   - `Content-Type: application/json; charset=utf-8`.
   All must verify when signed as specified. → Task 3 tests.

---

## File Structure

**notification-service** (worktree `.worktrees/ns-plan-d/notification-service`, branch `feat/ns-service-auth`)

| File | Responsibility |
|---|---|
| `src/lib/auth/principal.ts` (new) | `Scope`, `SCOPES`, `Principal`, `principalLabel()` |
| `src/lib/auth/secrets.ts` (rewrite) | Load and validate `internal-secrets.json`, with per-key scopes |
| `src/lib/auth/hmac.ts` (new) | Pure HMAC helpers: digest, canonical string, signature parse and compare |
| `src/lib/auth/bearer.ts` (new) | Bearer config from env, `jose` loading, JWKS memo, `verifyBearer()` |
| `src/plugins/raw-body.ts` (new) | JSON content-type parser that keeps `req.rawBody` |
| `src/plugins/auth.ts` (new) | `authenticate({ scope, legacyHmacV1? })` preHandler factory |
| `src/types/fastify-auth.ts` (new) | `FastifyRequest` augmentation: `rawBody`, `principal` |
| `src/plugins/request-auth.ts`, `src/plugins/require-admin.ts` + tests (delete) | Replaced by `auth.ts` |
| `src/app.ts`, `src/routes/*.ts`, `src/lib/boot-config.ts`, `src/lib/utils/openapi.ts` | Wiring, docs gating, boot validation, OpenAPI security |
| `CLAUDE.md`, `README.md`, `example.env`, `package.json` | Docs, env, `jose` dependency |

**aggregator-dpg** (branch `feat/ns-keycloak-client`): `infra/keycloak/realms/realm.json`.

**bluedots-automation** (branch `feat/ns-service-auth`):
- `helm/keycloak/charts/keycloak/files/realm.json` (rebuilt)
- `helm/keycloak/files/apply-realm-config.py`
- `scripts/assert-realm.sh`
- the NS chart (`helm/signals/charts/notification-service/`)
- `helm/CLAUDE.md`

---

### Task 1: Credential primitives — principal, scoped HMAC keys, HMAC v2 helpers

**Files:**
- Create: `src/lib/auth/principal.ts`, `src/lib/auth/hmac.ts`, `src/lib/auth/__tests__/hmac.test.ts`, `src/lib/auth/__tests__/secrets.test.ts`
- Modify: `src/lib/auth/secrets.ts` (rewrite)

**Interfaces:**
- Produces:
  - `type Scope = 'notify:send' | 'templates:admin'`
  - `SCOPES: readonly Scope[]`
  - `interface Principal { kind: 'bearer' | 'hmac'; id: string; scopes: ReadonlySet<Scope> }`
  - `principalLabel(p: Principal | undefined): string`, which returns `` `${kind}:${id}` `` or `'unknown'`
  - `interface HmacKey { secret: string; scopes: ReadonlySet<Scope> }`
  - `parseSecrets(raw: unknown): Map<string, HmacKey>`, which throws on invalid input
  - `loadSecrets(): void`
  - `getKey(keyId: string): HmacKey | null`
  - `type HmacVersion = 'v1' | 'v2'`
  - `MAX_SKEW_SECONDS = 30`, `NONCE_TTL_SECONDS = 60`
  - `bodyDigest(body?: Buffer): string`
  - `canonicalString(version, method, path, ts, nonce, body?): string`
  - `signHmac(version, secret, canonical): string`, which returns `v2=<hex>`
  - `parseSignature(header: string): { version: HmacVersion; mac: Buffer } | null`
  - `macMatches(secret: string, canonical: string, mac: Buffer): boolean`
- `getSecret` is removed. Its only caller, `request-auth.ts`, is deleted in Task 3, so this task keeps `getSecret` as a thin wrapper `(id) => getKey(id)?.secret ?? null` until then.

- [ ] **Step 1: Write the failing tests**

`src/lib/auth/__tests__/hmac.test.ts`:

```ts
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bodyDigest, canonicalString, macMatches, parseSignature, signHmac } from '../hmac';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('hmac v2', () => {
  it('digests the empty body when there is none', () => {
    expect(bodyDigest()).toBe(EMPTY_SHA256);
    expect(bodyDigest(Buffer.alloc(0))).toBe(EMPTY_SHA256);
  });

  it('v2 canonical string ends with the body digest; v1 has none', () => {
    const body = Buffer.from('{"a":1}');
    expect(canonicalString('v2', 'post', '/v1/notify', '100', 'n1', body)).toBe(
      ['POST', '/v1/notify', '100', 'n1', crypto.createHash('sha256').update(body).digest('hex')].join('\n'),
    );
    expect(canonicalString('v1', 'POST', '/notify', '100', 'n1', body)).toBe('POST\n/notify\n100\nn1');
  });

  it('signs and verifies a round trip', () => {
    const c = canonicalString('v2', 'GET', '/providers?x=1', '100', 'n1');
    const header = signHmac('v2', 'secret', c);
    const parsed = parseSignature(header)!;
    expect(parsed.version).toBe('v2');
    expect(macMatches('secret', c, parsed.mac)).toBe(true);
    expect(macMatches('other', c, parsed.mac)).toBe(false);
  });

  it.each(['v3=' + 'a'.repeat(64), 'v2=' + 'A'.repeat(64), 'v2=' + 'a'.repeat(63), 'v2=zz', 'v2', ''])(
    'rejects malformed signature header %j',
    (h) => expect(parseSignature(h)).toBeNull(),
  );
});
```

`src/lib/auth/__tests__/secrets.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseSecrets } from '../secrets';

describe('parseSecrets', () => {
  it('defaults scopes to notify:send', () => {
    const keys = parseSecrets({ keycloak: { secret: 's1' } });
    expect([...keys.get('keycloak')!.scopes]).toEqual(['notify:send']);
  });

  it('keeps declared scopes', () => {
    const keys = parseSecrets({ ops: { secret: 's', scopes: ['notify:send', 'templates:admin'] } });
    expect(keys.get('ops')!.scopes.has('templates:admin')).toBe(true);
  });

  it.each([
    [{ a: { secret: '' } }, /secret/],
    [{ a: { secret: 1 } }, /secret/],
    [{ a: { secret: 's', scopes: [] } }, /scopes/],
    [{ a: { secret: 's', scopes: ['admin'] } }, /unknown scope "admin"/],
    [{ a: 'plain-string' }, /entry/],
    [[], /object/],
    [null, /object/],
  ])('rejects %j', (raw, message) => {
    expect(() => parseSecrets(raw)).toThrow(message);
  });

  it('does not resolve prototype names as key ids', () => {
    const keys = parseSecrets({ a: { secret: 's' } });
    expect(keys.get('constructor')).toBeUndefined();
    expect(keys.get('__proto__')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**
Run: `pnpm vitest run src/lib/auth`
Expected: FAIL, because the modules `../hmac`, `../secrets` (`parseSecrets`) and `../principal` do not exist yet.

- [ ] **Step 3: Implement**

`src/lib/auth/principal.ts`:

```ts
export const SCOPES = ['notify:send', 'templates:admin'] as const;
export type Scope = (typeof SCOPES)[number];

export function isScope(value: unknown): value is Scope {
  return typeof value === 'string' && (SCOPES as readonly string[]).includes(value);
}

/**
 * Who is calling, as decided by `authenticate`. `id` is the HMAC key id, or for
 * a bearer token the client (`azp`) — plus the subject for a person's token.
 */
export interface Principal {
  kind: 'bearer' | 'hmac';
  id: string;
  scopes: ReadonlySet<Scope>;
}

/** Stable label for audit rows and admin `created_by`/`published_by`. */
export function principalLabel(p: Principal | undefined): string {
  return p ? `${p.kind}:${p.id}` : 'unknown';
}
```

`src/lib/auth/hmac.ts`:

```ts
import crypto from 'node:crypto';

export type HmacVersion = 'v1' | 'v2';

/** Seconds a signed timestamp may differ from this server's clock. */
export const MAX_SKEW_SECONDS = 30;
/** Nonce lifetime; at least twice the skew so a nonce outlives its timestamp window. */
export const NONCE_TTL_SECONDS = 60;

const SIGNATURE = /^(v1|v2)=([0-9a-f]{64})$/;

/** Lowercase hex SHA-256 of the exact request bytes; the empty string when there is no body. */
export function bodyDigest(body?: Buffer): string {
  return crypto.createHash('sha256').update(body ?? Buffer.alloc(0)).digest('hex');
}

/**
 * v2: METHOD\npath\ntimestamp\nnonce\nsha256(body) — the body is covered.
 * v1: METHOD\npath\ntimestamp\nnonce — accepted only on legacy /notify.
 */
export function canonicalString(
  version: HmacVersion,
  method: string,
  path: string,
  ts: string,
  nonce: string,
  body?: Buffer,
): string {
  const parts = [method.toUpperCase(), path, ts, nonce];
  if (version === 'v2') parts.push(bodyDigest(body));
  return parts.join('\n');
}

export function signHmac(version: HmacVersion, secret: string, canonical: string): string {
  return `${version}=${crypto.createHmac('sha256', secret).update(canonical).digest('hex')}`;
}

export function parseSignature(header: string): { version: HmacVersion; mac: Buffer } | null {
  const m = SIGNATURE.exec(header);
  return m ? { version: m[1] as HmacVersion, mac: Buffer.from(m[2], 'hex') } : null;
}

export function macMatches(secret: string, canonical: string, mac: Buffer): boolean {
  const expected = crypto.createHmac('sha256', secret).update(canonical).digest();
  return expected.length === mac.length && crypto.timingSafeEqual(expected, mac);
}
```

`src/lib/auth/secrets.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests.**
Run: `pnpm vitest run src/lib/auth src/plugins` then `pnpm build`
Expected: the new suites pass, the existing `request-auth` tests still pass (they use `loadSecrets` + `getSecret`), and the build is clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth
git commit -m "feat(auth): scoped HMAC keys and v2 body-signing helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Bearer token verification

**Files:**
- Create: `src/lib/auth/bearer.ts`, `src/lib/auth/__tests__/bearer.test.ts`
- Modify: `package.json` (add `jose`), `src/lib/boot-config.ts`

**Interfaces:**
- Consumes: `Principal`, `Scope`, `isScope` (Task 1).
- Produces:
  - `interface BearerConfig { issuer: string; jwksUri: string; audience: string; allowedAzp: ReadonlySet<string> }`
  - `bearerConfig(env?): BearerConfig | null`. It returns `null` when `NS_KEYCLOAK_ISSUER` is unset, meaning bearer auth is off. It throws on invalid config.
  - `type BearerResult = { ok: true; principal: Principal } | { ok: false; status: 401 | 503; error: string }`
  - `verifyBearer(token: string, cfg: BearerConfig): Promise<BearerResult>`
  - Test seam: `setKeyResolverForTests(get?: JWTVerifyGetKey): void`

Environment:
- `NS_KEYCLOAK_ISSUER`: the exact `iss` claim, `https://<public kc host>/auth/realms/<realm>`.
- `NS_KEYCLOAK_JWKS_URI`: optional. It defaults to `<issuer>/protocol/openid-connect/certs`, and in-cluster deploys override it with the internal URL.
- `NS_AUTH_AUDIENCE`: defaults to `notification-service`.
- `NS_AUTH_ALLOWED_AZP`: a comma list. It is required (non-empty) when the issuer is set.

Error strings:
- `401` for `Token invalid`, `Token expired` and `Token client not accepted`.
- `503` for `Auth service unavailable`.

- [ ] **Step 1: Add the dependency**

```bash
pnpm add jose@^6
```

- [ ] **Step 2: Write the failing tests**

`src/lib/auth/__tests__/bearer.test.ts`:

```ts
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, errors } from 'jose';
import { bearerConfig, setKeyResolverForTests, verifyBearer, type BearerConfig } from '../bearer';

const ISS = 'https://kc.example/auth/realms/bluedots';
const cfg: BearerConfig = {
  issuer: ISS,
  jwksUri: `${ISS}/protocol/openid-connect/certs`,
  audience: 'notification-service',
  allowedAzp: new Set(['signals-api']),
};

let privateKey: CryptoKey;
beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as CryptoKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' };
  setKeyResolverForTests(createLocalJWKSet({ keys: [jwk] }));
});
afterEach(() => undefined);

function token(claims: Record<string, unknown>, opts: { exp?: string | number; iss?: string } = {}) {
  return new SignJWT({ typ: 'Bearer', azp: 'signals-api', client_id: 'signals-api', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.iss ?? ISS)
    .setSubject('sa-uuid')
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(privateKey);
}
const nsRoles = (roles: string[]) => ({ resource_access: { 'notification-service': { roles } } });

describe('verifyBearer', () => {
  it('accepts a service-account token and maps NS client roles to scopes', async () => {
    const res = await verifyBearer(await token({ aud: ['signals-api', 'notification-service'], ...nsRoles(['notify:send', 'uma_protection']) }), cfg);
    expect(res).toMatchObject({ ok: true, principal: { kind: 'bearer', id: 'signals-api' } });
    if (res.ok) expect([...res.principal.scopes]).toEqual(['notify:send']);
  });

  it('identifies a person by client and subject', async () => {
    const res = await verifyBearer(await token({ aud: 'notification-service', client_id: undefined, ...nsRoles(['templates:admin']) }), cfg);
    expect(res).toMatchObject({ ok: true, principal: { id: 'signals-api:sa-uuid' } });
  });

  it('ignores roles held on other clients', async () => {
    const res = await verifyBearer(
      await token({ aud: 'notification-service', resource_access: { 'signals-api': { roles: ['templates:admin'] } } }),
      cfg,
    );
    expect(res.ok && res.principal.scopes.size).toBe(0);
  });

  it.each([
    ['audience missing', { aud: 'signals-api' }, 'Token invalid'],
    ['azp not allowlisted', { aud: 'notification-service', azp: 'aggregator-dpg' }, 'Token client not accepted'],
    ['azp absent', { aud: 'notification-service', azp: undefined }, 'Token client not accepted'],
    ['an ID token', { aud: 'notification-service', typ: 'ID' }, 'Token invalid'],
  ])('rejects %s with 401', async (_name, claims, error) => {
    expect(await verifyBearer(await token(claims), cfg)).toEqual({ ok: false, status: 401, error });
  });

  it('rejects another issuer', async () => {
    const t = await token({ aud: 'notification-service' }, { iss: 'https://kc.example/auth/realms/other' });
    expect(await verifyBearer(t, cfg)).toEqual({ ok: false, status: 401, error: 'Token invalid' });
  });

  it('reports an expired token as expired', async () => {
    const t = await token({ aud: 'notification-service' }, { exp: Math.floor(Date.now() / 1000) - 120 });
    expect(await verifyBearer(t, cfg)).toEqual({ ok: false, status: 401, error: 'Token expired' });
  });

  it('rejects garbage', async () => {
    expect(await verifyBearer('not-a-jwt', cfg)).toEqual({ ok: false, status: 401, error: 'Token invalid' });
  });

  it('answers 503 when the key set cannot be fetched', async () => {
    setKeyResolverForTests(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await verifyBearer(await token({ aud: 'notification-service' }), cfg)).toEqual({
      ok: false, status: 503, error: 'Auth service unavailable',
    });
    setKeyResolverForTests(async () => {
      throw new errors.JWKSTimeout();
    });
    expect(await verifyBearer(await token({ aud: 'notification-service' }), cfg)).toEqual({
      ok: false, status: 503, error: 'Auth service unavailable',
    });
  });
});

describe('bearerConfig', () => {
  it('is off without an issuer', () => expect(bearerConfig({})).toBeNull());

  it('derives the JWKS URI and defaults the audience', () => {
    expect(bearerConfig({ NS_KEYCLOAK_ISSUER: `${ISS}/`, NS_AUTH_ALLOWED_AZP: ' signals-api , ' })).toEqual({
      issuer: `${ISS}/`,
      jwksUri: `${ISS}/protocol/openid-connect/certs`,
      audience: 'notification-service',
      allowedAzp: new Set(['signals-api']),
    });
  });

  it('requires an azp allowlist when bearer auth is on', () => {
    expect(() => bearerConfig({ NS_KEYCLOAK_ISSUER: ISS })).toThrow(/NS_AUTH_ALLOWED_AZP/);
  });

  it('rejects an invalid JWKS URI', () => {
    expect(() => bearerConfig({ NS_KEYCLOAK_ISSUER: ISS, NS_AUTH_ALLOWED_AZP: 'a', NS_KEYCLOAK_JWKS_URI: 'not a url' })).toThrow();
  });
});
```

The 503 cases replace the key resolver, so they stay last in the file; any test added after them must reinstall the local key set first.

The issuer is compared exactly, so a trailing slash in the configured issuer only matches a token whose `iss` also has it. Keycloak's `iss` has no trailing slash, so document that the configured issuer must not end with `/`. The JWKS derivation strips the trailing slash only for building the URL.

- [ ] **Step 3: Run the tests and confirm they fail.**
Run: `pnpm vitest run src/lib/auth/__tests__/bearer.test.ts`
Expected: FAIL, because `../bearer` does not exist yet.

- [ ] **Step 4: Implement `src/lib/auth/bearer.ts`**

```ts
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import { isScope, type Principal, type Scope } from './principal';

export interface BearerConfig {
  issuer: string;
  jwksUri: string;
  audience: string;
  allowedAzp: ReadonlySet<string>;
}

export type BearerResult =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401 | 503; error: string };

/**
 * Bearer auth is on when NS_KEYCLOAK_ISSUER is set. The issuer must equal the
 * token's `iss` exactly (Keycloak: https://<host>/auth/realms/<realm>, no
 * trailing slash). Every service shares the realm, so the audience AND an
 * allowlisted `azp` are both required.
 */
export function bearerConfig(env: NodeJS.ProcessEnv = process.env): BearerConfig | null {
  const issuer = env.NS_KEYCLOAK_ISSUER?.trim();
  if (!issuer) return null;
  const allowedAzp = new Set(
    (env.NS_AUTH_ALLOWED_AZP ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  );
  if (allowedAzp.size === 0) {
    throw new Error('NS_AUTH_ALLOWED_AZP must list at least one client id when NS_KEYCLOAK_ISSUER is set');
  }
  const jwksUri =
    env.NS_KEYCLOAK_JWKS_URI?.trim() || `${issuer.replace(/\/+$/, '')}/protocol/openid-connect/certs`;
  new URL(jwksUri); // throws on an invalid URI, failing the boot
  return { issuer, jwksUri, audience: env.NS_AUTH_AUDIENCE?.trim() || 'notification-service', allowedAzp };
}

// jose 6 is ESM-only; this CommonJS build loads it with a dynamic import, which
// `module: Node16` emits as a real import() rather than require().
type Jose = typeof import('jose');
let josePromise: Promise<Jose> | undefined;
const loadJose = (): Promise<Jose> => (josePromise ??= import('jose'));

let keyResolver: { uri: string; get: JWTVerifyGetKey } | undefined;
let testResolver: JWTVerifyGetKey | undefined;

/** Test seam: verify against a local key set instead of fetching one. */
export function setKeyResolverForTests(get?: JWTVerifyGetKey): void {
  testResolver = get;
}

function resolverFor(jose: Jose, uri: string): JWTVerifyGetKey {
  if (testResolver) return testResolver;
  // One remote set per URI: jose caches keys and rate-limits refetches on an
  // unknown `kid`, but only when the instance is reused.
  if (!keyResolver || keyResolver.uri !== uri) {
    keyResolver = { uri, get: jose.createRemoteJWKSet(new URL(uri), { cooldownDuration: 30_000, timeoutDuration: 5_000 }) };
  }
  return keyResolver.get;
}

function scopesFrom(payload: JWTPayload, audience: string): Set<Scope> {
  const access = payload.resource_access;
  if (!access || typeof access !== 'object' || !Object.prototype.hasOwnProperty.call(access, audience)) {
    return new Set();
  }
  const roles = (access as Record<string, { roles?: unknown }>)[audience]?.roles;
  return new Set(Array.isArray(roles) ? roles.filter(isScope) : []);
}

/** A key-set fetch that failed (Keycloak down or slow) — not a bad token. */
function keySetUnavailable(jose: Jose, err: unknown): boolean {
  if (err instanceof jose.errors.JWKSTimeout) return true;
  if (!(err instanceof jose.errors.JOSEError)) return true; // fetch/network errors
  // jose reports a non-200 key-set response with the base JOSEError class.
  return Object.getPrototypeOf(err) === jose.errors.JOSEError.prototype;
}

export async function verifyBearer(token: string, cfg: BearerConfig): Promise<BearerResult> {
  const jose = await loadJose();
  let payload: JWTPayload;
  try {
    ({ payload } = await jose.jwtVerify(token, resolverFor(jose, cfg.jwksUri), {
      issuer: cfg.issuer,
      audience: cfg.audience,
      algorithms: ['RS256', 'PS256', 'ES256'],
      clockTolerance: 30,
    }));
  } catch (err) {
    if (err instanceof jose.errors.JWTExpired) return { ok: false, status: 401, error: 'Token expired' };
    if (keySetUnavailable(jose, err)) return { ok: false, status: 503, error: 'Auth service unavailable' };
    return { ok: false, status: 401, error: 'Token invalid' };
  }
  // Access tokens only: Keycloak marks them typ=Bearer.
  if (typeof payload.typ === 'string' && payload.typ !== 'Bearer') {
    return { ok: false, status: 401, error: 'Token invalid' };
  }
  const azp = typeof payload.azp === 'string' ? payload.azp : undefined;
  if (!azp || !cfg.allowedAzp.has(azp)) return { ok: false, status: 401, error: 'Token client not accepted' };
  // Service-account (client_credentials) tokens carry client_id; a person's token
  // is identified by client and subject.
  const id = typeof payload.client_id === 'string' ? azp : `${azp}:${payload.sub ?? 'unknown'}`;
  return { ok: true, principal: { kind: 'bearer', id, scopes: scopesFrom(payload, cfg.audience) } };
}
```

If `tsc` reports TS1479 or TS1541 on `typeof import('jose')` or on the `import type` line, switch both to the resolution-mode form and keep everything else unchanged:

```ts
import type { JWTPayload, JWTVerifyGetKey } from 'jose' with { 'resolution-mode': 'import' };
type Jose = typeof import('jose', { with: { 'resolution-mode': 'import' } });
```

Never replace the dynamic `import('jose')` with a static import.

`src/lib/boot-config.ts`: add `bearerConfig(env);` to `validateBootConfig`, importing from `./auth/bearer`.

- [ ] **Step 5: Run the tests.**
Run: `pnpm vitest run src/lib/auth` then `pnpm build` then `node -e "require('./dist/lib/auth/bearer.js').bearerConfig({NS_KEYCLOAK_ISSUER:'https://x/auth/realms/r',NS_AUTH_ALLOWED_AZP:'a'})"`
Expected: PASS, a clean build, and the `node -e` call prints nothing and does not throw. That last check proves the compiled CommonJS output loads without a static `require('jose')`.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/lib/auth src/lib/boot-config.ts
git commit -m "feat(auth): verify Keycloak bearer tokens (audience, azp allowlist, client roles)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The auth boundary — raw body, `authenticate()`, route wiring, docs gating

**Files:**
- Create: `src/plugins/raw-body.ts`, `src/plugins/auth.ts`, `src/types/fastify-auth.ts`, `src/plugins/__tests__/auth.test.ts`
- Delete: `src/plugins/request-auth.ts`, `src/plugins/require-admin.ts`, `src/plugins/__tests__/request-auth.test.ts`, `src/plugins/__tests__/require-admin.test.ts`
- Modify:
  - `src/app.ts`
  - `src/routes/{notify,v1-notify,admin-templates,admin-policies,retry,providers,metrics,docs}.ts`
  - `src/lib/auth/secrets.ts` (drop `getSecret`)
  - every route test that mocks `../../plugins/request-auth` or `../../plugins/require-admin`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces:
  - `registerRawJsonBody(app: FastifyInstance): void`
  - `authenticate(opts: { scope: Scope | 'any'; legacyHmacV1?: boolean }): preHandlerAsyncHookHandler`
  - `req.principal: Principal`, set on success
  - `req.rawBody?: Buffer`
  - `docsEnabled(env?): boolean`

Status and body contract (bodies are `{ error: string }`):

| Condition | Status | `error` |
|---|---|---|
| Both `Authorization` and any `X-NS-*` header | 401 | `Ambiguous credentials` |
| `Authorization` not `Bearer <token>` | 401 | `Malformed authorization header` |
| Bearer sent, bearer auth off (no issuer) | 401 | `Bearer auth not enabled` |
| Bearer verify failure | 401/503 | from `verifyBearer` |
| HMAC header missing | 401 | `Missing auth headers` |
| Unknown key id | 401 | `Invalid key` |
| Timestamp outside ±30 s or not a number | 401 | `Request expired` |
| Malformed signature header | 401 | `Invalid signature` |
| `v1` where not allowed | 401 | `Signature version not accepted` |
| MAC mismatch | 401 | `Invalid signature` |
| Nonce already seen (checked after the MAC) | 401 | `Replay detected` |
| Authenticated, scope missing | 403 | `Insufficient scope` (+ `required: <scope>`) |

Route scopes:

| Route | Options |
|---|---|
| `POST /notify` | `{ scope: 'notify:send', legacyHmacV1: true }` |
| `POST /v1/notify` | `{ scope: 'notify:send' }` |
| every `/v1/admin/templates*`, `/v1/admin/policies*` | `{ scope: 'templates:admin' }` |
| `POST /failed/retry` | `{ scope: 'templates:admin' }` (Ruling D2) |
| `GET /providers`, `GET /providers/:name`, `GET /metrics/queue` | `{ scope: 'any' }` |
| `GET /`, `GET /openapi.json` | registered only when `NS_DOCS_ENABLED=true` |
| `GET /metrics` | unchanged, unauthenticated |

- [ ] **Step 1: Write the failing tests**

`src/plugins/__tests__/auth.test.ts` builds a small Fastify app with `registerRawJsonBody` and three routes. It mocks Redis with the fake and the bearer module with a controllable double:

```ts
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/redis', async () => {
  const { RedisFake } = await import('../../lib/__tests__/redis-fake');
  return { default: new RedisFake() };
});
const bearer = vi.hoisted(() => ({
  bearerConfig: vi.fn(() => ({ issuer: 'i', jwksUri: 'https://i/c', audience: 'notification-service', allowedAzp: new Set(['signals-api']) })),
  verifyBearer: vi.fn(),
}));
vi.mock('../../lib/auth/bearer', () => bearer);

const { loadSecrets } = await import('../../lib/auth/secrets');
const { registerRawJsonBody } = await import('../raw-body');
const { authenticate } = await import('../auth');
const { signHmac, canonicalString } = await import('../../lib/auth/hmac');

beforeAll(() => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ns-auth-')), 'secrets.json');
  fs.writeFileSync(file, JSON.stringify({
    sender: { secret: 'send-secret' },
    admin: { secret: 'admin-secret', scopes: ['notify:send', 'templates:admin'] },
  }));
  process.env.INTERNAL_SECRETS_JSON = file;
  loadSecrets();
});

function build() {
  const app = Fastify();
  registerRawJsonBody(app);
  const echo = async (req: any) => ({ principal: { kind: req.principal.kind, id: req.principal.id } });
  app.post('/notify', { preHandler: authenticate({ scope: 'notify:send', legacyHmacV1: true }), bodyLimit: 8 * 1024 * 1024 }, echo);
  app.post('/v1/notify', { preHandler: authenticate({ scope: 'notify:send' }) }, echo);
  app.post('/v1/admin/templates', { preHandler: authenticate({ scope: 'templates:admin' }) }, echo);
  app.get('/providers', { preHandler: authenticate({ scope: 'any' }) }, echo);
  return app;
}

let n = 0;
function hmacHeaders(o: { method: string; url: string; body?: string | Buffer; key?: string; secret?: string; version?: 'v1' | 'v2'; ts?: string; nonce?: string }) {
  const ts = o.ts ?? String(Math.floor(Date.now() / 1000));
  const nonce = o.nonce ?? `nonce-${(n += 1)}`;
  const body = o.body === undefined ? undefined : Buffer.from(o.body);
  const canonical = canonicalString(o.version ?? 'v2', o.method, o.url, ts, nonce, body);
  return {
    'x-ns-key': o.key ?? 'sender',
    'x-ns-timestamp': ts,
    'x-ns-nonce': nonce,
    'x-ns-signature': signHmac(o.version ?? 'v2', o.secret ?? 'send-secret', canonical),
  };
}

const json = { 'content-type': 'application/json' };

describe('authenticate — HMAC', () => {
  it('accepts a v2 signature over the exact body', async () => {
    const body = '{"a":1}';
    const res = await build().inject({ method: 'POST', url: '/v1/notify', payload: body, headers: { ...json, ...hmacHeaders({ method: 'POST', url: '/v1/notify', body }) } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ principal: { kind: 'hmac', id: 'sender' } });
  });

  it('rejects a re-serialised body (signed compact, sent pretty)', async () => {
    const signed = '{"a":1}';
    const res = await build().inject({ method: 'POST', url: '/v1/notify', payload: '{ "a": 1 }', headers: { ...json, ...hmacHeaders({ method: 'POST', url: '/v1/notify', body: signed }) } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Invalid signature' });
  });

  it('verifies a non-ASCII body signed over its UTF-8 bytes, with a charset content type', async () => {
    const body = '{"name":"अनिकेत","note":"naïve ✓"}';
    const res = await build().inject({ method: 'POST', url: '/v1/notify', payload: body, headers: { 'content-type': 'application/json; charset=utf-8', ...hmacHeaders({ method: 'POST', url: '/v1/notify', body }) } });
    expect(res.statusCode).toBe(200);
  });

  it('signs the query string as part of the path, and an empty body on GET', async () => {
    const url = '/providers?channel=sms';
    const res = await build().inject({ method: 'GET', url, headers: hmacHeaders({ method: 'GET', url }) });
    expect(res.statusCode).toBe(200);
  });

  it('verifies a large body (attachment-sized)', async () => {
    const body = JSON.stringify({ data: 'x'.repeat(6 * 1024 * 1024) });
    const res = await build().inject({ method: 'POST', url: '/notify', payload: body, headers: { ...json, ...hmacHeaders({ method: 'POST', url: '/notify', body }) } });
    expect(res.statusCode).toBe(200);
  });

  it('accepts v1 only on legacy /notify', async () => {
    const legacy = await build().inject({ method: 'POST', url: '/notify', payload: '{}', headers: { ...json, ...hmacHeaders({ method: 'POST', url: '/notify', version: 'v1' }) } });
    expect(legacy.statusCode).toBe(200);
    const v1 = await build().inject({ method: 'POST', url: '/v1/notify', payload: '{}', headers: { ...json, ...hmacHeaders({ method: 'POST', url: '/v1/notify', version: 'v1' }) } });
    expect(v1.statusCode).toBe(401);
    expect(v1.json()).toEqual({ error: 'Signature version not accepted' });
  });

  it('does not burn the nonce on a bad signature; a replay of a good one is rejected', async () => {
    const app = build();
    const body = '{}';
    const good = hmacHeaders({ method: 'POST', url: '/v1/notify', body, nonce: 'fixed-nonce' });
    const bad = { ...good, 'x-ns-signature': 'v2=' + '0'.repeat(64) };
    expect((await app.inject({ method: 'POST', url: '/v1/notify', payload: body, headers: { ...json, ...bad } })).json()).toEqual({ error: 'Invalid signature' });
    expect((await app.inject({ method: 'POST', url: '/v1/notify', payload: body, headers: { ...json, ...good } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/notify', payload: body, headers: { ...json, ...good } })).json()).toEqual({ error: 'Replay detected' });
  });

  it.each([
    [{ 'x-ns-signature': 'v2=zz' }, 'Invalid signature'],
    [{ 'x-ns-timestamp': '1' }, 'Request expired'],
    [{ 'x-ns-timestamp': 'abc' }, 'Request expired'],
    [{ 'x-ns-key': 'nobody' }, 'Invalid key'],
    [{ 'x-ns-nonce': undefined }, 'Missing auth headers'],
  ])('rejects %j', async (over, error) => {
    const headers = { ...json, ...hmacHeaders({ method: 'POST', url: '/v1/notify', body: '{}' }), ...over } as Record<string, string>;
    for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
    const res = await build().inject({ method: 'POST', url: '/v1/notify', payload: '{}', headers });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error });
  });

  it('a sending key gets 403 on an admin route; an admin key passes', async () => {
    const body = '{}';
    const send = await build().inject({ method: 'POST', url: '/v1/admin/templates', payload: body, headers: { ...json, ...hmacHeaders({ method: 'POST', url: '/v1/admin/templates', body }) } });
    expect(send.statusCode).toBe(403);
    expect(send.json()).toEqual({ error: 'Insufficient scope', required: 'templates:admin' });
    const admin = await build().inject({ method: 'POST', url: '/v1/admin/templates', payload: body, headers: { ...json, ...hmacHeaders({ method: 'POST', url: '/v1/admin/templates', body, key: 'admin', secret: 'admin-secret' }) } });
    expect(admin.statusCode).toBe(200);
  });
});

describe('authenticate — bearer', () => {
  beforeEach(() => bearer.verifyBearer.mockReset());
  const principal = (scopes: string[]) => ({ ok: true, principal: { kind: 'bearer', id: 'signals-api', scopes: new Set(scopes) } });

  it('accepts a token holding the route scope', async () => {
    bearer.verifyBearer.mockResolvedValue(principal(['notify:send']));
    const res = await build().inject({ method: 'POST', url: '/v1/notify', payload: '{}', headers: { ...json, authorization: 'Bearer abc' } });
    expect(res.statusCode).toBe(200);
    expect(bearer.verifyBearer).toHaveBeenCalledWith('abc', expect.objectContaining({ audience: 'notification-service' }));
  });

  it('a token without an NS role gets 403 on every scoped route, and passes `any`', async () => {
    bearer.verifyBearer.mockResolvedValue(principal([]));
    expect((await build().inject({ method: 'POST', url: '/v1/notify', payload: '{}', headers: { ...json, authorization: 'Bearer abc' } })).statusCode).toBe(403);
    expect((await build().inject({ method: 'POST', url: '/v1/admin/templates', payload: '{}', headers: { ...json, authorization: 'Bearer abc' } })).statusCode).toBe(403);
    expect((await build().inject({ method: 'GET', url: '/providers', headers: { authorization: 'Bearer abc' } })).statusCode).toBe(200);
  });

  it('passes verifier failures through (401 and 503)', async () => {
    bearer.verifyBearer.mockResolvedValueOnce({ ok: false, status: 503, error: 'Auth service unavailable' });
    const res = await build().inject({ method: 'GET', url: '/providers', headers: { authorization: 'Bearer abc' } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'Auth service unavailable' });
  });

  it.each([
    [{ authorization: 'Basic abc' }, 'Malformed authorization header'],
    [{ authorization: 'Bearer' }, 'Malformed authorization header'],
  ])('rejects %j', async (headers, error) => {
    const res = await build().inject({ method: 'GET', url: '/providers', headers });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error });
  });

  it('rejects bearer when bearer auth is off', async () => {
    bearer.bearerConfig.mockReturnValueOnce(null as never);
    const res = await build().inject({ method: 'GET', url: '/providers', headers: { authorization: 'Bearer abc' } });
    expect(res.json()).toEqual({ error: 'Bearer auth not enabled' });
  });

  it('rejects a request carrying both credential types', async () => {
    const res = await build().inject({ method: 'GET', url: '/providers', headers: { authorization: 'Bearer abc', ...hmacHeaders({ method: 'GET', url: '/providers' }) } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Ambiguous credentials' });
    expect(bearer.verifyBearer).not.toHaveBeenCalled();
  });
});
```

Also add a docs test, `src/routes/__tests__/docs.test.ts`. With `NS_DOCS_ENABLED` unset, `GET /openapi.json` and `GET /` → 404. With `NS_DOCS_ENABLED=true` → 200. Register `docsRoutes` in a fresh Fastify instance per case.

- [ ] **Step 2: Run the tests and confirm they fail.**
Run: `pnpm vitest run src/plugins src/routes/__tests__/docs.test.ts`
Expected: FAIL, because `../raw-body`, `../auth` and the docs gating do not exist yet.

- [ ] **Step 3: Implement**

`src/types/fastify-auth.ts`:

```ts
import type { Principal } from '../lib/auth/principal';

declare module 'fastify' {
  interface FastifyRequest {
    /** Exact request bytes for application/json bodies (HMAC v2 digests these). */
    rawBody?: Buffer;
    /** Set by `authenticate` once a credential has been verified. */
    principal?: Principal;
  }
}

export {};
```

`src/plugins/raw-body.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import '../types/fastify-auth';

/**
 * Replace the JSON parser with one that keeps the raw bytes on `req.rawBody`
 * (HMAC v2 signs them) and then parses with Fastify's own JSON parser, so
 * prototype-poisoning handling and per-route body limits are unchanged.
 */
export function registerRawJsonBody(app: FastifyInstance): void {
  const parseJson = app.getDefaultJsonParser('error', 'ignore');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body as Buffer;
    parseJson(req, (body as Buffer).toString('utf8'), done);
  });
}
```

`src/plugins/auth.ts`:

```ts
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import redis from '../lib/redis';
import { bearerConfig, verifyBearer } from '../lib/auth/bearer';
import { canonicalString, macMatches, MAX_SKEW_SECONDS, NONCE_TTL_SECONDS, parseSignature } from '../lib/auth/hmac';
import type { Principal, Scope } from '../lib/auth/principal';
import { getKey } from '../lib/auth/secrets';
import '../types/fastify-auth';

export interface AuthOptions {
  /** Scope the route requires; 'any' accepts every authenticated principal. */
  scope: Scope | 'any';
  /** Accept HMAC v1 (no body digest). Legacy POST /notify only, until the cutover release removes it. */
  legacyHmacV1?: boolean;
}

const HMAC_HEADERS = ['x-ns-key', 'x-ns-timestamp', 'x-ns-nonce', 'x-ns-signature'] as const;
const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]+)$/;

type Outcome = { principal: Principal } | { status: number; error: string };

async function fromBearer(header: string): Promise<Outcome> {
  const m = BEARER.exec(header.trim());
  if (!m) return { status: 401, error: 'Malformed authorization header' };
  const cfg = bearerConfig();
  if (!cfg) return { status: 401, error: 'Bearer auth not enabled' };
  const res = await verifyBearer(m[1], cfg);
  return res.ok ? { principal: res.principal } : { status: res.status, error: res.error };
}

async function fromHmac(req: FastifyRequest, opts: AuthOptions): Promise<Outcome> {
  const [keyId, ts, nonce, sig] = HMAC_HEADERS.map((h) => req.headers[h]);
  if (typeof keyId !== 'string' || typeof ts !== 'string' || typeof nonce !== 'string' || typeof sig !== 'string' || !keyId || !ts || !nonce || !sig) {
    return { status: 401, error: 'Missing auth headers' };
  }
  const key = getKey(keyId);
  if (!key) return { status: 401, error: 'Invalid key' };

  const timestamp = Number(ts);
  if (!Number.isFinite(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > MAX_SKEW_SECONDS) {
    return { status: 401, error: 'Request expired' };
  }

  const parsed = parseSignature(sig);
  if (!parsed) return { status: 401, error: 'Invalid signature' };
  if (parsed.version === 'v1' && !opts.legacyHmacV1) return { status: 401, error: 'Signature version not accepted' };

  const canonical = canonicalString(parsed.version, req.method, req.url, ts, nonce, req.rawBody);
  if (!macMatches(key.secret, canonical, parsed.mac)) return { status: 401, error: 'Invalid signature' };

  // Nonce last: only a correctly signed request may claim one, so 'Replay
  // detected' always means a valid request seen twice.
  const claimed = await redis.set(`nonce:${keyId}:${nonce}`, '1', 'EX', NONCE_TTL_SECONDS, 'NX');
  if (!claimed) return { status: 401, error: 'Replay detected' };

  return { principal: { kind: 'hmac', id: keyId, scopes: key.scopes } };
}

/**
 * The single auth boundary. A request carries EITHER a Keycloak bearer token OR
 * an HMAC signature; both at once is refused. On success `req.principal` is set
 * and the route's scope is enforced.
 */
export function authenticate(opts: AuthOptions): preHandlerAsyncHookHandler {
  return async function auth(req: FastifyRequest, reply: FastifyReply) {
    const authorization = req.headers.authorization;
    const hasHmac = HMAC_HEADERS.some((h) => req.headers[h] !== undefined);
    if (authorization !== undefined && hasHmac) {
      return reply.code(401).send({ error: 'Ambiguous credentials' });
    }
    const outcome = authorization !== undefined ? await fromBearer(authorization) : await fromHmac(req, opts);
    if ('error' in outcome) return reply.code(outcome.status).send({ error: outcome.error });

    if (opts.scope !== 'any' && !outcome.principal.scopes.has(opts.scope)) {
      return reply.code(403).send({ error: 'Insufficient scope', required: opts.scope });
    }
    req.principal = outcome.principal;
  };
}
```

`src/routes/docs.ts`: export `docsEnabled(env = process.env) => env.NS_DOCS_ENABLED === 'true'`. Wrap both route registrations in `if (!docsEnabled()) return;`. Add a comment: schema and reference pages are a development aid and are off in deployed environments unless explicitly enabled.

`src/app.ts`: call `registerRawJsonBody(app);` immediately after `Fastify(...)`, before any `app.register`.

Route wiring follows the Route scopes table above:
- Replace each `requestAuth` and `[requestAuth, requireAdmin]` preHandler with the matching `authenticate(...)`.
- Replace every `req.headers['x-ns-key']`-derived source or actor with `principalLabel(req.principal)`: `v1-notify.ts` `source`, `notify.ts` `source`, and the admin routes' `actorOf`.
  - In the admin route files, delete `actorOf` and use `principalLabel(req.principal)` at each call site.
  - Audit `source` values change format to `hmac:<keyId>` / `bearer:<id>`. That is intended; note it in CLAUDE.md.
- Delete `src/plugins/request-auth.ts`, `src/plugins/require-admin.ts` and their tests. `auth.test.ts` now covers every case those tests covered: signature-before-nonce, replay, skew, missing headers, unknown key, and admin separation.
- Remove `getSecret` from `secrets.ts`.

Update route tests:
- Every route test that does `vi.mock('../../plugins/request-auth', ...)` or mocks `require-admin` now mocks `../../plugins/auth`:

  ```ts
  vi.mock('../../plugins/auth', () => ({
    authenticate: () => async (req: any) => {
      req.principal = { kind: 'hmac', id: 'test-key', scopes: new Set(['notify:send', 'templates:admin']) };
    },
  }));
  ```
- Where a test asserted `created_by`, `published_by` or `source` from the `x-ns-key` header, it now expects `'hmac:test-key'`.
- Find them with `grep -rln "plugins/request-auth\|plugins/require-admin" src`. That covers at least `admin-templates.test.ts`, `admin-policies.test.ts`, `notify.test.ts`, `v1-notify.test.ts` and `v1-notify.integration.test.ts`.

`src/lib/boot-config.ts`: no change beyond Task 2. `docsEnabled` cannot be invalid.

- [ ] **Step 4: Run the tests.**
Run: `pnpm build` then `pnpm test`. Then run the integration suite as global-constraints describes: `pnpm test:integration` against the Postgres and Redis containers, which are removed afterwards.
Expected: everything passes, and `grep -rn "x-ns-key" src --include=*.ts | grep -v __tests__` prints only `src/plugins/auth.ts`.

- [ ] **Step 5: Commit**

```bash
git add -A src
git commit -m "feat(auth): one auth boundary for bearer tokens and HMAC v2, with send and admin scopes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: OpenAPI security schemes and documentation

**Files:**
- Modify: `src/lib/utils/openapi.ts`, `src/lib/utils/__tests__/openapi.test.ts`, `CLAUDE.md`, `README.md`, `example.env`

**Interfaces:**
- Consumes: the route scope table (Task 3).

- [ ] **Step 1: Write the failing test.** In `openapi.test.ts`, assert the following:
  - `components.securitySchemes` has `bearerAuth` `{ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }`.
  - It has `requestSignature`, whose description names `v2` and the canonical string `METHOD\npath\ntimestamp\nnonce\nsha256(body)`.
  - The `adminKey` scheme is gone.
  - `POST /v1/notify` has `security: [{ requestSignature: [] }, { bearerAuth: ['notify:send'] }]`.
  - Every `/v1/admin/*` operation and `POST /failed/retry` have `security: [{ requestSignature: [] }, { bearerAuth: ['templates:admin'] }]`.
  - Role names inside a non-OAuth security requirement are valid only in OpenAPI 3.1. Read the document's `openapi` version first. If it is 3.0.x, use empty arrays (`{ bearerAuth: [] }`), state the required role in each operation's `description`, and assert that instead.
  - Every authenticated operation lists a `401` response; every scoped operation lists `403`.
  - `POST /v1/notify` lists `503`. That already includes the auth-unavailable case; add it to the response description.
  - Update the earlier `/v1/notify` security assertion to the new shape.

- [ ] **Step 2: Run the test and confirm it fails.** Run: `pnpm vitest run src/lib/utils`
Expected: FAIL, because the security schemes have not changed yet.

- [ ] **Step 3: Implement.**
  - **openapi.ts:** replace `adminSecurity` and each `security: [{ requestSignature: [] }]` with `sendSecurity`, `adminSecurity` or `anySecurity` constants built from the scheme names above.
  - **Scheme description.** Set the `requestSignature` description to:
    - the `v2` header set (`X-NS-Key`, `X-NS-Timestamp`, `X-NS-Nonce`, `X-NS-Signature: v2=<hex>`)
    - the canonical string, and that the digest is over the exact body bytes
    - that `v1` is accepted only on legacy `/notify` until the cutover release
    - how scopes come from the key's `scopes` entry
  - **Response codes.** Add `401` to every authenticated operation and `403` to every scoped one, using the `{ error }` body shape.
  - **CLAUDE.md:** replace the "Request Signing (Authentication)" section with an **Authentication** section covering:
    - the two credential types, and that both on one request is refused
    - the full v2 canonical string and the raw-body capture (`registerRawJsonBody`), including why the JSON parser is replaced
    - signature before nonce
    - the scope table (Task 3) and Rulings D1–D3
    - the `internal-secrets.json` shape with `scopes`
    - the bearer env vars (`NS_KEYCLOAK_ISSUER` exact, no trailing slash; `NS_KEYCLOAK_JWKS_URI`; `NS_AUTH_AUDIENCE`; `NS_AUTH_ALLOWED_AZP`), 503 vs 401, and audience coming from the role grant (Ruling D4)
    - the `jose` dynamic import and why
    - `NS_DOCS_ENABLED`
    - the audit `source` / actor format `hmac:<id>` / `bearer:<id>`

    Also remove the `NS_ADMIN_KEY_IDS` mentions, update the Known Issues entry for #52 (resolved), and update test counts.
  - **README.md:** add a signing reference, a ~15-line Node example that computes the v2 headers for a JSON body. Add a short bearer section (which roles, which env) and update the env table.
  - **example.env:** remove `NS_ADMIN_KEY_IDS`. Add `NS_KEYCLOAK_ISSUER=`, `NS_KEYCLOAK_JWKS_URI=`, `NS_AUTH_AUDIENCE=notification-service`, `NS_AUTH_ALLOWED_AZP=` and `NS_DOCS_ENABLED=true` (the local-dev value), each with a one-line comment.

- [ ] **Step 4: Run the tests.** Run: `pnpm build && pnpm test`
Expected: everything passes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/utils CLAUDE.md README.md example.env
git commit -m "docs(auth): bearer and HMAC v2 security schemes, signing reference

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Keycloak realm — the `notification-service` client and its roles (aggregator-dpg)

**Files:**
- Modify: `aggregator-dpg/infra/keycloak/realms/realm.json`, in worktree `.worktrees/ns-plan-d/aggregator-dpg` on branch `feat/ns-keycloak-client` off `origin/feature`.

**Interfaces:**
- Produces for Task 6:
  - client `notification-service` (`bearerOnly: true`) with client roles `notify:send` and `templates:admin`
  - `service-account-signals-api` granted `notification-service: ["notify:send"]`

Read `aggregator-dpg/CLAUDE.md` and `.claude/rules/` first. This task only edits realm JSON.

- [ ] **Step 1: Write the failing check.** Add `infra/keycloak/realms/check-ns-client.sh`. It must be executable and use `jq`, and it exits non-zero when any assertion fails:

```bash
#!/usr/bin/env bash
# Asserts the notification-service resource-server client, its roles, and the
# signals-api grant are present in the local realm.
set -euo pipefail
R="${1:-$(dirname "$0")/realm.json}"
jq -e '.clients[] | select(.clientId=="notification-service") | .bearerOnly == true and .standardFlowEnabled == false and .serviceAccountsEnabled == false and .directAccessGrantsEnabled == false and (has("secret") | not)' "$R" >/dev/null
jq -e '[.roles.client["notification-service"][].name] | sort == ["notify:send","templates:admin"]' "$R" >/dev/null
jq -e '.users[] | select(.username=="service-account-signals-api") | .clientRoles["notification-service"] == ["notify:send"]' "$R" >/dev/null
echo "notification-service client: ok"
```

Run: `bash infra/keycloak/realms/check-ns-client.sh`
Expected: FAIL (non-zero exit), because the client does not exist yet.

- [ ] **Step 2: Edit `realm.json`.**
  - Append the client to `.clients`, after `campaign-manager`:

```json
{
  "clientId": "notification-service",
  "name": "Notification service (resource server)",
  "description": "Resource server only: never logs in. A caller is authorised by being granted one of this client's roles; Keycloak's audience-resolve mapper (default roles scope) then adds aud=notification-service to its tokens.",
  "enabled": true,
  "bearerOnly": true,
  "publicClient": false,
  "standardFlowEnabled": false,
  "implicitFlowEnabled": false,
  "directAccessGrantsEnabled": false,
  "serviceAccountsEnabled": false,
  "protocolMappers": []
}
```

  - Add the roles under `.roles.client`, creating the `client` object if it is absent:

```json
"client": {
  "notification-service": [
    { "name": "notify:send", "description": "Send notifications through POST /v1/notify.", "composite": false, "clientRole": true },
    { "name": "templates:admin", "description": "Administer notification templates and routing policies; replay the dead-letter queue.", "composite": false, "clientRole": true }
  ]
}
```

  - Add `"notification-service": ["notify:send"]` to `service-account-signals-api`'s `clientRoles`.
  - Keep the file's existing 2-space formatting. Check that `jq . realm.json` parses.

- [ ] **Step 3: Verify the token shape against a real Keycloak.**
  - Use the repo's local stack (`docker compose` service for Keycloak in `infra/`; read `infra/README*` or the compose file for the exact command and the local `signals-api` secret). Start Keycloak with this realm, then:

```bash
TOKEN=$(curl -s -d grant_type=client_credentials -d client_id=signals-api -d client_secret="$SIGNALS_API_SECRET" \
  "http://localhost:<kc-port>/auth/realms/<realm>/protocol/openid-connect/token" | jq -r .access_token)
echo "$TOKEN" | cut -d. -f2 | tr '_-' '/+' | base64 -d 2>/dev/null | jq '{aud, azp, typ, ns: .resource_access["notification-service"]}'
```

  - **Expected:** `aud` includes `"notification-service"`, `azp` is `"signals-api"`, `typ` is `"Bearer"`, and `ns.roles` is `["notify:send"]`. This proves Ruling D4.
  - **If `aud` lacks `notification-service`,** the realm's default client scopes do not include `roles`. In that case, add an `oidc-audience-mapper` (`included.client.audience: notification-service`, access token only) to `signals-api`'s `protocolMappers`, re-verify, and record the deviation in the report. Task 6 then needs `apply-realm-config.py` to add missing mappers to existing clients as well.
  - **If the local stack cannot start,** record that in the report and rely on Step 1's structural check. The token check then moves to Task 6's verification.

- [ ] **Step 4: Run the check.** Run: `bash infra/keycloak/realms/check-ns-client.sh`
Expected: prints `notification-service client: ok`.

- [ ] **Step 5: Commit**

```bash
git add infra/keycloak/realms/realm.json infra/keycloak/realms/check-ns-client.sh
git commit -m "feat(keycloak): notification-service resource-server client and roles; signals-api may send

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Deploy wiring — realm rebuild, role-grant reconcile, NS chart env (bluedots-automation)

**Files** (worktree `.worktrees/ns-plan-d/bluedots-automation`, branch `feat/ns-service-auth` off `origin/feat/ns-network-config`):
- Modify:
  - `helm/keycloak/charts/keycloak/files/realm.json` (rebuilt)
  - `helm/keycloak/files/apply-realm-config.py`
  - `scripts/assert-realm.sh`
  - `helm/signals/charts/notification-service/values.yaml` and its env/configmap template
  - `helm/CLAUDE.md`

**Interfaces:**
- Consumes: Task 5's `realm.json`. Pass its path from the aggregator-dpg worktree to `build-realm.sh`.

Read `bluedots-automation/CLAUDE.md` and `helm/CLAUDE.md` first.

- [ ] **Step 1: Write the failing check.** In `scripts/assert-realm.sh`, add the same three assertions as Task 5's `check-ns-client.sh`, following that script's existing assertion style. Run `scripts/assert-realm.sh helm/keycloak/charts/keycloak/files/realm.json`.
Expected: FAIL on the notification-service assertions.

- [ ] **Step 2: Rebuild the deployment realm.**
Run: `scripts/build-realm.sh ../../.worktrees/ns-plan-d/aggregator-dpg/infra/keycloak/realms/realm.json`, adjusting the relative path to the worktree, then `scripts/assert-realm.sh`.
Expected: the assertions pass. Check that `git diff --stat` shows only the realm file changing within `helm/keycloak`.

- [ ] **Step 3: Reconcile role grants for any client in `apply-realm-config.py`.**
  - **The gap.** Today the script grants only `realm-management` roles to service-account users, and `partialImport` must create the new client's roles.
  - **Check what `partialImport` sends.** Read the script. If the payload omits `.roles.client`, include the realm JSON's `roles.client` in the partialImport body. Keep `ifResourceExists: SKIP`.
  - **Generalise the grant step.** For each `.users[]` entry with `serviceAccountClientId`, and for each `<clientId>: [roles]` in its `clientRoles`, grant every missing role:
    1. Resolve the target client's UUID with `GET /admin/realms/{realm}/clients?clientId=<clientId>`.
    2. Read its roles with `GET .../clients/{uuid}/roles/{name}`.
    3. Read what the user already has with `GET .../users/{saUserId}/role-mappings/clients/{uuid}`.
    4. POST only the missing ones.
  - **Keep the existing `realm-management` behaviour identical.** It becomes one instance of the general loop.
  - **Fail loudly.** Exit non-zero if a referenced client or role does not exist after the import.
  - **Update the module docstring.** Section 2 now covers grants of any client's roles.
  - **If Task 5 had to add an audience mapper to `signals-api`,** also add a third reconcile step. For each client in the realm JSON, add any `protocolMappers` entry (matched by `name`) missing from the live client, via `POST .../clients/{uuid}/protocol-mappers/models`. Never modify or delete existing mappers.

  Verify against a throwaway Keycloak; there are no unit tests for this script:

```bash
docker run -d --name kc-d -p 18080:8080 -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:<version from helm/keycloak values> start-dev --http-relative-path=/auth
# 1. Import the PREVIOUS realm (git show HEAD:helm/keycloak/charts/keycloak/files/realm.json, placeholders replaced) to model an existing cluster.
# 2. Run the script against it with RENDERED_REALM pointing at the NEW realm (placeholders replaced with dummy values).
KC_URL=http://localhost:18080/auth KC_REALM=<realm> KC_ADMIN_USERNAME=admin KC_ADMIN_PASSWORD=admin RENDERED_REALM=/tmp/new-realm.json \
  python3 helm/keycloak/files/apply-realm-config.py
# 3. Run it a second time: it must be a no-op and exit 0.
# 4. Mint a signals-api client_credentials token and decode it as in Task 5 Step 3: aud includes notification-service, roles ["notify:send"].
docker rm -f kc-d
```

  Expected: the first run creates the client and roles and grants the role; the second run changes nothing; the token has the audience and role. Record the exact commands and output in the report.

- [ ] **Step 4: Set the NS chart env.**
  - In `helm/signals/charts/notification-service/values.yaml`:
    - **Remove `NS_ADMIN_KEY_IDS`.**
    - **Add `NS_DOCS_ENABLED: "false"`** and `NS_AUTH_ALLOWED_AZP: "signals-api"`, with a comment: add `aggregator-dpg` in Stage 2.
  - **Derive `NS_KEYCLOAK_ISSUER` and `NS_KEYCLOAK_JWKS_URI` in the chart template, not as free values.** Use the same resolution chain as the Signals api configmap (`helm/signals/charts/api/templates/configmap.yaml`): realm from `.Values.keycloak.realm`, then `global.keycloak.realm`, then `global.keycloakRealm`. Public base from `.Values.keycloak.publicBaseUrl`, then `global.keycloak.publicBaseUrl`. Internal base from `internalBaseUrl` likewise.
    - `NS_KEYCLOAK_ISSUER = <publicBase>/realms/<realm>`
    - `NS_KEYCLOAK_JWKS_URI = <internalBase>/realms/<realm>/protocol/openid-connect/certs`
  - **If the realm or public base does not resolve, emit neither.** Bearer auth stays off and NS keeps serving HMAC callers. Do not fail the render; this differs from Signals, where Keycloak is mandatory.
  - **Wire `NS_KEYCLOAK_ISSUER` and `NS_KEYCLOAK_JWKS_URI` into the NS deployment env** in the same way the existing NS env is rendered.
  - **Check the rendered output.** Run `helm template` for the NS chart, or the umbrella, with a values file that sets `global.keycloak.realm` and `publicBaseUrl`, and confirm both variables render. Then run it with neither set, and confirm both are absent.
  - **Update `helm/CLAUDE.md`.** Replace the `NS_ADMIN_KEY_IDS` sentence: to grant template/policy admin to an HMAC caller, give its `internal-secrets.json` entry `"scopes": ["notify:send", "templates:admin"]`. Bearer callers need a `notification-service` client role in the realm and their client id in `NS_AUTH_ALLOWED_AZP`.

- [ ] **Step 5: Run the repo's own checks.** These are whatever its CI runs for helm and scripts: `helm lint` on the touched charts, `shellcheck scripts/assert-realm.sh`, and `python3 -m py_compile helm/keycloak/files/apply-realm-config.py`.
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add helm scripts
git commit -m "feat(ns): Keycloak client roles for notification-service; bearer auth env; reconcile any client's role grants

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Done when

- **Green builds.** In notification-service, `pnpm build`, `pnpm test` and `pnpm test:integration` pass. aggregator-dpg's `check-ns-client.sh` passes. bluedots-automation's `assert-realm.sh`, `helm lint` and `shellcheck` are clean.
- **Two credential types.** Every NS route except `GET /metrics` requires an HMAC `v2` signature or a bearer token. Legacy `POST /notify` also accepts `v1`. A request carrying both is refused.
- **Bearer tokens.** A token is accepted only with `aud: notification-service`, an allowlisted `azp`, and, for scoped routes, the matching client role. A Keycloak outage answers 503.
- **Scope separation.** A sending credential cannot call `/v1/admin/*` or `/failed/retry`.
- **Docs off by default.** The docs and schema endpoints are off unless `NS_DOCS_ENABLED=true`.
- **Live clusters.** On an existing cluster, `helm upgrade` creates the NS client and roles and grants `signals-api` `notify:send`, all without touching existing clients. A `signals-api` token then carries `aud: notification-service`.

## Follow-ups owned by later plans

- **Plan F (cutover).**
  - Signals sends with its `signals-api` bearer token.
  - The Keycloak OTP plugin signs HMAC `v2` against `/v1/notify`.
  - e2e signs `v2`.
  - Legacy `/notify` and the `v1` verifier (`legacyHmacV1`) are deleted together.
- **Stage 2.** Add `aggregator-dpg` to `NS_AUTH_ALLOWED_AZP` and grant its service account `notify:send`.
- **Later.** The network-admin role (signals-dpg#499) maps onto `templates:admin` once it is defined.
