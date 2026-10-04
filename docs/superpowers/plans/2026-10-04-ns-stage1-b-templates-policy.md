# NS Stage 1 · Plan B — Template Registry + Routing Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give notification-service a governed catalogue of message templates and routing policies — stored in Postgres, edited through an admin API, validated on publish — plus the resolution and rendering functions the Send API v1 (Plan C) will call.

**Architecture:** Two non-partitioned, drizzle-kit-managed tables: `template` (content + the deployment's vendor identifiers + a variable contract, versioned, `draft → active → retired`, one active per key) and `notification_policy` (`(network, domain, event_type)` → ordered channels, `first_available | all`, most-specific-wins). Each `ProviderDefinition` declares its `vendor` and whether it `renders` (`'ns' | 'provider'`); a template must match the deployment's vendor for its channel. Pure modules hold the contract validation, rendering and channel planning; repositories hold the lifecycle; thin Fastify routes expose `/v1/admin/templates` and `/v1/admin/policies` behind HMAC plus an admin key allowlist (Keycloak roles replace that in Plan D). Nothing here changes `/notify`.

**Tech Stack:** TypeScript 7 (CommonJS, `moduleResolution: Node16`), Fastify 5, Zod 4, `drizzle-orm` 0.45 / `drizzle-kit` 0.31, `pg` 8, PostgreSQL 17, vitest 4, Helm + OpenTofu (one value).

**Spec:** `docs/superpowers/specs/2026-06-26-event-platform-design.md` (rev 2026-10-04) — §Templates and routing, §Security ("Template rendering", "SMS body integrity", "The admin API"), §Auth and tenancy, §Data model, §API sketch (Admin). Issues: Blue-Dots-Economy/notification-service#57, #58. Builds on Plan A (`2026-10-04-ns-stage1-a-persistence.md`, PRs notification-service#147, bluedots-automation#260).

**Repos and branches (stacked on Plan A until its PRs merge; then rebase onto `feature`):**

| Repo | Branch | Cut from | Tasks |
| --- | --- | --- | --- |
| `bluedots-automation` | `feat/ns-network-config` | `feat/ns-postgres` | 1 |
| `notification-service` | `feat/ns-templates` | `feat/ns-persistence` | 2–11 |

## Global Constraints

- Everything in Plan A's Global Constraints still applies (CommonJS, extensionless relative imports in `src/lib`, pnpm 10, public-repo wording, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer).
- **One vendor per channel per deployment.** A template's `provider` must equal the deployment's vendor for that channel; checked at publish and again when resolving for a send. No vendor routing, no vendor field on policies.
- **Render mode is a property of the vendor**, declared on `ProviderDefinition` as `renders: 'ns' | 'provider'`: email (`smtp`) → `ns`; Pinnacle SMS → `ns`; MSG91 SMS → `provider`; Twilio WhatsApp → `provider`. No `render_mode` column.
- **Active and retired templates and policies are immutable.** Editing means creating a new draft version. Retire never deletes.
- **Exactly one active row per key**: template key = `(network, channel, template_key, locale)`; policy key = `(network, domain, event_type)` with NULL meaning "any". Enforced by partial unique indexes and an advisory transaction lock on publish.
- **Network is deployment config** (`NS_NETWORK`), never request input. Template/policy code calls `currentNetwork()`, which throws `NetworkNotConfigured` when unset; admin routes answer `503`.
- **Variable contract** per template: `{ name, required, type: 'string'|'number'|'url', sensitive, raw, urlHosts? }`. Send-time variables are validated **before** any vendor call: unknown names rejected, required names present and non-empty, `url` must be `http(s)` and, when `urlHosts` is set, on an allowed host.
- **Email rendering HTML-escapes every variable by default**; `raw: true` is the explicit, reviewable opt-out. Subjects have CR/LF collapsed to a space.
- **SMS bodies are stored byte-exact.** For NS-rendered SMS (Pinnacle) the rendered length must fit `MAX_LENGTH` for its `messageType` (2000 TXT / 750 UNI) — reuse `src/lib/providers/sms/render.ts`.
- **Every `{{token}}` in a stored body must be a declared variable, and every declared variable must appear in a stored body** whenever bodies are present.
- **Admin scope is separate from send scope:** admin routes require HMAC (`requestAuth`) **and** the caller's key id in `NS_ADMIN_KEY_IDS` (comma-separated). Missing → `403 {"error":"admin scope required"}`.
- **Policy resolution precedence (most-specific-wins):** `(domain, event_type)` → `(NULL, event_type)` → `(domain, NULL)` → `(NULL, NULL)`.
- Variable `source` is caller-supplied only in this plan; `source: content_ref` (T&C content) is added by Plan E (#59) without changing the contract's other fields.
- Default locale: `NS_DEFAULT_LOCALE` (default `en`). Resolution order for a requested locale `xx-YY`: `xx-YY` → `xx` → default.

## Review Focus

- **Two admins publish two drafts of the same key at the same moment** → exactly one ends `active`, the other `retired`; never two actives and never a unique-violation 500 (Task 6, test `concurrent publishes leave exactly one active`).
- **A variable value containing `<script>` or a quote in an email template** → delivered HTML contains the escaped text; only a `raw: true` variable is inserted verbatim (Task 5, test `escapes html by default and only raw is verbatim`).
- **A `url` variable of `javascript:alert(1)` or a lookalike host (`evil-blue-dots.org` when `blue-dots.org` is allowed)** → rejected before rendering (Task 4, tests `rejects non-http schemes` and `rejects lookalike hosts`).
- **`SMS_PROVIDER` switched from msg91 to pinnacle after templates were published** → resolving an old MSG91 template for a send fails loudly with `vendor_mismatch`, never sends MSG91 ids to Pinnacle (Task 6, test `resolve refuses a template for another vendor`).
- **Publishing a policy that points at a template key with no active template** → rejected at publish with `422`, not discovered at send time (Task 8, test `publish requires an active template per channel`).

---

## Part 1 — bluedots-automation (`feat/ns-network-config`, cut from `feat/ns-postgres`)

### Task 1: Give notification-service its network and an admin key allowlist

**Files:**
- Modify: `opentofu/aws/modules/output-file/global-cloud-values.yaml.tfpl` (the `notification-service:` block added by Plan A, ~L95)
- Modify: `helm/signals/charts/notification-service/values.yaml` (`config:` defaults)
- Modify: `helm/CLAUDE.md` (the notification-service paragraph Plan A added)

**Interfaces:**
- Produces: NS container env `NS_NETWORK` (e.g. `blue_dot`, same value as signals' network) and `NS_ADMIN_KEY_IDS` (empty by default).

- [ ] **Step 1: Make the tfpl block unconditional and add `NS_NETWORK`**

Plan A emits `notification-service:` only inside `%{ if postgres_host != "" ~}`. Two separate `notification-service:` keys would be a duplicate YAML key, so restructure that block to:

```
# notification-service subchart — network identity (always) and the managed
# Postgres (RDS) endpoint (when RDS exists).
notification-service:
  config:
    NS_NETWORK: "${signals_network}"
%{ if postgres_host != "" ~}
  postgres:
    host: ${postgres_host}
%{ endif ~}
```

- [ ] **Step 2: Subchart defaults**

In `helm/signals/charts/notification-service/values.yaml`, under `config:` add:

```yaml
  # Network this deployment serves (e.g. blue_dot). Stamped on every template,
  # policy and audit row; never taken from a request. Set by opentofu.
  NS_NETWORK: ""
  # HMAC key ids (from internal-secrets.json) allowed to call the template and
  # policy admin API. Empty = nobody. Interim until Keycloak admin roles (#62).
  NS_ADMIN_KEY_IDS: ""
```

(The ConfigMap template already drops empty values.)

- [ ] **Step 3: Verify**

Run:
```bash
helm template s helm/signals/charts/notification-service \
  --set postgres.host=db.example --set config.NS_NETWORK=blue_dot \
  --set config.NS_ADMIN_KEY_IDS=ns-admin \
  --show-only templates/configmap.yaml | grep -E 'NS_NETWORK|NS_ADMIN_KEY_IDS'
```
Expected: `NS_NETWORK: "blue_dot"` and `NS_ADMIN_KEY_IDS: "ns-admin"`.
Then render the tfpl mentally twice (with and without `postgres_host`) and confirm exactly one `notification-service:` key and valid indentation; `helm lint helm/signals/charts/notification-service` → `0 chart(s) failed`.

- [ ] **Step 4: Document and commit**

Add to the NS paragraph in `helm/CLAUDE.md`: `NS_NETWORK` comes from `signals_network`; to grant template/policy admin, add a key to the NS `internal-secrets.json` and list its id in `NS_ADMIN_KEY_IDS`.

```bash
git add opentofu/aws/modules/output-file/global-cloud-values.yaml.tfpl helm/signals/charts/notification-service/values.yaml helm/CLAUDE.md
git commit -m "feat(ns): pass the network and admin key allowlist to notification-service

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Part 2 — notification-service (`feat/ns-templates`, cut from `feat/ns-persistence`)

### Task 2: Vendor metadata, network, admin scope

**Files:**
- Modify: `src/types/provider.ts`, `src/lib/providers/email/mailer.ts`, `src/lib/providers/sms/msg91.ts`, `src/lib/providers/sms/pinnacle.ts`, `src/lib/providers/whatsapp/twilio.ts`
- Create: `src/lib/network.ts`, `src/plugins/require-admin.ts`, `src/lib/templates/vendors.ts`
- Test: `src/lib/__tests__/network.test.ts`, `src/plugins/__tests__/require-admin.test.ts`, `src/lib/templates/__tests__/vendors.test.ts`

**Interfaces:**
- Produces:
  - `ProviderDefinition.vendor: string`, `ProviderDefinition.renders: 'ns' | 'provider'`
  - `currentNetwork(env?: NodeJS.ProcessEnv): string`; `class NetworkNotConfigured extends Error`
  - `defaultLocale(env?): string` (in `network.ts`, `NS_DEFAULT_LOCALE ?? 'en'`)
  - `adminKeyIds(env?): Set<string>`; `requireAdmin(req, reply)` Fastify preHandler
  - `channelVendor(channel: string): { vendor: string; renders: 'ns' | 'provider' } | undefined` (in `vendors.ts`, reads the provider registry)

- [ ] **Step 1: Write the failing tests**

`src/lib/__tests__/network.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { currentNetwork, defaultLocale, NetworkNotConfigured } from '../network';

describe('currentNetwork', () => {
  it('returns the trimmed NS_NETWORK', () => {
    expect(currentNetwork({ NS_NETWORK: ' blue_dot ' })).toBe('blue_dot');
  });
  it('throws NetworkNotConfigured when unset or blank', () => {
    expect(() => currentNetwork({})).toThrow(NetworkNotConfigured);
    expect(() => currentNetwork({ NS_NETWORK: '  ' })).toThrow(NetworkNotConfigured);
  });
});

describe('defaultLocale', () => {
  it('defaults to en', () => {
    expect(defaultLocale({})).toBe('en');
    expect(defaultLocale({ NS_DEFAULT_LOCALE: 'hi' })).toBe('hi');
  });
});
```

`src/plugins/__tests__/require-admin.test.ts`:

```ts
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { adminKeyIds, requireAdmin } from '../require-admin';

async function app() {
  const a = Fastify({ logger: false });
  a.get('/x', { preHandler: requireAdmin }, async () => ({ ok: true }));
  await a.ready();
  return a;
}

afterEach(() => { delete process.env.NS_ADMIN_KEY_IDS; });

describe('requireAdmin', () => {
  it('parses a comma-separated allowlist', () => {
    expect([...adminKeyIds({ NS_ADMIN_KEY_IDS: ' a, b ,,c' })]).toEqual(['a', 'b', 'c']);
  });

  it('403s a key id not on the allowlist', async () => {
    process.env.NS_ADMIN_KEY_IDS = 'ns-admin';
    const res = await (await app()).inject({ method: 'GET', url: '/x', headers: { 'x-ns-key': 'dpg-api-client' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'admin scope required' });
  });

  it('403s everyone when the allowlist is empty', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/x', headers: { 'x-ns-key': 'ns-admin' } });
    expect(res.statusCode).toBe(403);
  });

  it('passes an allowlisted key id', async () => {
    process.env.NS_ADMIN_KEY_IDS = 'ns-admin';
    const res = await (await app()).inject({ method: 'GET', url: '/x', headers: { 'x-ns-key': 'ns-admin' } });
    expect(res.statusCode).toBe(200);
  });
});
```

`src/lib/templates/__tests__/vendors.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../providers', () => ({
  providers: {
    email: { name: 'email', vendor: 'smtp', renders: 'ns' },
    sms: { name: 'sms', vendor: 'msg91', renders: 'provider' },
  },
}));

import { channelVendor } from '../vendors';

describe('channelVendor', () => {
  it('returns the deployment vendor and render mode for a channel', () => {
    expect(channelVendor('sms')).toEqual({ vendor: 'msg91', renders: 'provider' });
    expect(channelVendor('email')).toEqual({ vendor: 'smtp', renders: 'ns' });
  });
  it('returns undefined for an unknown channel', () => {
    expect(channelVendor('fax')).toBeUndefined();
  });
});
```

Also add to `src/lib/providers/sms/__tests__/pinnacle.test.ts` (or the existing msg91 test file) one assertion each:

```ts
it('declares its vendor and render mode', () => {
  expect(pinnacleSmsProvider.vendor).toBe('pinnacle');
  expect(pinnacleSmsProvider.renders).toBe('ns');
});
```

and in the msg91 test file:

```ts
it('declares its vendor and render mode', () => {
  expect(smsProvider.vendor).toBe('msg91');
  expect(smsProvider.renders).toBe('provider');
});
```

(Use the import names those test files already use.)

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/lib/__tests__/network.test.ts src/plugins/__tests__/require-admin.test.ts src/lib/templates src/lib/providers/sms`
Expected: FAIL — modules not found / `vendor` undefined.

- [ ] **Step 3: Implement**

`src/types/provider.ts` — add to `ProviderDefinition` after `name`:

```ts
  /**
   * The vendor behind this channel in this deployment ('smtp', 'msg91',
   * 'pinnacle', 'twilio'). Templates are registered against a vendor — DLT and
   * Meta template ids are per vendor — so a template whose vendor differs from
   * the deployment's is refused rather than sent.
   */
  vendor: string;
  /**
   * Who turns a template into the delivered text: 'ns' renders the stored body
   * here (email, Pinnacle); 'provider' sends an approved template id plus
   * variables and the vendor renders (MSG91 Flow, Twilio Content).
   */
  renders: 'ns' | 'provider';
```

Add the two fields to each definition: `mailer.ts` → `vendor: 'smtp', renders: 'ns'`; `msg91.ts` → `vendor: 'msg91', renders: 'provider'`; `pinnacle.ts` → `vendor: 'pinnacle', renders: 'ns'`; `twilio.ts` → `vendor: 'twilio', renders: 'provider'`.

`src/lib/network.ts`:

```ts
/**
 * The network this deployment serves. Deployment configuration, never request
 * input: it is the tenancy boundary for every template, policy and audit row.
 */
export class NetworkNotConfigured extends Error {
  constructor() {
    super('NS_NETWORK is not configured');
    this.name = 'NetworkNotConfigured';
  }
}

export function currentNetwork(env: NodeJS.ProcessEnv = process.env): string {
  const network = env.NS_NETWORK?.trim();
  if (!network) throw new NetworkNotConfigured();
  return network;
}

/** Locale used when a send names none and as the last fallback. */
export function defaultLocale(env: NodeJS.ProcessEnv = process.env): string {
  return env.NS_DEFAULT_LOCALE?.trim() || 'en';
}
```

`src/plugins/require-admin.ts`:

```ts
import { FastifyReply, FastifyRequest } from 'fastify';

/**
 * HMAC key ids allowed to administer templates and policies. Separate from the
 * ability to send: editing a DLT-registered template has a compliance blast
 * radius a sending credential must not carry. Interim until Keycloak admin
 * roles (#62) replace it.
 */
export function adminKeyIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.NS_ADMIN_KEY_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Run AFTER requestAuth: the key id is only trustworthy once the signature checked out. */
export const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
  const keyId = req.headers['x-ns-key'];
  if (typeof keyId !== 'string' || !adminKeyIds().has(keyId)) {
    return reply.code(403).send({ error: 'admin scope required' });
  }
};
```

`src/lib/templates/vendors.ts`:

```ts
import { providers } from '../providers';

/** The deployment's vendor and render mode for a channel, or undefined if the channel is unknown. */
export function channelVendor(
  channel: string,
): { vendor: string; renders: 'ns' | 'provider' } | undefined {
  const p = providers[channel];
  return p ? { vendor: p.vendor, renders: p.renders } : undefined;
}
```

- [ ] **Step 4: Run the tests and the full suite**

Run: `pnpm build && pnpm test`
Expected: PASS. (Test doubles elsewhere that build provider stubs without `vendor`/`renders` still run — vitest does not type-check; leave them.)

- [ ] **Step 5: Commit**

```bash
git add src/types/provider.ts src/lib/providers src/lib/network.ts src/lib/__tests__/network.test.ts src/plugins/require-admin.ts src/plugins/__tests__/require-admin.test.ts src/lib/templates
git commit -m "feat(templates): vendor metadata, deployment network and admin scope

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: `template` and `notification_policy` tables

**Files:**
- Modify: `src/lib/db/schema.ts`
- Create (generated): `drizzle/0001_templates_and_policies.sql` + `drizzle/meta/*`
- Test: `src/lib/db/__tests__/catalogue-schema.integration.test.ts`

**Interfaces:**
- Produces (from `src/lib/db/schema.ts`):
  - `type LifecycleStatus = 'draft' | 'active' | 'retired'`
  - `interface VariableSpec { name: string; required: boolean; type: 'string' | 'number' | 'url'; sensitive: boolean; raw: boolean; urlHosts?: string[] }`
  - `interface PolicyChannel { channel: string; template_key: string }`
  - `type PolicyMode = 'first_available' | 'all'`
  - tables `template`, `notificationPolicy`; `type TemplateRow = typeof template.$inferSelect`; `type PolicyRow = typeof notificationPolicy.$inferSelect`

- [ ] **Step 1: Write the failing integration test**

`src/lib/db/__tests__/catalogue-schema.integration.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getPool } from '../client';
import { runMigrations } from '../migrate';

beforeAll(async () => { await runMigrations(); });
afterAll(async () => { await closeDb(); });
beforeEach(async () => {
  await getPool().query(`DELETE FROM template; DELETE FROM notification_policy;`);
});

const insertTemplate = (version: number, status: string) =>
  getPool().query(
    `INSERT INTO template (network, channel, template_key, locale, version, status, provider, created_by)
     VALUES ('n', 'sms', 'login_otp', 'en', $1, $2, 'msg91', 't')`,
    [version, status],
  );

const insertPolicy = (version: number, status: string, domain: string | null, eventType: string | null) =>
  getPool().query(
    `INSERT INTO notification_policy (network, domain, event_type, version, status, mode, channels, created_by)
     VALUES ('n', $3, $4, $1, $2, 'first_available', '[]'::jsonb, 't')`,
    [version, status, domain, eventType],
  );

describe('catalogue schema', () => {
  it('allows one active template per key and any number of retired', async () => {
    await insertTemplate(1, 'retired');
    await insertTemplate(2, 'active');
    await expect(insertTemplate(3, 'active')).rejects.toThrow(/template_active_uq/);
    await expect(insertTemplate(3, 'retired')).resolves.toBeDefined();
  });

  it('rejects a duplicate version and an unknown status', async () => {
    await insertTemplate(1, 'draft');
    await expect(insertTemplate(1, 'draft')).rejects.toThrow(/template_version_uq/);
    await expect(insertTemplate(9, 'live')).rejects.toThrow(/template_status_ck/);
  });

  it('treats NULL domain/event_type as one scope for the active policy', async () => {
    await insertPolicy(1, 'active', null, null);
    await expect(insertPolicy(2, 'active', null, null)).rejects.toThrow(/policy_active_uq/);
    await expect(insertPolicy(2, 'active', 'seeker', null)).resolves.toBeDefined();
  });

  it('rejects an unknown policy mode', async () => {
    await expect(
      getPool().query(
        `INSERT INTO notification_policy (network, version, status, mode, channels, created_by)
         VALUES ('n', 1, 'draft', 'broadcast', '[]'::jsonb, 't')`,
      ),
    ).rejects.toThrow(/policy_mode_ck/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run (services as in Plan A — `docker compose up -d postgres redis` or the containers from the CI step):
`DATABASE_HOST=127.0.0.1 DATABASE_NAME=notification DATABASE_USER=notification DATABASE_PASSWORD=notification pnpm test:integration`
Expected: FAIL — `relation "template" does not exist`.

- [ ] **Step 3: Schema**

Replace `src/lib/db/schema.ts` with:

```ts
import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Tables drizzle-kit manages (db:generate diffs this file).
 *
 * Partitioned tables are deliberately NOT here — drizzle-kit cannot emit
 * PARTITION BY, so their DDL lives in custom migrations and their query-side
 * definitions in ./partitioned.ts, which drizzle.config.ts does not include.
 */

export type LifecycleStatus = 'draft' | 'active' | 'retired';
export type PolicyMode = 'first_available' | 'all';

/** One entry of a template's variable contract. */
export interface VariableSpec {
  name: string;
  required: boolean;
  type: 'string' | 'number' | 'url';
  /** Redacted wherever a send comes to rest (rows, logs, dead letters). */
  sensitive: boolean;
  /** Email only: insert without HTML-escaping. An explicit, reviewable opt-out. */
  raw: boolean;
  /** url only: the value's host must equal one of these or be a subdomain of one. */
  urlHosts?: string[];
}

export interface PolicyChannel {
  channel: string;
  template_key: string;
}

const lifecycle = {
  createdBy: text('created_by').notNull(),
  publishedBy: text('published_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
};

export const template = pgTable(
  'template',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    network: text('network').notNull(),
    channel: text('channel').notNull(),
    templateKey: text('template_key').notNull(),
    locale: text('locale').notNull(),
    version: integer('version').notNull(),
    status: text('status').$type<LifecycleStatus>().notNull().default('draft'),
    subject: text('subject'),
    bodyHtml: text('body_html'),
    bodyText: text('body_text'),
    variables: jsonb('variables').$type<VariableSpec[]>().notNull().default(sql`'[]'::jsonb`),
    provider: text('provider').notNull(),
    providerTemplateId: text('provider_template_id'),
    senderId: text('sender_id'),
    dltEntityId: text('dlt_entity_id'),
    dltHeaderId: text('dlt_header_id'),
    dltTagId: text('dlt_tag_id'),
    approvalRef: text('approval_ref'),
    defaultDeadlineS: integer('default_deadline_s'),
    ...lifecycle,
  },
  (t) => [
    uniqueIndex('template_version_uq').on(t.network, t.channel, t.templateKey, t.locale, t.version),
    uniqueIndex('template_active_uq')
      .on(t.network, t.channel, t.templateKey, t.locale)
      .where(sql`${t.status} = 'active'`),
    check('template_status_ck', sql`${t.status} in ('draft', 'active', 'retired')`),
  ],
);

export const notificationPolicy = pgTable(
  'notification_policy',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    network: text('network').notNull(),
    domain: text('domain'),
    eventType: text('event_type'),
    version: integer('version').notNull(),
    status: text('status').$type<LifecycleStatus>().notNull().default('draft'),
    mode: text('mode').$type<PolicyMode>().notNull(),
    channels: jsonb('channels').$type<PolicyChannel[]>().notNull(),
    ...lifecycle,
  },
  (t) => [
    uniqueIndex('policy_version_uq').on(
      t.network,
      sql`coalesce(${t.domain}, '')`,
      sql`coalesce(${t.eventType}, '')`,
      t.version,
    ),
    uniqueIndex('policy_active_uq')
      .on(t.network, sql`coalesce(${t.domain}, '')`, sql`coalesce(${t.eventType}, '')`)
      .where(sql`${t.status} = 'active'`),
    check('policy_status_ck', sql`${t.status} in ('draft', 'active', 'retired')`),
    check('policy_mode_ck', sql`${t.mode} in ('first_available', 'all')`),
  ],
);

export type TemplateRow = typeof template.$inferSelect;
export type PolicyRow = typeof notificationPolicy.$inferSelect;
```

- [ ] **Step 4: Generate the migration**

Run: `DATABASE_HOST=127.0.0.1 DATABASE_NAME=notification DATABASE_USER=notification DATABASE_PASSWORD=notification pnpm db:generate --name=templates_and_policies`
Expected: `drizzle/0001_templates_and_policies.sql` creating both tables, both unique indexes per table (the active ones partial, the policy ones on `coalesce(...)` expressions) and the check constraints. **Do not edit it.** If drizzle-kit renders an expression index or partial `WHERE` incorrectly, fix the schema definition and regenerate.

- [ ] **Step 5: Run the test to see it pass**

Run the integration command from Step 2.
Expected: PASS (4 tests), plus all Plan A integration tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db/schema.ts drizzle src/lib/db/__tests__/catalogue-schema.integration.test.ts
git commit -m "feat(db): template and notification_policy tables

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: The variable contract

**Files:**
- Create: `src/lib/templates/errors.ts`, `src/lib/templates/contract.ts`
- Test: `src/lib/templates/__tests__/contract.test.ts`

**Interfaces:**
- Consumes: `VariableSpec` (Task 3).
- Produces:
  - `type TemplateErrorCode = 'not_found' | 'invalid_state' | 'unknown_channel' | 'vendor_mismatch' | 'incomplete_template' | 'undeclared_token' | 'unused_variable' | 'body_too_long' | 'missing_variable' | 'unknown_variable' | 'invalid_variable' | 'invalid_contract'`
  - `class TemplateError extends Error { code: TemplateErrorCode; details?: Record<string, unknown> }`
  - `VariableContractSchema: z.ZodType<VariableSpec[]>`
  - `tokensIn(...texts: (string | null | undefined)[]): Set<string>`
  - `checkTokensMatchContract(texts: (string | null | undefined)[], contract: VariableSpec[]): void`
  - `validateVariables(contract: VariableSpec[], input: Record<string, unknown>): Record<string, string>`
  - `sensitiveVariables(contract: VariableSpec[]): string[]`

- [ ] **Step 1: Write the failing tests**

`src/lib/templates/__tests__/contract.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  checkTokensMatchContract,
  sensitiveVariables,
  tokensIn,
  validateVariables,
  VariableContractSchema,
} from '../contract';
import { TemplateError } from '../errors';
import type { VariableSpec } from '../../db/schema';

const v = (over: Partial<VariableSpec> & { name: string }): VariableSpec => ({
  required: true, type: 'string', sensitive: false, raw: false, ...over,
});

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { return e instanceof TemplateError ? e.code : 'other'; }
  return undefined;
}

describe('VariableContractSchema', () => {
  it('fills defaults', () => {
    expect(VariableContractSchema.parse([{ name: 'name' }])).toEqual([
      { name: 'name', required: true, type: 'string', sensitive: false, raw: false },
    ]);
  });
  it('rejects duplicate names, bad names and urlHosts on non-url', () => {
    expect(VariableContractSchema.safeParse([{ name: 'a' }, { name: 'a' }]).success).toBe(false);
    expect(VariableContractSchema.safeParse([{ name: 'a-b' }]).success).toBe(false);
    expect(VariableContractSchema.safeParse([{ name: 'a', urlHosts: ['x.org'] }]).success).toBe(false);
  });
});

describe('tokens', () => {
  it('collects {{tokens}} across texts', () => {
    expect([...tokensIn('Hi {{name}}', null, '{{link}} and {{name}}')].sort()).toEqual(['link', 'name']);
  });
  it('rejects a token with no declared variable', () => {
    expect(code(() => checkTokensMatchContract(['Hi {{name}}'], []))).toBe('undeclared_token');
  });
  it('rejects a declared variable no body uses', () => {
    expect(code(() => checkTokensMatchContract(['Hi'], [v({ name: 'name' })]))).toBe('unused_variable');
  });
  it('accepts a matching contract', () => {
    expect(code(() => checkTokensMatchContract(['Hi {{name}}'], [v({ name: 'name' })]))).toBeUndefined();
  });
});

describe('validateVariables', () => {
  const contract = [
    v({ name: 'name' }),
    v({ name: 'count', type: 'number', required: false }),
    v({ name: 'link', type: 'url', urlHosts: ['blue-dots.org'] }),
  ];
  const ok = { name: 'Asha', link: 'https://app.blue-dots.org/x' };

  it('normalises values to strings and omits absent optionals', () => {
    expect(validateVariables(contract, { ...ok, count: 3 })).toEqual({
      name: 'Asha', count: '3', link: 'https://app.blue-dots.org/x',
    });
    expect(validateVariables(contract, ok)).toEqual(ok);
  });
  it('rejects unknown variables', () => {
    expect(code(() => validateVariables(contract, { ...ok, extra: 'x' }))).toBe('unknown_variable');
  });
  it('rejects a missing or empty required variable', () => {
    expect(code(() => validateVariables(contract, { link: ok.link }))).toBe('missing_variable');
    expect(code(() => validateVariables(contract, { ...ok, name: '' }))).toBe('missing_variable');
  });
  it('rejects non-numeric numbers and object values', () => {
    expect(code(() => validateVariables(contract, { ...ok, count: 'three' }))).toBe('invalid_variable');
    expect(code(() => validateVariables(contract, { ...ok, name: { a: 1 } }))).toBe('invalid_variable');
  });
  it('rejects non-http schemes', () => {
    expect(code(() => validateVariables(contract, { ...ok, link: 'javascript:alert(1)' }))).toBe('invalid_variable');
    expect(code(() => validateVariables(contract, { ...ok, link: 'not a url' }))).toBe('invalid_variable');
  });
  it('rejects lookalike hosts and accepts subdomains', () => {
    expect(code(() => validateVariables(contract, { ...ok, link: 'https://evil-blue-dots.org/' }))).toBe('invalid_variable');
    expect(code(() => validateVariables(contract, { ...ok, link: 'https://blue-dots.org.evil.com/' }))).toBe('invalid_variable');
    expect(validateVariables(contract, { ...ok, link: 'https://blue-dots.org/' }).link).toBe('https://blue-dots.org/');
  });
  it('lists sensitive variables', () => {
    expect(sensitiveVariables([v({ name: 'otp', sensitive: true }), v({ name: 'name' })])).toEqual(['otp']);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/lib/templates/__tests__/contract.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/lib/templates/errors.ts`:

```ts
export type TemplateErrorCode =
  | 'not_found'
  | 'invalid_state'
  | 'unknown_channel'
  | 'vendor_mismatch'
  | 'incomplete_template'
  | 'undeclared_token'
  | 'unused_variable'
  | 'body_too_long'
  | 'missing_variable'
  | 'unknown_variable'
  | 'invalid_variable'
  | 'invalid_contract';

/** A template/policy rule violation. Messages name variables, never their values. */
export class TemplateError extends Error {
  constructor(
    public readonly code: TemplateErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TemplateError';
  }
}
```

`src/lib/templates/contract.ts`:

```ts
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
  .refine((s) => s.type === 'url' || s.urlHosts === undefined, {
    message: 'urlHosts applies only to url variables',
    path: ['urlHosts'],
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
  if (typeof value === 'object' && value !== null) {
    throw new TemplateError('invalid_variable', `${spec.name} must be a scalar`, { variable: spec.name });
  }
  const s = String(value);
  if (spec.type === 'number' && !Number.isFinite(Number(s))) {
    throw new TemplateError('invalid_variable', `${spec.name} must be a number`, { variable: spec.name });
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
    if (spec.urlHosts && !hostAllowed(url.hostname, spec.urlHosts)) {
      throw new TemplateError('invalid_variable', `${spec.name} host is not allowed`, { variable: spec.name });
    }
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
    const value = input[spec.name];
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
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm vitest run src/lib/templates/__tests__/contract.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/templates/errors.ts src/lib/templates/contract.ts src/lib/templates/__tests__/contract.test.ts
git commit -m "feat(templates): variable contract and send-time validation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Rendering

**Files:**
- Create: `src/lib/templates/render.ts`
- Test: `src/lib/templates/__tests__/render.test.ts`

**Interfaces:**
- Consumes: `TemplateRow` (Task 3); `validateVariables`, `TemplateError` (Task 4); `messageType`, `MAX_LENGTH` from `src/lib/providers/sms/render.ts`.
- Produces:
  - `type Rendered = { mode: 'ns'; channel: 'email'; subject: string; html: string | null; text: string | null } | { mode: 'ns'; channel: string; text: string; messageType: 'TXT' | 'UNI' } | { mode: 'provider'; channel: string; providerTemplateId: string; variables: Record<string, string> }`
  - `renderTemplate(t: TemplateRow, renders: 'ns' | 'provider', input: Record<string, unknown>): Rendered`
  - `escapeHtml(s: string): string`

- [ ] **Step 1: Write the failing tests**

`src/lib/templates/__tests__/render.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { escapeHtml, renderTemplate } from '../render';
import { TemplateError } from '../errors';
import type { TemplateRow, VariableSpec } from '../../db/schema';

const v = (over: Partial<VariableSpec> & { name: string }): VariableSpec => ({
  required: true, type: 'string', sensitive: false, raw: false, ...over,
});

function row(over: Partial<TemplateRow>): TemplateRow {
  return {
    id: 'id', network: 'n', channel: 'email', templateKey: 'k', locale: 'en', version: 1,
    status: 'active', subject: null, bodyHtml: null, bodyText: null, variables: [],
    provider: 'smtp', providerTemplateId: null, senderId: null, dltEntityId: null,
    dltHeaderId: null, dltTagId: null, approvalRef: null, defaultDeadlineS: null,
    createdBy: 't', publishedBy: null, createdAt: new Date(), updatedAt: new Date(),
    publishedAt: null, retiredAt: null, ...over,
  };
}

describe('escapeHtml', () => {
  it('escapes the five html metacharacters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});

describe('renderTemplate — email', () => {
  const t = row({
    subject: 'Hello {{name}}',
    bodyHtml: '<p>{{name}}</p><div>{{snippet}}</div>',
    bodyText: 'Hi {{name}}',
    variables: [v({ name: 'name' }), v({ name: 'snippet', raw: true, required: false })],
  });

  it('escapes html by default and only raw is verbatim', () => {
    const r = renderTemplate(t, 'ns', { name: '<script>x</script>', snippet: '<b>ok</b>' });
    expect(r).toMatchObject({ mode: 'ns', channel: 'email' });
    if (r.mode !== 'ns' || r.channel !== 'email') throw new Error('unreachable');
    expect(r.html).toBe('<p>&lt;script&gt;x&lt;/script&gt;</p><div><b>ok</b></div>');
    expect(r.text).toBe('Hi <script>x</script>');
  });

  it('collapses CR/LF in the subject', () => {
    const r = renderTemplate(t, 'ns', { name: 'A\r\nBcc: x@y.z' });
    if (r.mode !== 'ns' || r.channel !== 'email') throw new Error('unreachable');
    expect(r.subject).toBe('Hello A Bcc: x@y.z');
  });

  it('renders an absent optional variable as empty', () => {
    const r = renderTemplate(t, 'ns', { name: 'A' });
    if (r.mode !== 'ns' || r.channel !== 'email') throw new Error('unreachable');
    expect(r.html).toBe('<p>A</p><div></div>');
  });

  it('validates variables before rendering', () => {
    expect(() => renderTemplate(t, 'ns', {})).toThrow(TemplateError);
  });
});

describe('renderTemplate — sms', () => {
  it('renders an ns-rendered sms body without escaping and reports its type', () => {
    const t = row({
      channel: 'sms', provider: 'pinnacle', providerTemplateId: '1107',
      bodyText: '{{message}} is your OTP & valid 5 min', variables: [v({ name: 'message', sensitive: true })],
    });
    expect(renderTemplate(t, 'ns', { message: '123456' })).toEqual({
      mode: 'ns', channel: 'sms', text: '123456 is your OTP & valid 5 min', messageType: 'TXT',
    });
  });

  it('refuses a rendered body over the vendor ceiling', () => {
    const t = row({
      channel: 'sms', provider: 'pinnacle', providerTemplateId: '1', bodyText: '{{x}}',
      variables: [v({ name: 'x' })],
    });
    try {
      renderTemplate(t, 'ns', { x: 'a'.repeat(2001) });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as TemplateError).code).toBe('body_too_long');
    }
  });

  it('passes id + validated variables through for vendor-rendered templates', () => {
    const t = row({
      channel: 'sms', provider: 'msg91', providerTemplateId: 'flow-1',
      variables: [v({ name: 'message', sensitive: true })],
    });
    expect(renderTemplate(t, 'provider', { message: '42' })).toEqual({
      mode: 'provider', channel: 'sms', providerTemplateId: 'flow-1', variables: { message: '42' },
    });
  });

  it('fails incomplete templates', () => {
    const t = row({ channel: 'sms', provider: 'pinnacle', providerTemplateId: '1', variables: [] });
    try {
      renderTemplate(t, 'ns', {});
      throw new Error('expected throw');
    } catch (e) {
      expect((e as TemplateError).code).toBe('incomplete_template');
    }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/lib/templates/__tests__/render.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/lib/templates/render.ts`:

```ts
import type { TemplateRow, VariableSpec } from '../db/schema';
import { MAX_LENGTH, messageType } from '../providers/sms/render';
import { validateVariables } from './contract';
import { TemplateError } from './errors';

export type Rendered =
  | { mode: 'ns'; channel: 'email'; subject: string; html: string | null; text: string | null }
  | { mode: 'ns'; channel: string; text: string; messageType: 'TXT' | 'UNI' }
  | { mode: 'provider'; channel: string; providerTemplateId: string; variables: Record<string, string> };

const TOKEN = /\{\{(\w+)\}\}/g;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function substitute(
  text: string,
  values: Record<string, string>,
  contract: VariableSpec[],
  escape: boolean,
): string {
  const raw = new Set(contract.filter((s) => s.raw).map((s) => s.name));
  return text.replace(TOKEN, (_m, name: string) => {
    const value = values[name] ?? '';
    return escape && !raw.has(name) ? escapeHtml(value) : value;
  });
}

/**
 * Turn a template + send-time variables into what the vendor receives.
 * Variables are validated against the contract first, so nothing reaches a
 * vendor with a missing, unknown or malformed value.
 */
export function renderTemplate(
  t: TemplateRow,
  renders: 'ns' | 'provider',
  input: Record<string, unknown>,
): Rendered {
  const values = validateVariables(t.variables, input);

  if (renders === 'provider') {
    if (!t.providerTemplateId) {
      throw new TemplateError('incomplete_template', 'provider template id is missing');
    }
    return { mode: 'provider', channel: t.channel, providerTemplateId: t.providerTemplateId, variables: values };
  }

  if (t.channel === 'email') {
    if (!t.subject || (!t.bodyHtml && !t.bodyText)) {
      throw new TemplateError('incomplete_template', 'email needs a subject and a body');
    }
    return {
      mode: 'ns',
      channel: 'email',
      subject: substitute(t.subject, values, t.variables, false).replace(/[\r\n]+/g, ' '),
      html: t.bodyHtml ? substitute(t.bodyHtml, values, t.variables, true) : null,
      text: t.bodyText ? substitute(t.bodyText, values, t.variables, false) : null,
    };
  }

  if (!t.bodyText) throw new TemplateError('incomplete_template', 'body text is missing');
  const text = substitute(t.bodyText, values, t.variables, false);
  const type = messageType(text);
  if (text.length > MAX_LENGTH[type]) {
    throw new TemplateError('body_too_long', `rendered body exceeds ${MAX_LENGTH[type]} characters`, {
      length: text.length,
      messageType: type,
    });
  }
  return { mode: 'ns', channel: t.channel, text, messageType: type };
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm vitest run src/lib/templates/__tests__/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/templates/render.ts src/lib/templates/__tests__/render.test.ts
git commit -m "feat(templates): render with html escaping, length limits and vendor passthrough

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Template repository — lifecycle, publish validation, resolution

**Files:**
- Create: `src/lib/templates/repo.ts`, `src/lib/templates/validate.ts`
- Test: `src/lib/templates/__tests__/validate.test.ts`, `src/lib/templates/__tests__/repo.integration.test.ts`

**Interfaces:**
- Consumes: `getDb`, `template`, `TemplateRow`, `VariableSpec` (Plan A, Task 3); `TemplateError`, `checkTokensMatchContract`, `VariableContractSchema` (Task 4); `MAX_LENGTH`, `messageType`; `channelVendor`, `currentNetwork`, `defaultLocale` (Task 2).
- Produces:
  - `validateForPublish(t: TemplateRow, vendor: { vendor: string; renders: 'ns' | 'provider' } | undefined): void` (in `validate.ts`)
  - `interface TemplateDraftInput { channel: string; templateKey: string; locale?: string; subject?: string | null; bodyHtml?: string | null; bodyText?: string | null; variables?: VariableSpec[]; providerTemplateId?: string | null; senderId?: string | null; dltEntityId?: string | null; dltHeaderId?: string | null; dltTagId?: string | null; approvalRef?: string | null; defaultDeadlineS?: number | null }`
  - `type TemplatePatch = Omit<Partial<TemplateDraftInput>, 'channel' | 'templateKey' | 'locale'>`
  - `createTemplateDraft(input: TemplateDraftInput, actor: string): Promise<TemplateRow>`
  - `updateTemplateDraft(id: string, patch: TemplatePatch): Promise<TemplateRow>`
  - `publishTemplate(id: string, actor: string): Promise<TemplateRow>`
  - `retireTemplate(id: string): Promise<TemplateRow>`
  - `getTemplate(id: string): Promise<TemplateRow>`
  - `listTemplates(filter: { channel?: string; templateKey?: string; status?: LifecycleStatus }): Promise<TemplateRow[]>`
  - `resolveTemplate(channel: string, templateKey: string, locale?: string): Promise<{ template: TemplateRow; renders: 'ns' | 'provider' }>` — throws `not_found` / `vendor_mismatch` / `unknown_channel`
  - `hasActiveTemplate(channel: string, templateKey: string): Promise<boolean>`

Rules (`validateForPublish`):
1. `vendor` undefined → `unknown_channel`. `t.provider !== vendor.vendor` → `vendor_mismatch`.
2. `t.variables` must parse with `VariableContractSchema` → else `invalid_contract`.
3. `email`: `subject` and (`bodyHtml` or `bodyText`) required → `incomplete_template`; `checkTokensMatchContract([subject, bodyHtml, bodyText], variables)`.
4. Other channels: `providerTemplateId` required → `incomplete_template`. If `vendor.renders === 'ns'`: `bodyText` required → `incomplete_template`. If `bodyText` present: `checkTokensMatchContract([bodyText], variables)` and the stored body length (tokens included) must be ≤ `MAX_LENGTH[messageType(bodyText)]` → `body_too_long`.
5. `raw: true` on a non-email channel → `invalid_contract` (escaping applies only to email).

- [ ] **Step 1: Write the failing unit test for publish validation**

`src/lib/templates/__tests__/validate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { validateForPublish } from '../validate';
import { TemplateError } from '../errors';
import type { TemplateRow, VariableSpec } from '../../db/schema';

const v = (over: Partial<VariableSpec> & { name: string }): VariableSpec => ({
  required: true, type: 'string', sensitive: false, raw: false, ...over,
});
function row(over: Partial<TemplateRow>): TemplateRow {
  return {
    id: 'id', network: 'n', channel: 'sms', templateKey: 'k', locale: 'en', version: 1,
    status: 'draft', subject: null, bodyHtml: null, bodyText: null, variables: [],
    provider: 'pinnacle', providerTemplateId: '1107', senderId: null, dltEntityId: null,
    dltHeaderId: null, dltTagId: null, approvalRef: null, defaultDeadlineS: null,
    createdBy: 't', publishedBy: null, createdAt: new Date(), updatedAt: new Date(),
    publishedAt: null, retiredAt: null, ...over,
  };
}
const codeOf = (fn: () => void) => { try { fn(); return undefined; } catch (e) { return (e as TemplateError).code; } };
const pinnacle = { vendor: 'pinnacle', renders: 'ns' as const };
const msg91 = { vendor: 'msg91', renders: 'provider' as const };

describe('validateForPublish', () => {
  it('requires a known channel and the deployment vendor', () => {
    expect(codeOf(() => validateForPublish(row({}), undefined))).toBe('unknown_channel');
    expect(codeOf(() => validateForPublish(row({ provider: 'msg91' }), pinnacle))).toBe('vendor_mismatch');
  });
  it('requires an id, and a body when NS renders', () => {
    expect(codeOf(() => validateForPublish(row({ providerTemplateId: null }), pinnacle))).toBe('incomplete_template');
    expect(codeOf(() => validateForPublish(row({}), pinnacle))).toBe('incomplete_template');
    expect(codeOf(() => validateForPublish(row({ provider: 'msg91' }), msg91))).toBeUndefined();
  });
  it('checks tokens both ways when a body is stored', () => {
    expect(codeOf(() => validateForPublish(row({ bodyText: 'Hi {{name}}' }), pinnacle))).toBe('undeclared_token');
    expect(codeOf(() => validateForPublish(row({ bodyText: 'Hi', variables: [v({ name: 'name' })] }), pinnacle))).toBe('unused_variable');
    expect(codeOf(() => validateForPublish(row({ bodyText: 'Hi {{name}}', variables: [v({ name: 'name' })] }), pinnacle))).toBeUndefined();
  });
  it('limits stored sms length by message type', () => {
    expect(codeOf(() => validateForPublish(row({ bodyText: 'a'.repeat(2001) }), pinnacle))).toBe('body_too_long');
    expect(codeOf(() => validateForPublish(row({ bodyText: 'अ'.repeat(751) }), pinnacle))).toBe('body_too_long');
  });
  it('requires subject and body for email', () => {
    const smtp = { vendor: 'smtp', renders: 'ns' as const };
    const email = row({ channel: 'email', provider: 'smtp', providerTemplateId: null });
    expect(codeOf(() => validateForPublish(email, smtp))).toBe('incomplete_template');
    expect(codeOf(() => validateForPublish({ ...email, subject: 'S', bodyHtml: '<p>x</p>' }, smtp))).toBeUndefined();
  });
  it('rejects raw outside email and an unparseable contract', () => {
    expect(codeOf(() => validateForPublish(row({ bodyText: '{{a}}', variables: [v({ name: 'a', raw: true })] }), pinnacle))).toBe('invalid_contract');
    expect(codeOf(() => validateForPublish(row({ variables: [{ name: 'a-b' } as VariableSpec] }), msg91 as never))).toBe('invalid_contract');
  });
});
```

(The Devanagari literal in a test file is fine — the `\u`-escape rule in CLAUDE.md is about `render.ts` itself.)

- [ ] **Step 2: Write the failing integration test for the repository**

`src/lib/templates/__tests__/repo.integration.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const vendor = vi.hoisted(() => ({ current: { vendor: 'pinnacle', renders: 'ns' as 'ns' | 'provider' } }));
vi.mock('../vendors', () => ({
  channelVendor: (channel: string) =>
    channel === 'sms' ? vendor.current : channel === 'email' ? { vendor: 'smtp', renders: 'ns' } : undefined,
}));

import { closeDb, getPool } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import {
  createTemplateDraft, getTemplate, hasActiveTemplate, listTemplates,
  publishTemplate, resolveTemplate, retireTemplate, updateTemplateDraft,
} from '../repo';
import { TemplateError } from '../errors';

process.env.NS_NETWORK = 'test_net';

beforeAll(async () => { await runMigrations(); });
afterAll(async () => { await closeDb(); });
beforeEach(async () => {
  vendor.current = { vendor: 'pinnacle', renders: 'ns' };
  await getPool().query(`DELETE FROM notification_policy; DELETE FROM template;`);
});

const otp = (locale = 'en') => ({
  channel: 'sms', templateKey: 'login_otp', locale, providerTemplateId: '1107',
  bodyText: '{{message}} is your OTP',
  variables: [{ name: 'message', required: true, type: 'string' as const, sensitive: true, raw: false }],
});

async function codeOf(p: Promise<unknown>) {
  try { await p; return undefined; } catch (e) { return (e as TemplateError).code; }
}

describe('template repository', () => {
  it('creates drafts with increasing versions under the deployment vendor and network', async () => {
    const a = await createTemplateDraft(otp(), 'admin');
    const b = await createTemplateDraft(otp(), 'admin');
    expect([a.version, b.version]).toEqual([1, 2]);
    expect(a).toMatchObject({ status: 'draft', provider: 'pinnacle', network: 'test_net', createdBy: 'admin' });
  });

  it('only edits drafts', async () => {
    const d = await createTemplateDraft(otp(), 'admin');
    const edited = await updateTemplateDraft(d.id, { approvalRef: 'DLT-9' });
    expect(edited.approvalRef).toBe('DLT-9');
    await publishTemplate(d.id, 'admin');
    expect(await codeOf(updateTemplateDraft(d.id, { approvalRef: 'x' }))).toBe('invalid_state');
  });

  it('publishing retires the previous active version', async () => {
    const v1 = await createTemplateDraft(otp(), 'admin');
    await publishTemplate(v1.id, 'admin');
    const v2 = await createTemplateDraft(otp(), 'admin');
    const published = await publishTemplate(v2.id, 'publisher');
    expect(published).toMatchObject({ status: 'active', publishedBy: 'publisher' });
    expect((await getTemplate(v1.id)).status).toBe('retired');
  });

  it('concurrent publishes leave exactly one active', async () => {
    const a = await createTemplateDraft(otp(), 'admin');
    const b = await createTemplateDraft(otp(), 'admin');
    await Promise.all([publishTemplate(a.id, 'x'), publishTemplate(b.id, 'y')]);
    const active = await listTemplates({ templateKey: 'login_otp', status: 'active' });
    expect(active).toHaveLength(1);
  });

  it('refuses to publish an invalid draft and leaves it a draft', async () => {
    const d = await createTemplateDraft({ ...otp(), bodyText: 'no token' }, 'admin');
    expect(await codeOf(publishTemplate(d.id, 'admin'))).toBe('unused_variable');
    expect((await getTemplate(d.id)).status).toBe('draft');
  });

  it('retires without deleting', async () => {
    const d = await createTemplateDraft(otp(), 'admin');
    await publishTemplate(d.id, 'admin');
    expect((await retireTemplate(d.id)).status).toBe('retired');
    expect(await codeOf(retireTemplate(d.id))).toBe('invalid_state');
    expect(await hasActiveTemplate('sms', 'login_otp')).toBe(false);
  });

  it('resolves with locale fallback xx-YY → xx → default', async () => {
    const en = await createTemplateDraft(otp('en'), 'admin');
    await publishTemplate(en.id, 'admin');
    const hi = await createTemplateDraft(otp('hi'), 'admin');
    await publishTemplate(hi.id, 'admin');
    expect((await resolveTemplate('sms', 'login_otp', 'hi-IN')).template.locale).toBe('hi');
    expect((await resolveTemplate('sms', 'login_otp', 'ta-IN')).template.locale).toBe('en');
    expect((await resolveTemplate('sms', 'login_otp')).template.locale).toBe('en');
    expect(await codeOf(resolveTemplate('sms', 'nope'))).toBe('not_found');
  });

  it('resolve refuses a template for another vendor', async () => {
    const d = await createTemplateDraft(otp(), 'admin');
    await publishTemplate(d.id, 'admin');
    vendor.current = { vendor: 'msg91', renders: 'provider' };
    expect(await codeOf(resolveTemplate('sms', 'login_otp'))).toBe('vendor_mismatch');
  });

  it('scopes everything to NS_NETWORK', async () => {
    await createTemplateDraft(otp(), 'admin');
    process.env.NS_NETWORK = 'other_net';
    try {
      expect(await listTemplates({})).toHaveLength(0);
    } finally {
      process.env.NS_NETWORK = 'test_net';
    }
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm vitest run src/lib/templates/__tests__/validate.test.ts` and the integration command.
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `validate.ts`**

```ts
import type { TemplateRow } from '../db/schema';
import { MAX_LENGTH, messageType } from '../providers/sms/render';
import { checkTokensMatchContract, VariableContractSchema } from './contract';
import { TemplateError } from './errors';

/** Everything that must be true before a template may become active. */
export function validateForPublish(
  t: TemplateRow,
  vendor: { vendor: string; renders: 'ns' | 'provider' } | undefined,
): void {
  if (!vendor) throw new TemplateError('unknown_channel', `no provider for channel ${t.channel}`);
  if (t.provider !== vendor.vendor) {
    throw new TemplateError('vendor_mismatch', `template is for ${t.provider}; this deployment sends ${t.channel} via ${vendor.vendor}`);
  }
  const parsed = VariableContractSchema.safeParse(t.variables);
  if (!parsed.success) throw new TemplateError('invalid_contract', 'variable contract is invalid');
  const contract = parsed.data;

  if (t.channel === 'email') {
    if (!t.subject || (!t.bodyHtml && !t.bodyText)) {
      throw new TemplateError('incomplete_template', 'email needs a subject and a body');
    }
    checkTokensMatchContract([t.subject, t.bodyHtml, t.bodyText], contract);
    return;
  }

  if (contract.some((s) => s.raw)) {
    throw new TemplateError('invalid_contract', 'raw applies only to email variables');
  }
  if (!t.providerTemplateId) throw new TemplateError('incomplete_template', 'provider template id is missing');
  if (vendor.renders === 'ns' && !t.bodyText) {
    throw new TemplateError('incomplete_template', `${vendor.vendor} needs the approved body text`);
  }
  if (t.bodyText) {
    checkTokensMatchContract([t.bodyText], contract);
    const type = messageType(t.bodyText);
    if (t.bodyText.length > MAX_LENGTH[type]) {
      throw new TemplateError('body_too_long', `body exceeds ${MAX_LENGTH[type]} characters`);
    }
  }
}
```

- [ ] **Step 5: Implement `repo.ts`**

```ts
import { and, eq, inArray, max, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { template, type LifecycleStatus, type TemplateRow, type VariableSpec } from '../db/schema';
import { currentNetwork, defaultLocale } from '../network';
import { TemplateError } from './errors';
import { validateForPublish } from './validate';
import { channelVendor } from './vendors';

export interface TemplateDraftInput {
  channel: string;
  templateKey: string;
  locale?: string;
  subject?: string | null;
  bodyHtml?: string | null;
  bodyText?: string | null;
  variables?: VariableSpec[];
  providerTemplateId?: string | null;
  senderId?: string | null;
  dltEntityId?: string | null;
  dltHeaderId?: string | null;
  dltTagId?: string | null;
  approvalRef?: string | null;
  defaultDeadlineS?: number | null;
}

export type TemplatePatch = Omit<Partial<TemplateDraftInput>, 'channel' | 'templateKey' | 'locale'>;

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

/** Serialise every write to one template key: version numbering and publish. */
async function lockKey(tx: Tx, network: string, channel: string, key: string, locale: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`template:${network}:${channel}:${key}:${locale}`}))`,
  );
}

async function loadForUpdate(tx: Tx, id: string): Promise<TemplateRow> {
  const network = currentNetwork();
  const rows = await tx
    .select()
    .from(template)
    .where(and(eq(template.id, id), eq(template.network, network)))
    .for('update');
  if (!rows[0]) throw new TemplateError('not_found', 'template not found');
  return rows[0];
}

export async function createTemplateDraft(input: TemplateDraftInput, actor: string): Promise<TemplateRow> {
  const network = currentNetwork();
  const vendor = channelVendor(input.channel);
  if (!vendor) throw new TemplateError('unknown_channel', `no provider for channel ${input.channel}`);
  const locale = input.locale ?? defaultLocale();
  return getDb().transaction(async (tx) => {
    await lockKey(tx, network, input.channel, input.templateKey, locale);
    const [{ v }] = await tx
      .select({ v: max(template.version) })
      .from(template)
      .where(
        and(
          eq(template.network, network),
          eq(template.channel, input.channel),
          eq(template.templateKey, input.templateKey),
          eq(template.locale, locale),
        ),
      );
    const [row] = await tx
      .insert(template)
      .values({
        ...input,
        variables: input.variables ?? [],
        locale,
        network,
        provider: vendor.vendor,
        version: (v ?? 0) + 1,
        status: 'draft',
        createdBy: actor,
      })
      .returning();
    return row!;
  });
}

export async function updateTemplateDraft(id: string, patch: TemplatePatch): Promise<TemplateRow> {
  return getDb().transaction(async (tx) => {
    const current = await loadForUpdate(tx, id);
    if (current.status !== 'draft') {
      throw new TemplateError('invalid_state', `only drafts can be edited; this one is ${current.status}`);
    }
    const [row] = await tx
      .update(template)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(template.id, id))
      .returning();
    return row!;
  });
}

export async function publishTemplate(id: string, actor: string): Promise<TemplateRow> {
  return getDb().transaction(async (tx) => {
    const peek = await loadForUpdate(tx, id);
    await lockKey(tx, peek.network, peek.channel, peek.templateKey, peek.locale);
    const current = await loadForUpdate(tx, id);
    if (current.status !== 'draft') {
      throw new TemplateError('invalid_state', `only drafts can be published; this one is ${current.status}`);
    }
    validateForPublish(current, channelVendor(current.channel));
    const now = new Date();
    await tx
      .update(template)
      .set({ status: 'retired', retiredAt: now, updatedAt: now })
      .where(
        and(
          eq(template.network, current.network),
          eq(template.channel, current.channel),
          eq(template.templateKey, current.templateKey),
          eq(template.locale, current.locale),
          eq(template.status, 'active'),
        ),
      );
    const [row] = await tx
      .update(template)
      .set({ status: 'active', publishedAt: now, publishedBy: actor, updatedAt: now })
      .where(eq(template.id, id))
      .returning();
    return row!;
  });
}

export async function retireTemplate(id: string): Promise<TemplateRow> {
  return getDb().transaction(async (tx) => {
    const current = await loadForUpdate(tx, id);
    if (current.status === 'retired') throw new TemplateError('invalid_state', 'already retired');
    const now = new Date();
    const [row] = await tx
      .update(template)
      .set({ status: 'retired', retiredAt: now, updatedAt: now })
      .where(eq(template.id, id))
      .returning();
    return row!;
  });
}

export async function getTemplate(id: string): Promise<TemplateRow> {
  const rows = await getDb()
    .select()
    .from(template)
    .where(and(eq(template.id, id), eq(template.network, currentNetwork())));
  if (!rows[0]) throw new TemplateError('not_found', 'template not found');
  return rows[0];
}

export async function listTemplates(filter: {
  channel?: string;
  templateKey?: string;
  status?: LifecycleStatus;
}): Promise<TemplateRow[]> {
  const conds = [eq(template.network, currentNetwork())];
  if (filter.channel) conds.push(eq(template.channel, filter.channel));
  if (filter.templateKey) conds.push(eq(template.templateKey, filter.templateKey));
  if (filter.status) conds.push(eq(template.status, filter.status));
  return getDb()
    .select()
    .from(template)
    .where(and(...conds))
    .orderBy(template.channel, template.templateKey, template.locale, template.version);
}

function localeChain(requested: string | undefined): string[] {
  const chain: string[] = [];
  if (requested) {
    chain.push(requested);
    const base = requested.split('-')[0]!;
    if (base !== requested) chain.push(base);
  }
  chain.push(defaultLocale());
  return [...new Set(chain)];
}

/**
 * The active template a send would use, with the deployment's render mode.
 * Refuses a template registered for a different vendor than the one this
 * deployment sends through — its ids mean nothing to the current vendor.
 */
export async function resolveTemplate(
  channel: string,
  templateKey: string,
  locale?: string,
): Promise<{ template: TemplateRow; renders: 'ns' | 'provider' }> {
  const vendor = channelVendor(channel);
  if (!vendor) throw new TemplateError('unknown_channel', `no provider for channel ${channel}`);
  const chain = localeChain(locale);
  const rows = await getDb()
    .select()
    .from(template)
    .where(
      and(
        eq(template.network, currentNetwork()),
        eq(template.channel, channel),
        eq(template.templateKey, templateKey),
        eq(template.status, 'active'),
        inArray(template.locale, chain),
      ),
    );
  const found = chain.map((l) => rows.find((r) => r.locale === l)).find(Boolean);
  if (!found) throw new TemplateError('not_found', `no active ${channel} template ${templateKey}`);
  if (found.provider !== vendor.vendor) {
    throw new TemplateError('vendor_mismatch', `active ${templateKey} is for ${found.provider}; ${channel} sends via ${vendor.vendor}`);
  }
  return { template: found, renders: vendor.renders };
}

export async function hasActiveTemplate(channel: string, templateKey: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: template.id })
    .from(template)
    .where(
      and(
        eq(template.network, currentNetwork()),
        eq(template.channel, channel),
        eq(template.templateKey, templateKey),
        eq(template.status, 'active'),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
```

Note on `publishTemplate`: the row is loaded once to learn its key, the key's advisory lock is taken, then the row is re-read — so two concurrent publishes of drafts of the same key serialise, and the second retires the first. `retireTemplate` on a draft is allowed (drafts can be abandoned); on a retired row it is `invalid_state`.

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm vitest run src/lib/templates` and the integration command.
Expected: PASS. If the concurrent-publish test produces a `template_active_uq` violation instead, the lock is not covering both publishes — fix the lock, do not weaken the test.

- [ ] **Step 7: Commit**

```bash
git add src/lib/templates
git commit -m "feat(templates): lifecycle, publish validation and resolution with locale fallback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Template admin API

**Files:**
- Create: `src/routes/admin-templates.ts`, `src/routes/admin-errors.ts`
- Modify: `src/app.ts`
- Test: `src/routes/__tests__/admin-templates.test.ts`

**Interfaces:**
- Consumes: repo functions (Task 6), `renderTemplate` (Task 5), `VariableContractSchema` (Task 4), `requestAuth`, `requireAdmin` (Task 2), `channelVendor`, `NetworkNotConfigured`.
- Produces:
  - `adminTemplateRoutes(app: FastifyInstance)`
  - `sendAdminError(reply: FastifyReply, err: unknown): FastifyReply` (in `admin-errors.ts`; reused by Task 9) — `TemplateError` → `not_found` 404, `invalid_state` 409, everything else 422 with `{ error: code, message, details? }`; `NetworkNotConfigured` → 503 `{ error: 'network_not_configured' }`; anything else rethrown.
  - `serializeTemplate(row: TemplateRow): Record<string, unknown>` — snake_case JSON.

Routes (all `preHandler: [requestAuth, requireAdmin]`; actor = the `x-ns-key` header):

| Method + path | Body / query | Success |
| --- | --- | --- |
| `GET /v1/admin/templates` | `?channel&template_key&status` | `200 { templates: [...] }` |
| `GET /v1/admin/templates/:id` | — | `200 template` |
| `POST /v1/admin/templates` | draft input (snake_case) | `201 template` |
| `PATCH /v1/admin/templates/:id` | patch (snake_case, no channel/key/locale) | `200 template` |
| `POST /v1/admin/templates/:id/publish` | — | `200 template` |
| `POST /v1/admin/templates/:id/retire` | — | `200 template` |
| `POST /v1/admin/templates/:id/preview` | `{ variables: {} }` | `200 { rendered }` |

- [ ] **Step 1: Write the failing tests**

`src/routes/__tests__/admin-templates.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../plugins/request-auth', () => ({ requestAuth: async () => {} }));
const repo = vi.hoisted(() => ({
  createTemplateDraft: vi.fn(), updateTemplateDraft: vi.fn(), publishTemplate: vi.fn(),
  retireTemplate: vi.fn(), getTemplate: vi.fn(), listTemplates: vi.fn(),
}));
vi.mock('../../lib/templates/repo', () => repo);
vi.mock('../../lib/templates/vendors', () => ({
  channelVendor: (c: string) => (c === 'email' ? { vendor: 'smtp', renders: 'ns' } : undefined),
}));

const Fastify = (await import('fastify')).default;
const { adminTemplateRoutes } = await import('../admin-templates');
const { TemplateError } = await import('../../lib/templates/errors');
const { NetworkNotConfigured } = await import('../../lib/network');

const ID = '00000000-0000-4000-8000-000000000001';
const row = {
  id: ID, network: 'n', channel: 'email', templateKey: 'welcome', locale: 'en', version: 1,
  status: 'draft', subject: 'Hi {{name}}', bodyHtml: '<p>{{name}}</p>', bodyText: null,
  variables: [{ name: 'name', required: true, type: 'string', sensitive: false, raw: false }],
  provider: 'smtp', providerTemplateId: null, senderId: null, dltEntityId: null, dltHeaderId: null,
  dltTagId: null, approvalRef: null, defaultDeadlineS: null, createdBy: 'ns-admin', publishedBy: null,
  createdAt: new Date('2026-10-04T00:00:00Z'), updatedAt: new Date('2026-10-04T00:00:00Z'),
  publishedAt: null, retiredAt: null,
};

async function build() {
  const app = Fastify({ logger: false });
  await app.register(adminTemplateRoutes);
  await app.ready();
  return app;
}
const admin = { 'x-ns-key': 'ns-admin' };

beforeEach(() => {
  process.env.NS_ADMIN_KEY_IDS = 'ns-admin';
  Object.values(repo).forEach((f) => f.mockReset());
});

describe('admin template routes', () => {
  it('403s a non-admin key', async () => {
    const res = await (await build()).inject({ method: 'GET', url: '/v1/admin/templates', headers: { 'x-ns-key': 'sender' } });
    expect(res.statusCode).toBe(403);
  });

  it('creates a draft from snake_case input with the caller as actor', async () => {
    repo.createTemplateDraft.mockResolvedValue(row);
    const res = await (await build()).inject({
      method: 'POST', url: '/v1/admin/templates', headers: admin,
      payload: { channel: 'email', template_key: 'welcome', subject: 'Hi {{name}}', body_html: '<p>{{name}}</p>', variables: [{ name: 'name' }] },
    });
    expect(res.statusCode).toBe(201);
    expect(repo.createTemplateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'email', templateKey: 'welcome', bodyHtml: '<p>{{name}}</p>', variables: [{ name: 'name', required: true, type: 'string', sensitive: false, raw: false }] }),
      'ns-admin',
    );
    expect(res.json()).toMatchObject({ id: ID, template_key: 'welcome', body_html: '<p>{{name}}</p>', status: 'draft' });
  });

  it('rejects an invalid body with 400 and never calls the repo', async () => {
    const res = await (await build()).inject({ method: 'POST', url: '/v1/admin/templates', headers: admin, payload: { channel: 'email' } });
    expect(res.statusCode).toBe(400);
    expect(repo.createTemplateDraft).not.toHaveBeenCalled();
  });

  it('refuses to change channel, key or locale on PATCH', async () => {
    const res = await (await build()).inject({ method: 'PATCH', url: `/v1/admin/templates/${ID}`, headers: admin, payload: { channel: 'sms' } });
    expect(res.statusCode).toBe(400);
  });

  it('maps template errors to status codes', async () => {
    repo.publishTemplate.mockRejectedValueOnce(new TemplateError('not_found', 'x'));
    repo.publishTemplate.mockRejectedValueOnce(new TemplateError('invalid_state', 'x'));
    repo.publishTemplate.mockRejectedValueOnce(new TemplateError('undeclared_token', 'x', { tokens: ['a'] }));
    repo.publishTemplate.mockRejectedValueOnce(new NetworkNotConfigured());
    const app = await build();
    const codes = [];
    for (let i = 0; i < 4; i++) {
      codes.push((await app.inject({ method: 'POST', url: `/v1/admin/templates/${ID}/publish`, headers: admin })).statusCode);
    }
    expect(codes).toEqual([404, 409, 422, 503]);
  });

  it('previews a render with the supplied variables', async () => {
    repo.getTemplate.mockResolvedValue(row);
    const res = await (await build()).inject({
      method: 'POST', url: `/v1/admin/templates/${ID}/preview`, headers: admin, payload: { variables: { name: '<b>A</b>' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rendered).toMatchObject({ mode: 'ns', html: '<p>&lt;b&gt;A&lt;/b&gt;</p>' });
  });

  it('preview reports a variable problem as 422', async () => {
    repo.getTemplate.mockResolvedValue(row);
    const res = await (await build()).inject({ method: 'POST', url: `/v1/admin/templates/${ID}/preview`, headers: admin, payload: { variables: {} } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('missing_variable');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/routes/__tests__/admin-templates.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `admin-errors.ts`**

```ts
import { FastifyReply } from 'fastify';
import { NetworkNotConfigured } from '../lib/network';
import { TemplateError } from '../lib/templates/errors';

export function sendAdminError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof NetworkNotConfigured) {
    return reply.code(503).send({ error: 'network_not_configured' });
  }
  if (err instanceof TemplateError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'invalid_state' ? 409 : 422;
    return reply.code(status).send({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
  }
  throw err;
}
```

- [ ] **Step 4: Implement `admin-templates.ts`**

```ts
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TemplateRow } from '../lib/db/schema';
import { VariableContractSchema } from '../lib/templates/contract';
import { renderTemplate } from '../lib/templates/render';
import * as repo from '../lib/templates/repo';
import { channelVendor } from '../lib/templates/vendors';
import { TemplateError } from '../lib/templates/errors';
import { requestAuth } from '../plugins/request-auth';
import { requireAdmin } from '../plugins/require-admin';
import { sendAdminError } from './admin-errors';

const nullableText = (max: number) => z.string().max(max).nullable().optional();

const PatchSchema = z
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

const CreateSchema = PatchSchema.extend({
  channel: z.string().min(1).max(32),
  template_key: z.string().regex(/^[a-z0-9_.-]+$/).max(128),
  locale: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/).optional(),
}).strict();

const ListQuery = z.object({
  channel: z.string().optional(),
  template_key: z.string().optional(),
  status: z.enum(['draft', 'active', 'retired']).optional(),
});
const IdParams = z.object({ id: z.uuid() });
const PreviewBody = z.object({ variables: z.record(z.string(), z.unknown()).default({}) }).strict();

function toPatch(b: z.infer<typeof PatchSchema>): repo.TemplatePatch {
  const map: Record<string, keyof repo.TemplatePatch> = {
    subject: 'subject', body_html: 'bodyHtml', body_text: 'bodyText', variables: 'variables',
    provider_template_id: 'providerTemplateId', sender_id: 'senderId', dlt_entity_id: 'dltEntityId',
    dlt_header_id: 'dltHeaderId', dlt_tag_id: 'dltTagId', approval_ref: 'approvalRef',
    default_deadline_s: 'defaultDeadlineS',
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) if (v !== undefined) out[map[k]!] = v;
  return out as repo.TemplatePatch;
}

export function serializeTemplate(t: TemplateRow) {
  return {
    id: t.id, network: t.network, channel: t.channel, template_key: t.templateKey, locale: t.locale,
    version: t.version, status: t.status, subject: t.subject, body_html: t.bodyHtml, body_text: t.bodyText,
    variables: t.variables, provider: t.provider, provider_template_id: t.providerTemplateId,
    sender_id: t.senderId, dlt_entity_id: t.dltEntityId, dlt_header_id: t.dltHeaderId, dlt_tag_id: t.dltTagId,
    approval_ref: t.approvalRef, default_deadline_s: t.defaultDeadlineS, created_by: t.createdBy,
    published_by: t.publishedBy, created_at: t.createdAt, updated_at: t.updatedAt,
    published_at: t.publishedAt, retired_at: t.retiredAt,
  };
}

const actorOf = (headers: Record<string, unknown>) => String(headers['x-ns-key']);

export async function adminTemplateRoutes(app: FastifyInstance) {
  const preHandler = [requestAuth, requireAdmin];

  app.get('/v1/admin/templates', { preHandler }, async (req, reply) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send(z.formatError(q.error));
    try {
      const rows = await repo.listTemplates({ channel: q.data.channel, templateKey: q.data.template_key, status: q.data.status });
      return { templates: rows.map(serializeTemplate) };
    } catch (err) { return sendAdminError(reply, err); }
  });

  app.get('/v1/admin/templates/:id', { preHandler }, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    if (!p.success) return reply.code(400).send(z.formatError(p.error));
    try { return serializeTemplate(await repo.getTemplate(p.data.id)); }
    catch (err) { return sendAdminError(reply, err); }
  });

  app.post('/v1/admin/templates', { preHandler }, async (req, reply) => {
    const b = CreateSchema.safeParse(req.body);
    if (!b.success) return reply.code(400).send(z.formatError(b.error));
    const { channel, template_key, locale, ...rest } = b.data;
    try {
      const row = await repo.createTemplateDraft(
        { channel, templateKey: template_key, locale, ...toPatch(rest) },
        actorOf(req.headers),
      );
      return reply.code(201).send(serializeTemplate(row));
    } catch (err) { return sendAdminError(reply, err); }
  });

  app.patch('/v1/admin/templates/:id', { preHandler }, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    const b = PatchSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send(z.formatError(p.error));
    if (!b.success) return reply.code(400).send(z.formatError(b.error));
    try { return serializeTemplate(await repo.updateTemplateDraft(p.data.id, toPatch(b.data))); }
    catch (err) { return sendAdminError(reply, err); }
  });

  app.post('/v1/admin/templates/:id/publish', { preHandler }, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    if (!p.success) return reply.code(400).send(z.formatError(p.error));
    try { return serializeTemplate(await repo.publishTemplate(p.data.id, actorOf(req.headers))); }
    catch (err) { return sendAdminError(reply, err); }
  });

  app.post('/v1/admin/templates/:id/retire', { preHandler }, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    if (!p.success) return reply.code(400).send(z.formatError(p.error));
    try { return serializeTemplate(await repo.retireTemplate(p.data.id)); }
    catch (err) { return sendAdminError(reply, err); }
  });

  app.post('/v1/admin/templates/:id/preview', { preHandler }, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    const b = PreviewBody.safeParse(req.body ?? {});
    if (!p.success) return reply.code(400).send(z.formatError(p.error));
    if (!b.success) return reply.code(400).send(z.formatError(b.error));
    try {
      const t = await repo.getTemplate(p.data.id);
      const vendor = channelVendor(t.channel);
      if (!vendor) throw new TemplateError('unknown_channel', `no provider for channel ${t.channel}`);
      return { rendered: renderTemplate(t, vendor.renders, b.data.variables) };
    } catch (err) { return sendAdminError(reply, err); }
  });
}
```

- [ ] **Step 5: Register and run**

In `src/app.ts`: `import { adminTemplateRoutes } from './routes/admin-templates';` and `app.register(adminTemplateRoutes);`.

Run: `pnpm build && pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/admin-templates.ts src/routes/admin-errors.ts src/routes/__tests__/admin-templates.test.ts src/app.ts
git commit -m "feat(api): template admin API with preview

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: Routing policy — repository, resolution, channel planning

**Files:**
- Create: `src/lib/policies/repo.ts`, `src/lib/policies/plan.ts`
- Test: `src/lib/policies/__tests__/plan.test.ts`, `src/lib/policies/__tests__/repo.integration.test.ts`

**Interfaces:**
- Consumes: `getDb`, `notificationPolicy`, `PolicyRow`, `PolicyChannel`, `PolicyMode`, `LifecycleStatus` (Task 3); `TemplateError` (Task 4); `hasActiveTemplate` (Task 6); `channelVendor`, `currentNetwork` (Task 2).
- Produces:
  - `interface PolicyDraftInput { domain?: string | null; eventType?: string | null; mode: PolicyMode; channels: PolicyChannel[] }`
  - `createPolicyDraft(input, actor): Promise<PolicyRow>`; `updatePolicyDraft(id, patch: { mode?: PolicyMode; channels?: PolicyChannel[] }): Promise<PolicyRow>`; `publishPolicy(id, actor): Promise<PolicyRow>`; `retirePolicy(id): Promise<PolicyRow>`; `getPolicy(id): Promise<PolicyRow>`; `listPolicies(filter: { domain?: string; eventType?: string; status?: LifecycleStatus }): Promise<PolicyRow[]>`
  - `resolvePolicy(domain: string | undefined, eventType: string | undefined): Promise<PolicyRow | null>` — precedence `(domain, event)` → `(NULL, event)` → `(domain, NULL)` → `(NULL, NULL)`
  - `interface Contacts { email?: string; phone?: string }`
  - `planDelivery(policy: Pick<PolicyRow, 'mode' | 'channels'>, contacts: Contacts): { mode: PolicyMode; candidates: PolicyChannel[] }` (in `plan.ts`)
  - `CHANNEL_CONTACT: Record<string, keyof Contacts>` = `{ email: 'email', sms: 'phone', whatsapp: 'phone' }`

Publish rules: `channels` non-empty; no channel listed twice; every channel has a provider (`unknown_channel`); every `(channel, template_key)` has an active template in this network (`incomplete_template`, `details: { channel, template_key }`).

- [ ] **Step 1: Write the failing tests**

`src/lib/policies/__tests__/plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { planDelivery } from '../plan';

const policy = (mode: 'first_available' | 'all') => ({
  mode,
  channels: [
    { channel: 'sms', template_key: 'otp_sms' },
    { channel: 'email', template_key: 'otp_email' },
    { channel: 'whatsapp', template_key: 'otp_wa' },
  ],
});

describe('planDelivery', () => {
  it('keeps policy order and drops channels the caller has no contact point for', () => {
    expect(planDelivery(policy('first_available'), { email: 'a@b.c' })).toEqual({
      mode: 'first_available', candidates: [{ channel: 'email', template_key: 'otp_email' }],
    });
  });
  it('phone-only recipients get the phone channels in order', () => {
    expect(planDelivery(policy('all'), { phone: '+919999999999' }).candidates.map((c) => c.channel)).toEqual(['sms', 'whatsapp']);
  });
  it('no reachable channel → no candidates', () => {
    expect(planDelivery(policy('all'), {}).candidates).toEqual([]);
  });
  it('treats blank contact points as absent and unknown channels as unreachable', () => {
    expect(planDelivery({ mode: 'all', channels: [{ channel: 'fax', template_key: 'x' }, { channel: 'email', template_key: 'e' }] }, { email: ' ' }).candidates).toEqual([]);
  });
});
```

`src/lib/policies/__tests__/repo.integration.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../templates/vendors', () => ({
  channelVendor: (c: string) =>
    c === 'sms' ? { vendor: 'msg91', renders: 'provider' } : c === 'email' ? { vendor: 'smtp', renders: 'ns' } : undefined,
}));

import { closeDb, getPool } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { createTemplateDraft, publishTemplate } from '../../templates/repo';
import { createPolicyDraft, getPolicy, publishPolicy, resolvePolicy, retirePolicy, updatePolicyDraft } from '../repo';
import { TemplateError } from '../../templates/errors';

process.env.NS_NETWORK = 'test_net';

beforeAll(async () => { await runMigrations(); });
afterAll(async () => { await closeDb(); });
beforeEach(async () => {
  await getPool().query(`DELETE FROM notification_policy; DELETE FROM template;`);
  const t = await createTemplateDraft({ channel: 'sms', templateKey: 'otp_sms', providerTemplateId: 'flow-1' }, 'a');
  await publishTemplate(t.id, 'a');
});

async function codeOf(p: Promise<unknown>) {
  try { await p; return undefined; } catch (e) { return (e as TemplateError).code; }
}
const sms = [{ channel: 'sms', template_key: 'otp_sms' }];
async function active(domain: string | null, eventType: string | null, key = 'otp_sms') {
  const p = await createPolicyDraft({ domain, eventType, mode: 'first_available', channels: [{ channel: 'sms', template_key: key }] }, 'a');
  return publishPolicy(p.id, 'a');
}

describe('policy repository', () => {
  it('publish requires an active template per channel', async () => {
    const p = await createPolicyDraft({ eventType: 'apply', mode: 'all', channels: [{ channel: 'email', template_key: 'nope' }] }, 'a');
    expect(await codeOf(publishPolicy(p.id, 'a'))).toBe('incomplete_template');
    expect((await getPolicy(p.id)).status).toBe('draft');
  });

  it('rejects empty, duplicated and unknown channels', async () => {
    const empty = await createPolicyDraft({ mode: 'all', channels: [] }, 'a');
    expect(await codeOf(publishPolicy(empty.id, 'a'))).toBe('incomplete_template');
    const dup = await createPolicyDraft({ mode: 'all', channels: [...sms, ...sms] }, 'a');
    expect(await codeOf(publishPolicy(dup.id, 'a'))).toBe('invalid_contract');
    const fax = await createPolicyDraft({ mode: 'all', channels: [{ channel: 'fax', template_key: 'x' }] }, 'a');
    expect(await codeOf(publishPolicy(fax.id, 'a'))).toBe('unknown_channel');
  });

  it('most specific wins: (domain,event) > (null,event) > (domain,null) > (null,null)', async () => {
    const def = await active(null, null);
    expect((await resolvePolicy('seeker', 'apply'))?.id).toBe(def.id);
    const dom = await active('seeker', null);
    expect((await resolvePolicy('seeker', 'apply'))?.id).toBe(dom.id);
    const evt = await active(null, 'apply');
    expect((await resolvePolicy('seeker', 'apply'))?.id).toBe(evt.id);
    const exact = await active('seeker', 'apply');
    expect((await resolvePolicy('seeker', 'apply'))?.id).toBe(exact.id);
    expect((await resolvePolicy('provider', 'apply'))?.id).toBe(evt.id);
    expect((await resolvePolicy(undefined, 'shortlist'))?.id).toBe(def.id);
  });

  it('no policy at all → null', async () => {
    expect(await resolvePolicy('seeker', 'apply')).toBeNull();
  });

  it('publishing retires the previous active policy for the same scope; drafts only are editable', async () => {
    const v1 = await active(null, 'apply');
    const v2 = await active(null, 'apply');
    expect((await getPolicy(v1.id)).status).toBe('retired');
    expect(await codeOf(updatePolicyDraft(v2.id, { mode: 'all' }))).toBe('invalid_state');
    expect((await retirePolicy(v2.id)).status).toBe('retired');
    expect(await resolvePolicy(undefined, 'apply')).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/lib/policies` and the integration command.
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `plan.ts`**

```ts
import type { PolicyChannel, PolicyMode, PolicyRow } from '../db/schema';

export interface Contacts {
  email?: string;
  phone?: string;
}

/** Which contact point each channel needs. NS holds no user directory: callers pass what they have. */
export const CHANNEL_CONTACT: Record<string, keyof Contacts> = {
  email: 'email',
  sms: 'phone',
  whatsapp: 'phone',
};

/**
 * The channels a send may use, in policy order, filtered to the contact points
 * the caller supplied. `first_available` tries them in order; `all` fans out.
 */
export function planDelivery(
  policy: Pick<PolicyRow, 'mode' | 'channels'>,
  contacts: Contacts,
): { mode: PolicyMode; candidates: PolicyChannel[] } {
  const candidates = policy.channels.filter((c) => {
    const need = CHANNEL_CONTACT[c.channel];
    return need !== undefined && Boolean(contacts[need]?.trim());
  });
  return { mode: policy.mode, candidates };
}
```

- [ ] **Step 4: Implement `repo.ts`**

```ts
import { and, eq, isNull, max, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../db/client';
import { notificationPolicy, type LifecycleStatus, type PolicyChannel, type PolicyMode, type PolicyRow } from '../db/schema';
import { currentNetwork } from '../network';
import { TemplateError } from '../templates/errors';
import { hasActiveTemplate } from '../templates/repo';
import { channelVendor } from '../templates/vendors';

export interface PolicyDraftInput {
  domain?: string | null;
  eventType?: string | null;
  mode: PolicyMode;
  channels: PolicyChannel[];
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

const scopeEq = (col: typeof notificationPolicy.domain | typeof notificationPolicy.eventType, v: string | null | undefined): SQL =>
  v == null ? isNull(col) : eq(col, v);

async function lockScope(tx: Tx, network: string, domain: string | null, eventType: string | null) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`policy:${network}:${domain ?? ''}:${eventType ?? ''}`}))`);
}

async function loadForUpdate(tx: Tx, id: string): Promise<PolicyRow> {
  const rows = await tx
    .select()
    .from(notificationPolicy)
    .where(and(eq(notificationPolicy.id, id), eq(notificationPolicy.network, currentNetwork())))
    .for('update');
  if (!rows[0]) throw new TemplateError('not_found', 'policy not found');
  return rows[0];
}

export async function createPolicyDraft(input: PolicyDraftInput, actor: string): Promise<PolicyRow> {
  const network = currentNetwork();
  const domain = input.domain ?? null;
  const eventType = input.eventType ?? null;
  return getDb().transaction(async (tx) => {
    await lockScope(tx, network, domain, eventType);
    const [{ v }] = await tx
      .select({ v: max(notificationPolicy.version) })
      .from(notificationPolicy)
      .where(and(eq(notificationPolicy.network, network), scopeEq(notificationPolicy.domain, domain), scopeEq(notificationPolicy.eventType, eventType)));
    const [row] = await tx
      .insert(notificationPolicy)
      .values({ network, domain, eventType, mode: input.mode, channels: input.channels, version: (v ?? 0) + 1, status: 'draft', createdBy: actor })
      .returning();
    return row!;
  });
}

export async function updatePolicyDraft(id: string, patch: { mode?: PolicyMode; channels?: PolicyChannel[] }): Promise<PolicyRow> {
  return getDb().transaction(async (tx) => {
    const current = await loadForUpdate(tx, id);
    if (current.status !== 'draft') throw new TemplateError('invalid_state', `only drafts can be edited; this one is ${current.status}`);
    const [row] = await tx.update(notificationPolicy).set({ ...patch, updatedAt: new Date() }).where(eq(notificationPolicy.id, id)).returning();
    return row!;
  });
}

async function validatePolicy(p: PolicyRow): Promise<void> {
  if (p.channels.length === 0) throw new TemplateError('incomplete_template', 'a policy needs at least one channel');
  const seen = new Set<string>();
  for (const c of p.channels) {
    if (seen.has(c.channel)) throw new TemplateError('invalid_contract', `channel ${c.channel} listed twice`);
    seen.add(c.channel);
    if (!channelVendor(c.channel)) throw new TemplateError('unknown_channel', `no provider for channel ${c.channel}`);
    if (!(await hasActiveTemplate(c.channel, c.template_key))) {
      throw new TemplateError('incomplete_template', `no active ${c.channel} template ${c.template_key}`, {
        channel: c.channel, template_key: c.template_key,
      });
    }
  }
}

export async function publishPolicy(id: string, actor: string): Promise<PolicyRow> {
  return getDb().transaction(async (tx) => {
    const peek = await loadForUpdate(tx, id);
    await lockScope(tx, peek.network, peek.domain, peek.eventType);
    const current = await loadForUpdate(tx, id);
    if (current.status !== 'draft') throw new TemplateError('invalid_state', `only drafts can be published; this one is ${current.status}`);
    await validatePolicy(current);
    const now = new Date();
    await tx
      .update(notificationPolicy)
      .set({ status: 'retired', retiredAt: now, updatedAt: now })
      .where(and(
        eq(notificationPolicy.network, current.network),
        scopeEq(notificationPolicy.domain, current.domain),
        scopeEq(notificationPolicy.eventType, current.eventType),
        eq(notificationPolicy.status, 'active'),
      ));
    const [row] = await tx
      .update(notificationPolicy)
      .set({ status: 'active', publishedAt: now, publishedBy: actor, updatedAt: now })
      .where(eq(notificationPolicy.id, id))
      .returning();
    return row!;
  });
}

export async function retirePolicy(id: string): Promise<PolicyRow> {
  return getDb().transaction(async (tx) => {
    const current = await loadForUpdate(tx, id);
    if (current.status === 'retired') throw new TemplateError('invalid_state', 'already retired');
    const now = new Date();
    const [row] = await tx.update(notificationPolicy).set({ status: 'retired', retiredAt: now, updatedAt: now }).where(eq(notificationPolicy.id, id)).returning();
    return row!;
  });
}

export async function getPolicy(id: string): Promise<PolicyRow> {
  const rows = await getDb().select().from(notificationPolicy).where(and(eq(notificationPolicy.id, id), eq(notificationPolicy.network, currentNetwork())));
  if (!rows[0]) throw new TemplateError('not_found', 'policy not found');
  return rows[0];
}

export async function listPolicies(filter: { domain?: string; eventType?: string; status?: LifecycleStatus }): Promise<PolicyRow[]> {
  const conds = [eq(notificationPolicy.network, currentNetwork())];
  if (filter.domain) conds.push(eq(notificationPolicy.domain, filter.domain));
  if (filter.eventType) conds.push(eq(notificationPolicy.eventType, filter.eventType));
  if (filter.status) conds.push(eq(notificationPolicy.status, filter.status));
  return getDb().select().from(notificationPolicy).where(and(...conds)).orderBy(notificationPolicy.eventType, notificationPolicy.domain, notificationPolicy.version);
}

/** Specificity rank of an active policy for (domain, eventType); lower wins. */
function rank(p: PolicyRow): number {
  if (p.domain !== null && p.eventType !== null) return 0;
  if (p.domain === null && p.eventType !== null) return 1;
  if (p.domain !== null && p.eventType === null) return 2;
  return 3;
}

/**
 * The active policy for a send. Most specific wins:
 * (domain, event) → (any domain, event) → (domain, any event) → network default.
 */
export async function resolvePolicy(domain: string | undefined, eventType: string | undefined): Promise<PolicyRow | null> {
  const d = domain ?? null;
  const e = eventType ?? null;
  const domainMatch = d === null ? isNull(notificationPolicy.domain) : or(isNull(notificationPolicy.domain), eq(notificationPolicy.domain, d));
  const eventMatch = e === null ? isNull(notificationPolicy.eventType) : or(isNull(notificationPolicy.eventType), eq(notificationPolicy.eventType, e));
  const rows = await getDb()
    .select()
    .from(notificationPolicy)
    .where(and(eq(notificationPolicy.network, currentNetwork()), eq(notificationPolicy.status, 'active'), domainMatch, eventMatch));
  if (rows.length === 0) return null;
  return rows.sort((a, b) => rank(a) - rank(b))[0]!;
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm vitest run src/lib/policies` and the integration command.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/policies
git commit -m "feat(policies): routing policy lifecycle, most-specific-wins resolution and channel planning

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: Policy admin API

**Files:**
- Create: `src/routes/admin-policies.ts`
- Modify: `src/app.ts`
- Test: `src/routes/__tests__/admin-policies.test.ts`

**Interfaces:**
- Consumes: policy repo (Task 8), `sendAdminError` (Task 7), `requestAuth`, `requireAdmin`.
- Produces: `adminPolicyRoutes(app)`; `serializePolicy(row: PolicyRow)` → `{ id, network, domain, event_type, version, status, mode, channels, created_by, published_by, created_at, updated_at, published_at, retired_at }`.

Routes (all `preHandler: [requestAuth, requireAdmin]`): `GET /v1/admin/policies?domain&event_type&status` → `{ policies }`; `GET /v1/admin/policies/:id`; `POST /v1/admin/policies` `{ domain?, event_type?, mode, channels: [{channel, template_key}] }` → 201; `PATCH /v1/admin/policies/:id` `{ mode?, channels? }` (strict); `POST /v1/admin/policies/:id/publish`; `POST /v1/admin/policies/:id/retire`.

Body schema: `domain` and `event_type` `z.string().regex(/^[a-z0-9_.-]+$/).max(64).nullable().optional()`; `mode` `z.enum(['first_available','all'])`; `channels` `z.array(z.object({ channel: z.string().min(1).max(32), template_key: z.string().regex(/^[a-z0-9_.-]+$/).max(128) }).strict()).max(10)`.

- [ ] **Step 1: Write the failing tests**

`src/routes/__tests__/admin-policies.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../plugins/request-auth', () => ({ requestAuth: async () => {} }));
const repo = vi.hoisted(() => ({
  createPolicyDraft: vi.fn(), updatePolicyDraft: vi.fn(), publishPolicy: vi.fn(),
  retirePolicy: vi.fn(), getPolicy: vi.fn(), listPolicies: vi.fn(),
}));
vi.mock('../../lib/policies/repo', () => repo);

const Fastify = (await import('fastify')).default;
const { adminPolicyRoutes } = await import('../admin-policies');
const { TemplateError } = await import('../../lib/templates/errors');

const ID = '00000000-0000-4000-8000-000000000002';
const row = {
  id: ID, network: 'n', domain: null, eventType: 'apply', version: 1, status: 'draft', mode: 'first_available',
  channels: [{ channel: 'sms', template_key: 'apply_sms' }], createdBy: 'ns-admin', publishedBy: null,
  createdAt: new Date(), updatedAt: new Date(), publishedAt: null, retiredAt: null,
};
const admin = { 'x-ns-key': 'ns-admin' };
async function build() {
  const app = Fastify({ logger: false });
  await app.register(adminPolicyRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  process.env.NS_ADMIN_KEY_IDS = 'ns-admin';
  Object.values(repo).forEach((f) => f.mockReset());
});

describe('admin policy routes', () => {
  it('403s a non-admin key', async () => {
    const res = await (await build()).inject({ method: 'GET', url: '/v1/admin/policies', headers: { 'x-ns-key': 'x' } });
    expect(res.statusCode).toBe(403);
  });

  it('creates a draft', async () => {
    repo.createPolicyDraft.mockResolvedValue(row);
    const res = await (await build()).inject({
      method: 'POST', url: '/v1/admin/policies', headers: admin,
      payload: { event_type: 'apply', mode: 'first_available', channels: [{ channel: 'sms', template_key: 'apply_sms' }] },
    });
    expect(res.statusCode).toBe(201);
    expect(repo.createPolicyDraft).toHaveBeenCalledWith(
      { domain: undefined, eventType: 'apply', mode: 'first_available', channels: [{ channel: 'sms', template_key: 'apply_sms' }] },
      'ns-admin',
    );
    expect(res.json()).toMatchObject({ id: ID, event_type: 'apply', domain: null });
  });

  it('rejects an unknown mode and a network in the body', async () => {
    const app = await build();
    expect((await app.inject({ method: 'POST', url: '/v1/admin/policies', headers: admin, payload: { mode: 'broadcast', channels: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/admin/policies', headers: admin, payload: { network: 'x', mode: 'all', channels: [] } })).statusCode).toBe(400);
  });

  it('reports a publish validation failure as 422 with details', async () => {
    repo.publishPolicy.mockRejectedValue(new TemplateError('incomplete_template', 'no active sms template apply_sms', { channel: 'sms', template_key: 'apply_sms' }));
    const res = await (await build()).inject({ method: 'POST', url: `/v1/admin/policies/${ID}/publish`, headers: admin });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'incomplete_template', details: { channel: 'sms' } });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/routes/__tests__/admin-policies.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `admin-policies.ts`**

```ts
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PolicyRow } from '../lib/db/schema';
import * as repo from '../lib/policies/repo';
import { requestAuth } from '../plugins/request-auth';
import { requireAdmin } from '../plugins/require-admin';
import { sendAdminError } from './admin-errors';

const Slug = (max: number) => z.string().regex(/^[a-z0-9_.-]+$/).max(max);
const Channels = z.array(z.object({ channel: z.string().min(1).max(32), template_key: Slug(128) }).strict()).max(10);
const Mode = z.enum(['first_available', 'all']);

const CreateSchema = z
  .object({ domain: Slug(64).nullable().optional(), event_type: Slug(64).nullable().optional(), mode: Mode, channels: Channels })
  .strict();
const PatchSchema = z.object({ mode: Mode.optional(), channels: Channels.optional() }).strict();
const ListQuery = z.object({ domain: z.string().optional(), event_type: z.string().optional(), status: z.enum(['draft', 'active', 'retired']).optional() });
const IdParams = z.object({ id: z.uuid() });

export function serializePolicy(p: PolicyRow) {
  return {
    id: p.id, network: p.network, domain: p.domain, event_type: p.eventType, version: p.version,
    status: p.status, mode: p.mode, channels: p.channels, created_by: p.createdBy,
    published_by: p.publishedBy, created_at: p.createdAt, updated_at: p.updatedAt,
    published_at: p.publishedAt, retired_at: p.retiredAt,
  };
}

const actorOf = (headers: Record<string, unknown>) => String(headers['x-ns-key']);

export async function adminPolicyRoutes(app: FastifyInstance) {
  const preHandler = [requestAuth, requireAdmin];

  app.get('/v1/admin/policies', { preHandler }, async (req, reply) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send(z.formatError(q.error));
    try {
      const rows = await repo.listPolicies({ domain: q.data.domain, eventType: q.data.event_type, status: q.data.status });
      return { policies: rows.map(serializePolicy) };
    } catch (err) { return sendAdminError(reply, err); }
  });

  app.get('/v1/admin/policies/:id', { preHandler }, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    if (!p.success) return reply.code(400).send(z.formatError(p.error));
    try { return serializePolicy(await repo.getPolicy(p.data.id)); }
    catch (err) { return sendAdminError(reply, err); }
  });

  app.post('/v1/admin/policies', { preHandler }, async (req, reply) => {
    const b = CreateSchema.safeParse(req.body);
    if (!b.success) return reply.code(400).send(z.formatError(b.error));
    try {
      const row = await repo.createPolicyDraft(
        { domain: b.data.domain, eventType: b.data.event_type, mode: b.data.mode, channels: b.data.channels },
        actorOf(req.headers),
      );
      return reply.code(201).send(serializePolicy(row));
    } catch (err) { return sendAdminError(reply, err); }
  });

  app.patch('/v1/admin/policies/:id', { preHandler }, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    const b = PatchSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send(z.formatError(p.error));
    if (!b.success) return reply.code(400).send(z.formatError(b.error));
    try { return serializePolicy(await repo.updatePolicyDraft(p.data.id, b.data)); }
    catch (err) { return sendAdminError(reply, err); }
  });

  app.post('/v1/admin/policies/:id/publish', { preHandler }, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    if (!p.success) return reply.code(400).send(z.formatError(p.error));
    try { return serializePolicy(await repo.publishPolicy(p.data.id, actorOf(req.headers))); }
    catch (err) { return sendAdminError(reply, err); }
  });

  app.post('/v1/admin/policies/:id/retire', { preHandler }, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    if (!p.success) return reply.code(400).send(z.formatError(p.error));
    try { return serializePolicy(await repo.retirePolicy(p.data.id)); }
    catch (err) { return sendAdminError(reply, err); }
  });
}
```

- [ ] **Step 4: Register, run, commit**

In `src/app.ts`: `import { adminPolicyRoutes } from './routes/admin-policies';` and `app.register(adminPolicyRoutes);`.

Run: `pnpm build && pnpm test`
Expected: PASS.

```bash
git add src/routes/admin-policies.ts src/routes/__tests__/admin-policies.test.ts src/app.ts
git commit -m "feat(api): routing policy admin API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: Seed the built-in `login_otp` SMS template at boot

**Files:**
- Create: `src/lib/templates/seed.ts`
- Modify: `src/server.ts`
- Test: `src/lib/templates/__tests__/seed.integration.test.ts`

**Interfaces:**
- Consumes: `createTemplateDraft`, `publishTemplate`, `listTemplates` (Task 6); `providers` registry; `currentNetwork`, `NetworkNotConfigured`, `defaultLocale` (Task 2).
- Produces: `seedBuiltinTemplates(): Promise<'seeded_active' | 'seeded_draft' | 'exists' | 'skipped_no_network' | 'skipped_no_id'>`

Rules: the SMS provider already names `login_otp` (`templates.login_otp`, plus `bodies.login_otp` for Pinnacle). If any `sms/login_otp` row exists in this network (any status, any locale) → `exists` (never overwrite an admin's work). If `NS_NETWORK` is unset → `skipped_no_network`. If the provider's id is empty → `skipped_no_id` (log that `login_otp` must be configured). Otherwise create a draft in the default locale with `providerTemplateId = templates.login_otp`, `bodyText = bodies.login_otp || process.env.SMS_LOGIN_OTP_BODY || null`, `variables = [{ name: 'message', required: true, type: 'string', sensitive: true, raw: false }]`, actor `system:seed`; try to publish — `seeded_active` on success, `seeded_draft` (logged with the `TemplateError` code) if publish validation fails. Boot calls it after migrations and recovery; any thrown error is logged and boot continues.

- [ ] **Step 1: Write the failing integration test**

`src/lib/templates/__tests__/seed.integration.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sms = vi.hoisted(() => ({
  current: { name: 'sms', vendor: 'msg91', renders: 'provider', templates: { login_otp: 'flow-otp' }, bodies: undefined as Record<string, string> | undefined },
}));
vi.mock('../../providers', () => ({ providers: { get sms() { return sms.current; } } }));
vi.mock('../vendors', () => ({ channelVendor: (c: string) => (c === 'sms' ? { vendor: sms.current.vendor, renders: sms.current.renders } : undefined) }));

import { closeDb, getPool } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { listTemplates, createTemplateDraft } from '../repo';
import { seedBuiltinTemplates } from '../seed';

beforeAll(async () => { await runMigrations(); });
afterAll(async () => { await closeDb(); });
beforeEach(async () => {
  process.env.NS_NETWORK = 'test_net';
  delete process.env.SMS_LOGIN_OTP_BODY;
  sms.current = { name: 'sms', vendor: 'msg91', renders: 'provider', templates: { login_otp: 'flow-otp' }, bodies: undefined };
  await getPool().query(`DELETE FROM notification_policy; DELETE FROM template;`);
});

describe('seedBuiltinTemplates', () => {
  it('seeds an active msg91 login_otp from the provider id', async () => {
    expect(await seedBuiltinTemplates()).toBe('seeded_active');
    const [t] = await listTemplates({ channel: 'sms', templateKey: 'login_otp' });
    expect(t).toMatchObject({ status: 'active', provider: 'msg91', providerTemplateId: 'flow-otp', createdBy: 'system:seed' });
    expect(t!.variables).toEqual([{ name: 'message', required: true, type: 'string', sensitive: true, raw: false }]);
  });

  it('seeds pinnacle with its body', async () => {
    sms.current = { name: 'sms', vendor: 'pinnacle', renders: 'ns', templates: { login_otp: '1107' }, bodies: { login_otp: '{{message}} is your OTP' } };
    expect(await seedBuiltinTemplates()).toBe('seeded_active');
    const [t] = await listTemplates({ channel: 'sms', templateKey: 'login_otp' });
    expect(t!.bodyText).toBe('{{message}} is your OTP');
  });

  it('leaves an invalid seed as a draft', async () => {
    sms.current = { name: 'sms', vendor: 'pinnacle', renders: 'ns', templates: { login_otp: '1107' }, bodies: { login_otp: '' } };
    expect(await seedBuiltinTemplates()).toBe('seeded_draft');
  });

  it('never touches an existing login_otp', async () => {
    await createTemplateDraft({ channel: 'sms', templateKey: 'login_otp', providerTemplateId: 'admin-made' }, 'admin');
    expect(await seedBuiltinTemplates()).toBe('exists');
    expect(await listTemplates({ templateKey: 'login_otp' })).toHaveLength(1);
  });

  it('skips without a network or an id', async () => {
    delete process.env.NS_NETWORK;
    expect(await seedBuiltinTemplates()).toBe('skipped_no_network');
    process.env.NS_NETWORK = 'test_net';
    sms.current = { ...sms.current, templates: { login_otp: '' } };
    expect(await seedBuiltinTemplates()).toBe('skipped_no_id');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run the integration command.
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `seed.ts`**

```ts
import { providers } from '../providers';
import { currentNetwork, NetworkNotConfigured } from '../network';
import { TemplateError } from './errors';
import { createTemplateDraft, listTemplates, publishTemplate } from './repo';

type SeedOutcome = 'seeded_active' | 'seeded_draft' | 'exists' | 'skipped_no_network' | 'skipped_no_id';

/**
 * Bring the one template NS already names — `login_otp` on SMS — into the
 * registry, so login OTP resolves through it from the first deploy. Runs every
 * boot and does nothing once any login_otp row exists: an admin's edits always
 * win over environment defaults.
 */
export async function seedBuiltinTemplates(): Promise<SeedOutcome> {
  try {
    currentNetwork();
  } catch (e) {
    if (e instanceof NetworkNotConfigured) return 'skipped_no_network';
    throw e;
  }
  const existing = await listTemplates({ channel: 'sms', templateKey: 'login_otp' });
  if (existing.length > 0) return 'exists';

  const sms = providers.sms;
  const id = sms?.templates.login_otp;
  if (!sms || !id) {
    console.log('login_otp is not configured for the SMS provider; template not seeded');
    return 'skipped_no_id';
  }

  const draft = await createTemplateDraft(
    {
      channel: 'sms',
      templateKey: 'login_otp',
      providerTemplateId: id,
      bodyText: sms.bodies?.login_otp || process.env.SMS_LOGIN_OTP_BODY || null,
      variables: [{ name: 'message', required: true, type: 'string', sensitive: true, raw: false }],
    },
    'system:seed',
  );
  try {
    await publishTemplate(draft.id, 'system:seed');
    return 'seeded_active';
  } catch (e) {
    if (e instanceof TemplateError) {
      console.log(`login_otp seeded as a draft: ${e.code}`);
      return 'seeded_draft';
    }
    throw e;
  }
}
```

- [ ] **Step 4: Call it at boot**

In `src/server.ts`, after `await recoverAtBoot();` (Plan A's non-fatal recovery) and before `app.listen`:

```ts
  // Non-fatal: a seeding problem must never keep NS from sending.
  await seedBuiltinTemplates()
    .then((outcome) => console.log(`Built-in templates: ${outcome}`))
    .catch((err) => console.error('Built-in template seeding failed:', describeDbError(err)));
```

with `import { seedBuiltinTemplates } from './lib/templates/seed.js';` (and `describeDbError` is already imported there by Plan A; import it from `./lib/db/errors.js` if not).

- [ ] **Step 5: Run and commit**

Run: `pnpm build && pnpm test` and the integration command.
Expected: PASS.

```bash
git add src/lib/templates/seed.ts src/lib/templates/__tests__/seed.integration.test.ts src/server.ts
git commit -m "feat(templates): seed the built-in login_otp SMS template at boot

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: OpenAPI and documentation

**Files:**
- Modify: `src/lib/utils/openapi.ts`, `CLAUDE.md`, `README.md`, `example.env`
- Test: `src/lib/utils/__tests__/openapi.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

`src/lib/utils/__tests__/openapi.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../providers', () => ({ providers: {} }));
import { openApiDocument } from '../openapi';

describe('openApiDocument', () => {
  it('documents the admin API with an admin security requirement', () => {
    const doc = openApiDocument() as { paths: Record<string, Record<string, { security?: unknown[] }>> };
    for (const path of [
      '/v1/admin/templates', '/v1/admin/templates/{id}', '/v1/admin/templates/{id}/publish',
      '/v1/admin/templates/{id}/retire', '/v1/admin/templates/{id}/preview',
      '/v1/admin/policies', '/v1/admin/policies/{id}', '/v1/admin/policies/{id}/publish', '/v1/admin/policies/{id}/retire',
    ]) {
      expect(doc.paths[path], path).toBeDefined();
      for (const op of Object.values(doc.paths[path]!)) {
        expect(op.security).toEqual([{ requestSignature: [], adminKey: [] }]);
      }
    }
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run src/lib/utils/__tests__/openapi.test.ts`
Expected: FAIL — paths undefined.

- [ ] **Step 3: Add the paths**

In `openapi.ts`, add a `securitySchemes.adminKey` entry beside the existing `requestSignature` scheme (an `apiKey` in header `X-NS-Key` whose description says the key id must be listed in `NS_ADMIN_KEY_IDS`), and add one entry per path/method above with `security: [{ requestSignature: [], adminKey: [] }]`, a `summary`, `tags: ['admin']`, request body schemas mirroring Task 7/9's Zod schemas (snake_case fields, `variables` items `{ name, required, type, sensitive, raw, urlHosts }`), and responses `200/201`, `400`, `403`, `404`, `409`, `422`, `503` with `{ error, message?, details? }` for the error shapes. Keep the file's existing style.

- [ ] **Step 4: Docs**

- `CLAUDE.md`: a new **Templates and policies** section — tables and lifecycle (immutable once active, one active per key, publish retires the previous version under an advisory lock); vendor rule and `renders`; variable contract and send-time validation; email escaping and `raw`; SMS byte-exact bodies and length limits; locale fallback; policy precedence and `planDelivery`; admin scope (`NS_ADMIN_KEY_IDS`, interim until #62); `NS_NETWORK` now required for the admin API and seeding; `login_otp` seeding rule. Add `vendor`/`renders` to the *Adding a provider* steps. Update the test count line.
- `README.md`: an *Admin API* subsection with the route table from Tasks 7 and 9 and a curl example creating, previewing and publishing a template.
- `example.env`: `NS_NETWORK`, `NS_DEFAULT_LOCALE`, `NS_ADMIN_KEY_IDS` with one-line comments.

- [ ] **Step 5: Run and commit**

Run: `pnpm build && pnpm test`
Expected: PASS.

```bash
git add src/lib/utils CLAUDE.md README.md example.env
git commit -m "docs: template and policy admin API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Done when

- `bluedots-automation`: the NS ConfigMap renders `NS_NETWORK` (and `NS_ADMIN_KEY_IDS` when set); the tfpl yields one `notification-service:` key with or without RDS.
- `notification-service`: `pnpm build`, `pnpm test`, `pnpm test:integration` green; an admin key can create, preview, publish and retire templates and policies over HTTP; a non-admin key gets `403`; boot seeds `login_otp`.
- `/notify` behaviour is unchanged (Plan C wires `resolveTemplate`, `renderTemplate`, `resolvePolicy` and `planDelivery` into `/v1/notify`).
