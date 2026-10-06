# NS Stage 1 Plan F1 — Template Catalogue: Seed at Boot, Export on Demand

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a deployment come up with its full set of templates and routing policies from one mounted *catalogue* file, created only where nothing exists yet. Add an admin export that produces the same file from the live store.

**Architecture:**
- **The catalogue format.** A catalogue is one JSON document (`{ version, templates[], policies[] }`). Its entries use exactly the same fields as the admin create bodies, and both use the same schemas.
- **Seeding at boot.** If `NS_SEED_FILE` is set, the API creates and publishes each entry that has no row yet, in the same locked seeding step that seeds `login_otp` today. An existing row of any status is never touched, so admin edits always win. The catalogue only bootstraps an empty deployment; the NS template store stays the source of truth for copy.
- **Export.** `GET /v1/admin/export` returns the active templates and policies in the same format. Feeding that output back in reproduces the store, so the export can be used for backup and for promoting copy between environments.

**Tech Stack:** Fastify 5, TypeScript 7 (CommonJS, Node16), Zod 4, Drizzle, Postgres, vitest 4, pnpm 10.

**Spec:** `docs/superpowers/specs/2026-06-26-event-platform-design.md` (rev 2026-10-04), §Templates and routing, §Stages item 9. Issues: notification-service#57, #58, and signals-dpg#496 (which needs Signals' copy seeded as NS templates and policies).

**Plan F context (decided 2026-10-06):** Plan F is four plans that ship as one release.
- **F1 (this plan, notification-service):** additive only; it breaks nothing.
- **F2 (signals-dpg + bluedots-schemas):** Signals sends `event_type` + `domain` to `/v1/notify`, generates per-network catalogues from its current copy, and deletes its own email rendering.
- **F3 (keycloak-otp-authenticator):** HMAC v2 + `/v1/notify` for SMS, and email OTP through NS.
- **F4 (bluedots-e2e + bluedots-automation + notification-service):** the chart mounts the catalogue, e2e asserts on delivered mail, and NS deletes legacy `/notify` and HMAC v1.

## Global Constraints

- **Copy lives in NS.** The catalogue only seeds what is absent. It never updates, retires or replaces an existing template or policy, of any status. After seeding, changes go through the admin API.
- **One vendor per channel per deployment.** A catalogue template entry may name a `provider`. An entry for a vendor this deployment does not use is skipped, so one catalogue can carry both msg91 and pinnacle variants of an SMS template. An entry without `provider` is for the deployment's vendor.
- **Field rules are the admin create rules.** The catalogue entry schemas *are* the admin create schemas. A catalogue cannot contain anything the admin API would refuse.
- **Publish validation applies.** A seeded template or policy that fails publish validation is left as a draft and logged by code, without values. Seeding never blocks the boot. A missing, unreadable or invalid catalogue file is logged and skipped.
- **Order.** Templates are seeded before policies, because a policy publish requires its templates to be active. `login_otp` env seeding still runs first; a catalogue `login_otp` SMS entry is then skipped as "exists".
- **Locking.** Seeding runs under the existing session advisory lock `notification-service:seed`, so replicas booting together cannot double-create.
- **Size.** The catalogue file is at most 1 MiB (a ConfigMap's limit) and holds at most 500 templates and 500 policies.
- **Export.** `GET /v1/admin/export` requires `templates:admin`. It returns active rows only, for the current network, and only templates for the deployment's current vendors. Its output must parse as a catalogue.
- **Standing rules.** Public repo: state rules positively. Never log template bodies or variable values. CommonJS with extensionless imports in `src/lib`. Never run `vitest --root /`. Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Branch.** `feat/ns-catalogue-seed` off `feat/ns-retention-90d` (PR #154). Worktree `.worktrees/ns-plan-f1/notification-service`. Never push without approval.

### Rulings made while writing this plan (review these)

- **F1-1 — seed-if-absent, not sync.**
  - The catalogue never overwrites. The only other way to keep a file and a live store aligned is full sync, which would make the file the source of truth and silently revert admin edits on every restart. That contradicts "copy lives in NS".
  - **Existence is keyed as follows:** a template by `(network, channel, template_key, locale, provider)`, so a vendor switch still seeds the new vendor's rows, matching `login_otp` seeding. A policy by `(network, domain, event_type)`.
- **F1-2 — seeding happens at boot only.**
  - There is no reload loop. A catalogue change reaches a cluster at the next rollout. That is enough for a bootstrap file, and it avoids a second writer racing admin edits.
- **F1-3 — export carries no identities or history.**
  - It emits the catalogue fields only: no ids, versions, `created_by` or timestamps. That keeps it a portable input for another environment. History stays in the database rows.

## Review Focus

1. **An admin already edited a seeded template, and the pod restarts.**
   - The catalogue must not touch it. That holds whether the template is active, has a newer draft, or was retired.
   - → Task 2 test "never overwrites: active, draft and retired rows all count as existing".
2. **The catalogue lists a policy whose template failed to publish.**
   - The template stays a draft, so the policy publish fails with `incomplete_template` or `not_found`. The policy stays a draft too, and boot continues.
   - → Task 2 test "a policy whose template is not active is left as a draft".
3. **A catalogue with one bad entry.**
   - Example: an unknown variable type, or a template key with uppercase.
   - The whole file is rejected with the failing path logged (no values), and nothing is seeded. A partial seed would leave policies pointing at missing templates.
   - → Task 1 test "rejects the whole file on one invalid entry".
4. **Two replicas boot at once.**
   - Each entry is created once. This is serialised on the existing advisory lock.
   - → Task 2 test "concurrent seeding creates each entry once".
5. **Export → seed round trip into an empty network.**
   - It reproduces the same active templates and policies, so an export can bootstrap another environment.
   - → Task 3 integration test "export output seeds an empty network to the same state".

---

## File Structure (notification-service)

| File | Responsibility |
|---|---|
| `src/lib/catalogue/schema.ts` (new) | `TemplateEntrySchema`, `PolicyEntrySchema`, `CatalogueSchema`, `parseCatalogue()`, and the shared `TemplateCreateSchema` / `PolicyCreateSchema` |
| `src/lib/catalogue/seed.ts` (new) | `seedCatalogue(catalogue)`, plus `loadCatalogueFile(path)` |
| `src/lib/catalogue/export.ts` (new) | `exportCatalogue()` |
| `src/lib/templates/seed.ts` | Calls the catalogue seed under the existing lock, after `login_otp` |
| `src/routes/admin-templates.ts`, `src/routes/admin-policies.ts` | Import the create schemas from `catalogue/schema.ts` |
| `src/routes/admin-export.ts` (new), `src/app.ts` | `GET /v1/admin/export` |
| `src/lib/templates/repo.ts`, `src/lib/policies/repo.ts` | Exact-scope existence helpers |
| `src/__tests__/route-scopes.test.ts`, `src/lib/utils/openapi.ts`, `CLAUDE.md`, `README.md`, `example.env` | Wiring and docs |

---

### Task 1: Catalogue schema and parser

**Files:**
- Create: `src/lib/catalogue/schema.ts`, `src/lib/catalogue/__tests__/schema.test.ts`
- Modify: `src/routes/admin-templates.ts` and `src/routes/admin-policies.ts` (import the moved create schemas; behaviour unchanged)

**Interfaces:**
- Produces:
  - `TemplateCreateSchema`: moved verbatim from the admin templates route's `CreateSchema`.
  - `PolicyCreateSchema`: moved verbatim from the admin policies route's `CreateSchema`.
  - `TemplateEntrySchema = TemplateCreateSchema.extend({ provider: z.string().min(1).max(32).optional() }).strict()`
  - `PolicyEntrySchema = PolicyCreateSchema`
  - `CatalogueSchema = z.object({ version: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/), templates: z.array(TemplateEntrySchema).max(500).default([]), policies: z.array(PolicyEntrySchema).max(500).default([]) }).strict()`
  - `type Catalogue = z.infer<typeof CatalogueSchema>`
  - `parseCatalogue(raw: unknown): Catalogue`. It throws `Error('catalogue is invalid at: <paths>')`, naming paths only, never values.
  - Duplicate checks after parsing:
    - A duplicate template entry, same `(channel, template_key, locale ?? '', provider ?? '')`, throws.
    - A duplicate policy entry, same `(domain ?? '', event_type ?? '')`, throws.

- [ ] **Step 1: Write the failing tests** (`src/lib/catalogue/__tests__/schema.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { parseCatalogue } from '../schema';

const tpl = (over: Record<string, unknown> = {}) => ({
  channel: 'email',
  template_key: 'item.paused',
  subject: 'Your {{noun}} is paused',
  body_html: '<p>Hi {{name}}, your {{noun}} is paused.</p>',
  variables: [{ name: 'name' }, { name: 'noun' }],
  ...over,
});
const pol = (over: Record<string, unknown> = {}) => ({
  domain: 'seeker',
  event_type: 'item.paused',
  mode: 'first_available',
  channels: [{ channel: 'email', template_key: 'item.paused' }],
  ...over,
});

describe('parseCatalogue', () => {
  it('accepts templates and policies, defaulting empty lists', () => {
    const c = parseCatalogue({ version: '2026-10-06', templates: [tpl()], policies: [pol()] });
    expect(c.templates[0].template_key).toBe('item.paused');
    expect(c.templates[0].variables?.[0]).toMatchObject({ name: 'name', required: true, source: 'request' });
    expect(parseCatalogue({ version: 'v1' })).toEqual({ version: 'v1', templates: [], policies: [] });
  });

  it('allows a provider on template entries', () => {
    const c = parseCatalogue({ version: 'v1', templates: [tpl({ channel: 'sms', provider: 'pinnacle', body_html: undefined, body_text: 'x {{name}} {{noun}}' })] });
    expect(c.templates[0].provider).toBe('pinnacle');
  });

  it.each([
    [{ version: 'v1', templates: [tpl({ template_key: 'Item.Paused' })] }, 'templates.0.template_key'],
    [{ version: 'v1', templates: [tpl({ variables: [{ name: 'name', type: 'date' }] })] }, 'templates.0.variables'],
    [{ version: 'v1', templates: [tpl({ id: 'x' })] }, 'templates.0'],
    [{ version: 'v1', policies: [pol({ mode: 'single' })] }, 'policies.0.mode'],
    [{ version: 'bad version', templates: [] }, 'version'],
    [{ version: 'v1', extra: 1 }, '(root)'],
  ])('rejects the whole file on one invalid entry: %#', (raw, path) => {
    expect(() => parseCatalogue(raw)).toThrow(path);
  });

  it('never echoes values in the error', () => {
    try {
      parseCatalogue({ version: 'v1', templates: [tpl({ template_key: 'SECRET-VALUE-X' })] });
    } catch (e) {
      expect((e as Error).message).not.toContain('SECRET-VALUE-X');
    }
  });

  it('rejects duplicate template and policy entries', () => {
    expect(() => parseCatalogue({ version: 'v1', templates: [tpl(), tpl()] })).toThrow(/duplicate template/);
    expect(() => parseCatalogue({ version: 'v1', policies: [pol(), pol()] })).toThrow(/duplicate policy/);
    expect(() => parseCatalogue({ version: 'v1', templates: [tpl(), tpl({ locale: 'hi' })] })).not.toThrow();
  });

  it('caps list sizes', () => {
    const many = Array.from({ length: 501 }, (_, i) => tpl({ template_key: `k${i}` }));
    expect(() => parseCatalogue({ version: 'v1', templates: many })).toThrow('templates');
  });
});
```

Use `'(root)'` for issues with an empty path, as the content parser does.

- [ ] **Step 2: Run and confirm the tests fail.** Run `pnpm vitest run src/lib/catalogue`. Expected: FAIL, because the module is missing.

- [ ] **Step 3: Implement** `src/lib/catalogue/schema.ts`:

```ts
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
```

In `src/routes/admin-templates.ts`:
- Delete the local `nullableText`, `PatchSchema` and `CreateSchema`.
- Import `TemplatePatchSchema as PatchSchema` and `TemplateCreateSchema as CreateSchema` from `../lib/catalogue/schema`.

In `src/routes/admin-policies.ts`, do the same with `PolicyCreateSchema`, `PolicyModeSchema` and `PolicyChannelsSchema`. Keep its own `PatchSchema`, built from the imported pieces.

- [ ] **Step 4: Run.** `pnpm vitest run src/lib/catalogue src/routes`, then `pnpm build`, then `pnpm test`. Expected: all pass, with the admin route tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/lib/catalogue src/routes/admin-templates.ts src/routes/admin-policies.ts
git commit -m "feat(catalogue): catalogue schema shared with the admin create bodies

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Seed the catalogue at boot

**Files:**
- Create: `src/lib/catalogue/seed.ts`, `src/lib/catalogue/__tests__/seed.integration.test.ts`, `src/lib/catalogue/__tests__/load.test.ts`
- Modify:
  - `src/lib/templates/seed.ts`: run the catalogue seed inside the existing lock, after `login_otp`.
  - `src/lib/templates/repo.ts`: add `templateRowExists`.
  - `src/lib/policies/repo.ts`: add `policyRowExists`.
  - `src/lib/boot-config.ts`: no change; the seed file is not boot-fatal.

**Interfaces:**
- Consumes: `Catalogue`, `parseCatalogue` (Task 1); `createTemplateDraft`, `publishTemplate`, `createPolicyDraft`, `publishPolicy`; `channelVendor`.
- Produces:
  - `templateRowExists(channel: string, templateKey: string, locale: string, provider: string): Promise<boolean>`. Any status counts, for the current network.
  - `policyRowExists(domain: string | null, eventType: string | null): Promise<boolean>`. Any status counts, for the current network.
  - `interface SeedReport { templates: Record<'created_active' | 'created_draft' | 'exists' | 'skipped_vendor' | 'skipped_channel', number>; policies: Record<'created_active' | 'created_draft' | 'exists', number> }`
  - `seedCatalogue(c: Catalogue): Promise<SeedReport>`. It must be called under the seed lock and does not take the lock itself.
  - `loadCatalogueFile(path: string): Promise<Catalogue | null>`. It returns null and logs (no values) when the file is missing, larger than 1 MiB, not JSON or invalid.
  - `seedBuiltinTemplates()` keeps its name and return type. Inside the lock it now runs `login_otp` seeding first. Then, if `NS_SEED_FILE` is set and loads, it runs `seedCatalogue`. The `SeedReport` is logged as counts only.

Behaviour for each **template entry**:
1. Find the vendor with `channelVendor(entry.channel)`. If there is none, count `skipped_channel`.
2. If `entry.provider` is set and differs from `vendor.vendor`, count `skipped_vendor`.
3. Set `locale = entry.locale ?? defaultLocale()`.
4. If `templateRowExists(channel, key, locale, vendor.vendor)`, count `exists`.
5. Otherwise call `createTemplateDraft` with the camel-cased fields and actor `system:catalogue`, then `publishTemplate`.
   - If the publish succeeds, count `created_active`.
   - If it throws a `TemplateError`, count `created_draft` and log `catalogue template <channel>/<key>/<locale> left as draft: <code>`.

**Policy entries** work the same way, through `policyRowExists`, `createPolicyDraft` and `publishPolicy`. A publish `TemplateError` leaves the policy as a draft.

Any non-`TemplateError` error (for example a database error) propagates to `seedBuiltinTemplates`. That function is already called non-fatally from `server.ts`.

- [ ] **Step 1: Write the failing tests**

`src/lib/catalogue/__tests__/load.test.ts` is a unit test using temp files. It covers:
- a valid file → a `Catalogue`;
- a missing file → `null` and one `console.error`;
- a file over 1 MiB → `null`;
- non-JSON → `null`;
- an invalid entry → `null`, with an error message naming the path and not the value.

`src/lib/catalogue/__tests__/seed.integration.test.ts` runs against real Postgres. Model it on the existing template and policy integration tests, using `runMigrations`, `NS_NETWORK=test_net` and the providers mocked as there. Mock `../../providers` so the email vendor is `smtp`/`ns` and the sms vendor is `msg91`/`provider`. Its cases:

```ts
// Catalogue used across cases
const cat = (over = {}) => parseCatalogue({
  version: 'v1',
  templates: [
    { channel: 'email', template_key: 'item.paused', subject: 'Paused', body_html: '<p>Hi {{name}}</p>', variables: [{ name: 'name' }] },
    { channel: 'sms', template_key: 'login_otp', provider: 'pinnacle', provider_template_id: 'P1', body_text: 'Code {{message}}', variables: [{ name: 'message', sensitive: true }] },
    { channel: 'sms', template_key: 'login_otp', provider: 'msg91', provider_template_id: 'M1', variables: [{ name: 'message', sensitive: true }] },
  ],
  policies: [{ domain: 'seeker', event_type: 'item.paused', mode: 'first_available', channels: [{ channel: 'email', template_key: 'item.paused' }] }],
  ...over,
});
```

- **"seeds absent entries and publishes them":**
  - `seedCatalogue(cat())` gives templates `{created_active: 2, skipped_vendor: 1}` and policies `{created_active: 1}`.
  - `resolveTemplate('email','item.paused')` and `resolvePolicy('seeker','item.paused')` both succeed.
  - `created_by` is `system:catalogue`.
- **"is idempotent":** a second `seedCatalogue(cat())` reports everything as `exists` (the skipped vendor stays `skipped_vendor`), and no new rows are created.
- **"never overwrites: active, draft and retired rows all count as existing":**
  - Seed once.
  - Through the repo, create a new draft version of `item.paused`, then retire the policy.
  - Seed again with a catalogue whose `item.paused` subject differs.
  - Expect `exists` for both. Expect the active template's subject to be unchanged, the draft untouched, and the policy still retired.
- **"a vendor switch seeds the new vendor's row":**
  - Seed with msg91.
  - Re-mock the sms vendor as `pinnacle`, then seed again.
  - Expect the pinnacle `login_otp` row to be `created_active`. The msg91 row is now retired by publish, the same as Plan B's vendor-switch behaviour.
- **"a policy whose template is not active is left as a draft":**
  - Use a catalogue where the email template fails publish (an `{{undeclared}}` token in `body_html`).
  - Expect templates `created_draft: 1` and policies `created_draft: 1`.
  - Expect `resolvePolicy` to return null. Boot-style seeding does not throw.
- **"concurrent seeding creates each entry once":** run `seedBuiltinTemplates()` twice in parallel with `NS_SEED_FILE` pointing at a temp file of `cat()`. Expect exactly one row per (channel, key, locale, provider) and one policy row.
- **"login_otp env seeding runs first; the catalogue's msg91 login_otp is then exists":**
  - Set `SMS_LOGIN_OTP_TEMPLATE_ID=ENV1`, then call `seedBuiltinTemplates()`.
  - Expect the msg91 `login_otp` row to have provider template id `ENV1`. The catalogue entry counts as `exists`.

- [ ] **Step 2: Run and confirm the tests fail.** Run `pnpm vitest run src/lib/catalogue/__tests__/load.test.ts`, and the integration file per global-constraints. Expected: FAIL.

- [ ] **Step 3: Implement.**

`src/lib/templates/repo.ts`:

```ts
export async function templateRowExists(channel: string, templateKey: string, locale: string, provider: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: template.id })
    .from(template)
    .where(and(
      eq(template.network, currentNetwork()), eq(template.channel, channel), eq(template.templateKey, templateKey),
      eq(template.locale, locale), eq(template.provider, provider),
    ))
    .limit(1);
  return rows.length > 0;
}
```

`src/lib/policies/repo.ts`:

```ts
export async function policyRowExists(domain: string | null, eventType: string | null): Promise<boolean> {
  const rows = await getDb()
    .select({ id: notificationPolicy.id })
    .from(notificationPolicy)
    .where(and(eq(notificationPolicy.network, currentNetwork()), scopeEq(notificationPolicy.domain, domain), scopeEq(notificationPolicy.eventType, eventType)))
    .limit(1);
  return rows.length > 0;
}
```

`src/lib/catalogue/seed.ts`:

```ts
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
 * the catalogue only bootstraps an empty deployment. Call under the seed lock.
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
      if (!(e instanceof TemplateError)) throw e;
      report.templates.created_draft++;
      console.warn(`catalogue template ${t.channel}/${t.template_key}/${locale} left as draft: ${e.code}`);
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
      if (!(e instanceof TemplateError)) throw e;
      report.policies.created_draft++;
      console.warn(`catalogue policy ${domain ?? '*'}/${eventType ?? '*'} left as draft: ${e.code}`);
    }
  }
  return report;
}
```

In `src/lib/templates/seed.ts`, `seedLocked()` returns early in several places. Restructure it so that it:
- computes the `login_otp` outcome without early returns, then
- runs the catalogue step whenever `process.env.NS_SEED_FILE?.trim()` is set:

```ts
const file = process.env.NS_SEED_FILE?.trim();
if (file) {
  const catalogue = await loadCatalogueFile(file);
  if (catalogue) {
    const report = await seedCatalogue(catalogue);
    console.log(`catalogue ${catalogue.version} seeded: ${JSON.stringify(report)}`);
  }
}
```

Keep the existing return value, which is the `login_otp` outcome, so existing seed tests stay valid.

- [ ] **Step 4: Run.** Run `pnpm build`, then `pnpm test`, then the full integration suite per global-constraints. Remove the containers afterwards. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/catalogue src/lib/templates src/lib/policies
git commit -m "feat(catalogue): seed absent templates and policies from NS_SEED_FILE at boot

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Admin export, wiring and docs

**Files:**
- Create: `src/lib/catalogue/export.ts`, `src/routes/admin-export.ts`, `src/lib/catalogue/__tests__/export.integration.test.ts`, `src/routes/__tests__/admin-export.test.ts`
- Modify: `src/app.ts`, `src/__tests__/route-scopes.test.ts`, `src/lib/utils/openapi.ts` (with its test), `CLAUDE.md`, `README.md`, `example.env`

**Interfaces:**
- Consumes: `listTemplates`, `listPolicies`, `channelVendor`, `CatalogueSchema` (Task 1), `seedCatalogue` (Task 2).
- Produces:
  - `exportCatalogue(version: string): Promise<Catalogue>`. It covers active rows for the current network, plus templates whose `provider` is the current vendor of their channel.
  - Template entries include `provider` and every non-null create field. Policies include `domain`, `event_type`, `mode` and `channels`.
  - Output is sorted, templates by `(channel, template_key, locale)` and policies by `(domain ?? '', event_type ?? '')`, so two exports of the same store are byte-identical.
  - `GET /v1/admin/export` takes `authenticate({ scope: 'templates:admin' })` and answers `200 Catalogue`, where `version` is the export's ISO timestamp with `:` replaced by `-`. It answers `503 network_not_configured` through `sendAdminError`.

- [ ] **Step 1: Write the failing tests.**
  - **Unit (`admin-export.test.ts`):**
    - mock `../../lib/catalogue/export` and the auth plugin (pattern as in `admin-templates.test.ts`);
    - expect 200 with the mocked catalogue;
    - expect 503 when `exportCatalogue` throws `NetworkNotConfigured`.
  - **Route scopes:** add `GET /v1/admin/export → templates:admin` to the table in `route-scopes.test.ts`.
  - **Integration (`export.integration.test.ts`):**
    1. Seed `cat()` from Task 2's fixture into network `net_a`.
    2. `exportCatalogue('x')`. The result must parse with `parseCatalogue`. It holds exactly the two active templates for the current vendors and the one policy, with no ids or timestamps.
    3. Switch `NS_NETWORK` to an empty `net_b` and `seedCatalogue(exported)`. Then `exportCatalogue('x')` on `net_b` deep-equals the `net_a` export.
    4. A draft or retired row is never exported.
  - **OpenAPI:** the test asserts `/v1/admin/export` exists with `security` set to admin security and responses 200, 401, 403 and 503.

- [ ] **Step 2: Run and confirm the tests fail.**

- [ ] **Step 3: Implement.**

`src/lib/catalogue/export.ts`:

```ts
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
```

`src/routes/admin-export.ts` registers `GET /v1/admin/export` with `preHandler: authenticate({ scope: 'templates:admin' })`. The handler is:

```ts
try {
  return await exportCatalogue(new Date().toISOString().replace(/[:]/g, '-').slice(0, 64));
} catch (err) {
  return sendAdminError(reply, err);
}
```

Register it in `src/app.ts` next to the other admin routes.

Docs:
- **`CLAUDE.md`, "Templates and policies":** add a **Catalogue** paragraph covering:
  - the format;
  - `NS_SEED_FILE`;
  - seed-if-absent semantics (F1-1) and boot-only seeding (F1-2);
  - provider-skipped entries;
  - drafts on publish failure;
  - the export endpoint and round trip (F1-3).
  
  Also update the Authentication scope table and the test counts.
- **`README.md`:** a short catalogue example plus the export curl call. Add `NS_SEED_FILE` to the env table.
- **`example.env`:** add `NS_SEED_FILE=` with the comment "optional; templates and policies to create when absent".

- [ ] **Step 4: Run.** Run `pnpm build`, then `pnpm test`, then the full integration suite. Remove the containers afterwards. Expected: everything passes.

- [ ] **Step 5: Commit**

```bash
git add -A src CLAUDE.md README.md example.env
git commit -m "feat(catalogue): admin export of active templates and policies; docs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Done when

- Build, unit tests and integration tests are green.
- With `NS_SEED_FILE` set, a fresh deployment boots with every catalogue template and policy active. An already-seeded deployment changes nothing, and an admin edit survives any number of restarts.
- A broken or missing catalogue never blocks the boot.
- `GET /v1/admin/export` returns a catalogue that seeds an empty network to the same state.
- Nothing existing changes behaviour. Legacy `/notify`, `/v1/notify` and the `login_otp` env seed all work as before.
