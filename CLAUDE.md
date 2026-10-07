# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a **Fastify notification service** that queues and asynchronously processes multi-channel notifications (email, SMS, WhatsApp). The API validates requests up front, records each send in Postgres, queues it in Redis, and a background worker processes it with retry logic and deduplication. Postgres is the record; Redis is the queue.

## Quick Commands

**Development:**
- `pnpm install` — Install dependencies
- `pnpm dev` — Start API and worker with hot-reload (tsx watch)
- `docker compose up -d postgres redis` — Start Postgres and Redis (both required). The compose
  Postgres publishes host port **5432**, which collides with a local Postgres. `docker/postgres/init.sql`
  runs only on the first boot of the volume; `docker volume rm notification-service-postgres` to re-init.
- `pnpm db:generate --custom --name=<x>` — new partitioned-table DDL (see Persistence)

**Build & Run:**
- `pnpm build` — Compile TypeScript to `dist/`
- `pnpm start` — Run compiled server from `dist/server.js`

**Testing:**
- `pnpm test` — vitest, single run. No Docker, Redis or Postgres needed: Redis is faked in-process
  (`src/lib/__tests__/redis-fake.ts`) and the database layer is mocked
- `pnpm test:watch` — vitest in watch mode
- `pnpm test:integration` — needs a **real** Redis **and** Postgres. The exact local env is in the
  header of `vitest.integration.config.ts`. In CI, the `redis` service container and a pg_partman
  Postgres built from `docker/postgres`

## Architecture

### High-Level Flow

1. **API Server** (`src/server.ts`) — Listens on `SERVER_PORT` (default 3000)
   - Registers routes from `src/routes/`
   - Boot order: `loadSecrets` → migrations (advisory lock) → partition maintenance →
     `recoverLostJobs` → listen → fork worker. Nothing may touch a table before its migration
     lands, and recovery runs before the worker drains so recovered jobs join the queue in order.
     A failed migration or invalid config exits non-zero; a failed **boot recovery does not** — it
     is logged and the periodic sweep (every 5 minutes) retries.
   - Spawns one background worker process

2. **Request Pipeline** (e.g., `POST /notify`)
   - HMAC signature validation (`src/plugins/request-auth.ts`)
   - Payload validation via Zod schemas
   - Record in Postgres and enqueue to Redis (order depends on priority; see Persistence)

3. **Background Worker** (`src/lib/worker.ts`)
   - Runs in a separate process spawned by server
   - Processes jobs from Redis queues in priority order:
     1. Realtime queue (high priority, short block)
     2. Due retry jobs from retry sorted set
     3. Other queue (normal priority)
   - Retries failed sends with exponential backoff
   - Moves exhausted retries to dead-letter queue

### Redis Queues

Four Redis structures drive the queue model:

```
queue:realtime  → List of high-priority jobs
queue:other     → List of normal-priority jobs
queue:retry     → Sorted set for delayed retries (score = Date.now() + delay, epoch MS)
queue:dlq       → List of dead-letter jobs (max retries exhausted)
```

The worker checks `queue:realtime` first but only blocks briefly, preventing starvation of `queue:other` and due retries.

The retry score is epoch **milliseconds**. `getQueueMetrics()` exposes `retry_oldest` as that
raw epoch-ms timestamp, and `retry_eta_seconds` converted to **seconds** — it previously
returned the raw millisecond difference despite its name, so a 30-second retry read as
`30000` (fixed in #50, with a regression test).

### Persistence

Postgres is the record of every send; Redis is only the dispatch queue. Code: `src/lib/db/`
(client, `migrate.ts`, `maintenance.ts`, `schema.ts`, `partitioned.ts`) and `src/lib/audit/`
(`store.ts`, `stamp.ts`, `status.ts`, `redact.ts`, `recover.ts`).

**`/notify` ordering.**
- **Normal priority is record-before-queue.** If the record cannot be written the send is refused:
  `503 {"error": "audit store unavailable", "enqueued": false}`, and the dedupe claim is
  **released** so the caller's retry is accepted rather than answered as a duplicate.
- **Realtime is queue-first.** The audit write is fire-and-forget so a slow database never delays
  an OTP. It persists the recipient and variable **names only, never values**, and keeps no job
  copy, so realtime sends are **not recoverable** after a Redis loss (the user requests a new code).
- **Redaction is sticky.** `/notify` sets `audit.redactValues` (true for realtime **or an OTP
  template**) on the job, and `toAcceptedRecord` keys on it, not on the current priority: a DLQ
  replay of an OTP as `other` still persists names only and no job copy. Jobs without the flag fall
  back to the priority. An OTP template (`isOtpTemplate`: `otp` as a whole token of the id, e.g.
  `login_otp`, `otp.login`) is redacted at **any** priority, so an OTP sent without `priority` is
  never persisted (and, like realtime, not recoverable). A raw provider id (DLT flow id) carries no
  name: an OTP sent under one is redacted only if the caller sends `priority: 'realtime'`.
- If the Redis push fails after the record was written, the attempt is stamped `failed`
  (`enqueue failed`, best-effort) and the dedupe claim is released (as on the 503 path) before the
  error propagates, so recovery never sends it later and the caller's retry is accepted.
- `x-correlation-id` is trimmed and capped at **128** chars; blank falls back to the job id.
- The persisted payload never holds email attachment bodies (filename, contentType and size
  only). The **job copy keeps them**: recovery re-pushes that copy. Persisted `error` strings are
  capped at 500 chars.
- DB errors are logged through `describeDbError` (`src/lib/db/errors.ts`): Postgres code + driver
  message only. `DrizzleQueryError.message` embeds every bound parameter (recipients, variables,
  the job) and must never be logged.

**Worker stamps are best-effort.** Realtime-priority stamps are fire-and-forget (never on the send
path); normal-priority stamps are awaited but bounded by the pool timeouts. A failed stamp never
turns a delivered message into a retry; it is counted in `ns_audit_write_failures_total{stage}`.

**Attempt markers.** The worker writes `ns:attempt:<attemptId>` = `<sent|retry|failed>:<attemptNo>`
(TTL 7 days). `sent`/`failed` are written right after the fate is decided and **before** the stamp
(best-effort). `retry` is written in the **same MULTI** as the retry-set ZADD
(`queue.scheduleRetryWithMarker`), so the marker exists iff the retry is scheduled, and the
`queued` stamp comes **after** that MULTI: the row stays `dispatching` until the retry is in Redis,
so a crash before (or a failed) MULTI leaves a `dispatching` row with no marker, which the
stale-dispatch sweep re-queues; a crash after it leaves the `retry` marker, and the sweep leaves
the row to the retry set. The number
is the attempt the matching stamp would write (`retry` → the next attempt), so a marker left by an
earlier attempt never hides a later attempt's crash. A failed `sent` stamp therefore no longer
leads to a re-send. A double failure (stamp fails **and** Redis loses the marker) can still
re-send: delivery is at-least-once.

**Status model.** Rows are upserted monotonically on `(attempt_no, status_rank)`, so a late or
replayed stamp cannot move a row backwards. An event's status mirrors its *current* attempt, so it
can read `accepted` again when a retry is queued. A DLQ replay is a **new** attempt row (fresh
`attemptId`, same event).

**Recovery (`recoverLostJobs`).** `ns:epoch` in Redis means "Redis still has its data".
- If it is missing, the holder of a short `ns:recovery` lock re-queues recoverable open attempts
  last touched **before Redis started** (uses `INFO server` uptime) and sets the epoch only after
  every batch committed. The cutoff (`now() - uptime`) is computed **once** before the first batch
  as an absolute timestamp; a per-batch `now()` would drift forward and re-queue rows that live
  traffic wrote during the run. NS therefore needs `INFO` allowed on Redis; with `INFO` disabled every
  recovery run fails while the epoch is missing (**including the first deploy**), so lost work is
  never recovered.
- Stale `dispatching` rows (> 10 min) are re-queued: at-least-once by design.
- Every candidate (recoverable, with a job copy) is resolved in order: its **attempt marker**
  (`sent`/`failed` → that state is stamped, `retry` → left alone, the job is in the retry set);
  then **age** — created more than `RECOVERY_MAX_AGE_HOURS` (default 24) ago → marked `failed`
  (`abandoned: not delivered within recovery window`), counted in `ns_recovery_abandoned_total`;
  otherwise re-queued.
- Work runs in keyset batches of 500 (`FOR UPDATE SKIP LOCKED`), each its own transaction with
  `SET LOCAL statement_timeout = '60s'` and one Redis `MULTI` push; a failed push rolls back that
  batch only. A connection whose `ROLLBACK` fails is destroyed (`release(err)`).
- A `FLUSHALL` without a Redis restart is **not** fully recovered (only stale `dispatching` rows).
- **Known gap: lost `queued` rows are recovered only on epoch loss.** The periodic sweep picks up
  stale `dispatching` rows only, so a `queued` row whose job left Redis without ever being stamped
  `dispatching` stays open until Redis restarts: (a) the worker dies between the pop (`BRPOP`, or
  `popScheduledRetries`, which claims **every** due retry at once, so the rest of that batch is
  lost too) and the `dispatching` stamp; (b) the API dies between the `/notify` record insert and
  the `LPUSH`. It is not swept by age because a `queued` row can legitimately wait in a queue or the
  retry set for a long time, so age is no proof of loss and re-queueing would double-send. Closing
  it needs a claim written atomically with the pop (e.g. `BLMOVE` into a processing list, or a
  claim marker set in the pop script) for the sweep to check.
- **Never delete `ns:epoch` by hand.** It triggers a full re-queue of open recoverable attempts,
  which sends them again.
- Redis must run with `maxmemory-policy noeviction` so the epoch key is never evicted (the compose
  default is `noeviction`; the shared production Redis already uses it).

**Schema and migrations.** The audit tables are partitioned and excluded from `drizzle.config.ts`;
their DDL lives in custom migrations (`drizzle/0000_audit_tables.sql`) and their query-side
definitions in `src/lib/db/partitioned.ts`. Add new partitioned DDL with
`pnpm db:generate --custom --name=<x>` and change `partitioned.ts` in the same commit. Never
hand-edit generated migrations. Migrations run on a dedicated short-lived pool with **no**
statement/query timeout (so the advisory-lock wait is unbounded too, intended); the service pool
keeps its 5s bounds. `pg_partman` lives in schema `partman`; maintenance is driven by NS
(`PARTITION_MAINTENANCE_INTERVAL_MS`, default 6h; no background worker, which would need a
cluster-wide `shared_preload_libraries` change). Maintenance pre-makes partitions but does **not**
move rows out of a default partition, and a row in the default for a future range makes
`run_maintenance` skip that partition set. Each tick therefore runs
`partman.check_default(p_exact_count := false)`, logs a warning and sets
`ns_partition_default_rows{parent}` (1 = non-empty); move the rows with
`partman.partition_data_proc`. There is no retention until #65, so nothing is dropped today.

### Request Signing (Authentication)

All API routes require HMAC-SHA256 signed requests with headers:
- `X-NS-Key` — Client identifier
- `X-NS-Timestamp` — Unix timestamp
- `X-NS-Nonce` — Random string (prevents replay)
- `X-NS-Signature` — `v1=<hmac_sha256>` of signed base string

**Signed base string:**
```
METHOD\nPATH\nTIMESTAMP\nNONCE
```

Implementation: `src/lib/auth/secrets.ts` (loads the JSON file named by `INTERNAL_SECRETS_JSON`), `src/plugins/request-auth.ts` (validates).

### Provider System

Providers are extensible implementations for different notification channels (email, SMS, WhatsApp). Each provider exports a `ProviderDefinition` from `src/lib/providers/<name>/index.ts`:

```ts
export const emailProvider: ProviderDefinition = {
  name: 'email',                     // Channel name used in /notify requests
  templates: { welcome: '...' },     // Public template keys → provider IDs
  allowRawTemplateId: false,         // optional; see below
  schema: z.object({ ... }),         // Zod schema for variables
  async send({ to, template_id, variables }) { ... }
};
```

`vendor` (a string naming the vendor, e.g. `'smtp'`, `'msg91'`, `'pinnacle'`, `'twilio'`) and `renders` (`'ns' | 'provider'`) are
**required** on every definition; see Templates and policies for what they drive.

Providers are auto-discovered and registered by `src/lib/providers/index.ts`. To add a provider, create a folder and export the definition, including `vendor` and `renders` (see README for full example).

**`allowRawTemplateId` (raw template-id pass-through).** By default a `template_id`
must name a key in the provider's `templates` map or `/notify` rejects it with a
400. When `allowRawTemplateId: true`, an unknown `template_id` is passed through to
the provider verbatim — treated as a raw provider-side id the caller owns. SMS uses
this (#532/#535): signalstack sends DLT-approved MSG91 flow ids directly, so only
the legacy `login_otp` flow is named in its `templates` map. Email keeps the default
(strict allowlist).

**SMS variables schema.** SMS switched its `schema` to `z.record(z.string(),
z.string())` — an open map of named string variables (the DLT template's
placeholders), rather than a fixed `z.object`. This carries the multi-variable
flow (`name`, `link`, …) through to MSG91 as per-recipient vars.

**Two SMS vendors, selected by `SMS_PROVIDER` (`msg91` default, or `pinnacle`).**
`src/lib/providers/sms/index.ts` picks one at boot and throws on an unknown name
rather than falling back — silently sending through the wrong vendor would use
the wrong sender id and DLT entity. Both definitions declare `name: 'sms'`, so
the channel key, the rate-limit key and every caller are identical either way.

The two vendors are **not** the same shape, and this is the thing to understand
before touching either file:

| | MSG91 Flow | Pinnacle JSON |
|---|---|---|
| What you send | flow id + named variables | fully **rendered `text`** |
| Who renders the body | **MSG91**, from the DLT template | **nobody** — you supply final text |
| DLT metadata | hidden inside the flow | explicit `dltentityid` / `dlttempid` / `sender` |
| `template_id` means | an MSG91-internal flow id | the **DLT template id itself** |
| Errors | HTTP status | HTTP 200 + `code: EC1xxx` in the body |

**`bodies` (provider-owned message text).** Because Pinnacle renders nothing,
`ProviderDefinition.bodies` maps the same public keys as `templates` to their
body text, and the worker resolves `provider.bodies[key] ?? job.body`. So a
template the provider **names** (`login_otp`) carries its own body and needs no
caller change — which is why the OTP callers (Keycloak, Signals guardian OTP)
were untouched by the Pinnacle work. A **raw pass-through** id has no entry, so
its body must come from the caller's optional `body` field on `/notify`.

**`??`, never `||` — this one is load-bearing.** A *declared but blank* body
(`bodies: { login_otp: '' }`, the state while a DLT approval is pending) is
dead-lettered alongside a blank template id, and must never fall through to the
caller's `body`. With `||` it did, which let any caller put arbitrary text on the
wire under a DLT-approved template id: a compliance break and a phishing
primitive in one. Declaring a template is this service claiming its text;
blank means unconfigured, not "caller may supply it".

The body must be **byte-identical to the DLT-approved text**. The operator
matches on it; drift is scrubbed downstream rather than rejected upfront, so it
fails silently. `src/lib/providers/sms/render.ts` substitutes `{{token}}` and
**throws** on any unresolved or empty variable — the lenient behaviour that is
right for signalstack's dev-preview log would put a literal `{{name}}` on a
handset here.

**`retryable` on the send result.** The worker's default is to retry every
failure up to `MAX_RETRIES`, which is right for a timeout and wrong for "that
template id does not exist". A provider that can tell the difference returns
`retryable: false` and the worker dead-letters on the first attempt, so a
permanent misconfiguration is diagnosable instead of buried under "max retries
reached". Pinnacle classifies its `EC1xxx` codes this way — `EC1003`
(insufficient balance), `EC1013` (invalid template), `EC1004` (invalid sender)
are permanent; `EC1009`/`EC1010` and unrecognised codes still retry.

### Request Deduplication

`/notify` deduplicates by a Redis `SET NX` key with a per-mode TTL (windows are
**not** configurable). Two modes (`src/lib/dedupe_key.ts`, `src/routes/notify.ts`):

- **Explicit `dedupe_id`** — the caller promising "send this once". Used verbatim
  as the key, **1 hour** window. A suppressed repeat is a success with a reason:
  `200 {"enqueued": false, "reason": "duplicate"}`.
- **No `dedupe_id`** — fallback key `channel:to:template_id:<sha256 of the rendered
  payload>` (the `channel:to:template_id` prefix stays in the clear so the key is
  greppable; the digest carries message identity), **5 second** window. A suppressed
  repeat is nobody's intent — a dropped message — so it answers
  `409 {"enqueued": false, "reason": "duplicate-fallback"}` (#88).

Hashing the whole payload is what makes the fallback message-identifying: it used
to key on `channel:to:template_id` alone, which for a generic template like
`basic_email` collapsed to one email per recipient per window regardless of content.
See README for the full request/response contract.

## Templates and policies

Code: `src/lib/templates/` (`contract`, `render`, `repo`, `validate`, `vendors`, `seed`),
`src/lib/policies/` (`repo`, `plan`), routes `src/routes/admin-templates.ts` and
`admin-policies.ts`. Plan C wires these into `/notify`; until then `/notify` behaves as before.

**Tables.** `template` is keyed `(network, channel, template_key, locale)` and `notification_policy`
`(network, domain, event_type)` where NULL means "any". Both carry a `version` and a status of
`draft`, `active` or `retired`. The network is deployment config (`NS_NETWORK`, read through
`currentNetwork()`), never request input; unset, `NetworkNotConfigured` is thrown and admin routes
answer `503`.

**Lifecycle.** Only drafts are editable. Active and retired rows are immutable on every channel
(`409 invalid_state`); to change one, create a new draft version. Publishing validates, retires the
previous active row for the same key and activates the draft in one transaction under a
`pg_advisory_xact_lock`, backed by a partial unique index on `status = 'active'`, so there is
exactly one active row per key even with concurrent publishes. Retire never deletes.

**One vendor per channel per deployment.** `ProviderDefinition.vendor` names it and `renders` says
who turns a template into text: `ns` (email/smtp, Pinnacle SMS) or `provider` (MSG91 Flow, Twilio
Content). A template's `provider` must equal the deployment's vendor, checked at publish and again
in `resolveTemplate`, which refuses with `vendor_mismatch` instead of falling back to another
locale. DLT and Meta template ids are per vendor, so a template from another vendor would send a
meaningless id. Adding a provider means declaring both fields.

**Locale chain.** A requested `xx-YY` resolves `xx-YY` → `xx` → `NS_DEFAULT_LOCALE`.

**Variable contract** (`contract.ts`) is a list of `{ name, required, type: string|number|url,
sensitive, raw, urlHosts? }`. It is enforced at publish (every `{{token}}` in a stored body is
declared, every declared variable is used) and again on each send, **before** any vendor call:
- Unknown variables are rejected; required ones must be present and non-empty.
- Names that exist on `Object.prototype` (`constructor`, `toString`, ...) are rejected, and values
  are read as own properties only.
- Values must be a string, a finite number or a boolean; `number` must match `^-?\d+(\.\d+)?$`.
- `url` must be `http(s)` with no userinfo. `urlHosts` is an allowlist with subdomain matching and
  one trailing dot tolerated. The stored and rendered value is the normalised `url.href`, so what
  was validated is what is sent.
- Error messages name variables, never their values.
- Publish also rejects any `{{` or `}}` that is not part of a valid `{{name}}` token, e.g.
  `{{ name }}` (`undeclared_token`, `details: { malformed: true }`, all channels; checked before the
  token/contract match so the error names the real problem), and requires every token inside an
  email `href`/`src` attribute value (quoted or unquoted) to be declared `type: 'url'`
  (`invalid_contract` naming the variable): HTML-escaping a string does not stop `javascript:`.

**Rendering** (`render.ts`). Email HTML-escapes every variable by default; `raw: true` is the
reviewable opt-out and is valid on email only. Subjects collapse every run of C0 controls, DEL, NEL
(U+0085) and U+2028/U+2029 to one space, so a variable cannot inject headers. SMS bodies are stored byte-exact (the DLT operator matches on them). The
rendered SMS length is checked against 2000 (TXT) or 750 (UNI), chosen by the *rendered* text, so a
non-GSM variable cannot push a TXT-sized body past the UNI limit. Vendor-rendered templates pass the
provider template id and the validated variables.

**Policies.** `resolvePolicy` picks the most specific active row: `(domain, event)` → `(any, event)`
→ `(domain, any)` → `(any, any)` default. Publish requires every channel listed to resolve exactly as
a send does (`resolveTemplate` on the default-locale chain, current vendor), inside the publish
transaction: no row → `incomplete_template`, another vendor's row → `vendor_mismatch`. The reverse
holds too: retiring an **active** template an active policy names answers `409 template_in_use`
(`details.policy_ids`) unless the key still resolves without it. Both take a per-`(channel, key)`
advisory lock (`lockTemplateRefs`), so a concurrent publish and retire cannot both win. A vendor
switch can still leave a live policy on another vendor's template; that surfaces at send time.
`planDelivery(policy, contacts)` filters the channel list by what the caller supplied (email needs
an email address; sms and whatsapp need a phone) because NS holds no user directory. `first_available`
tries candidates in order; `all` fans out.

**Admin scope.** `/v1/admin/templates` and `/v1/admin/policies` need a valid HMAC signature
(`requestAuth`) **and** the key id in `NS_ADMIN_KEY_IDS`, else `403 {"error":"admin scope required"}`.
Editing a DLT-registered template has a compliance blast radius a sending credential must not
carry. Interim until Keycloak admin roles (#62). **Keep `NS_ADMIN_KEY_IDS` empty in production
until HMAC v2 (#62) signs request bodies**: the current signature covers method, path, timestamp and
nonce but not the body, so whoever can see a signed admin request in flight can send a different
template or policy under its headers. Request bodies (including each variable spec) are strict, so unknown keys → `400`; list query params are not strict.
Errors: `404 not_found`, `409 invalid_state` / `template_in_use`, `422` for any other rule violation, `503
network_not_configured`, and `503 database_unavailable` for anything else (`sendAdminError`). That
last path logs only `describeDbError(err)` and returns a fixed body: a `DrizzleQueryError` message
embeds the SQL and every bound parameter (template bodies included), so it must never reach Fastify's
default 500 handler, which would log and return it. `POST .../preview` renders a template of any status with the supplied
variables and sends nothing.

**`login_otp` seeding** (`seed.ts`, called from `server.ts` after recovery). At boot the SMS
`login_otp` template is created and published from the **explicitly configured** id for the current
vendor, with the provider's body and contract `message` (required, sensitive): msg91 reads
`SMS_LOGIN_OTP_TEMPLATE_ID` directly (the provider map's hardcoded fallback flow id is never
seeded), pinnacle reads `PINNACLE_LOGIN_OTP_TEMPLATE_ID` via its provider map; unset or blank →
`skipped_no_id`. Existence is checked **per vendor**: any `login_otp` row (any status/locale) whose
`provider` is the current vendor → `exists`, never overwritten, so an admin's edits always win over
environment defaults. The one exception is the seed's **own untouched draft** (`created_by =
'system:seed'`, still `draft`, `updated_at = created_at`): e.g. Pinnacle with
`PINNACLE_LOGIN_OTP_TEMPLATE_ID` set before `SMS_LOGIN_OTP_BODY`. Every boot re-applies the env values
to it in place (`reapplySeedDraft`, which leaves `updated_at` alone) and retries publish; once an admin
edits, publishes or adds a row, it is `exists`. A publish failure logs `seeded_draft` at **warn**. If rows exist only for another vendor (the deployment switched vendor), the
current vendor's template is created and published, which retires the old vendor's active row. Replicas booting together
serialise on a session advisory lock. Seeding is non-fatal (logged, never blocks listen) and is
skipped when `NS_NETWORK` is unset; a template that fails publish validation is left as a draft and retried next boot.

## Key Files

**Routes** (`src/routes/`):
- `docs.ts` — Scalar API reference and OpenAPI JSON
- `notify.ts` — Enqueue notification endpoint
- `providers.ts` — Provider discovery endpoints
- `metrics.ts` — Queue metrics endpoint (HMAC-authed JSON) **and** `/metrics`,
  the unauthenticated Prometheus scrape endpoint
- `retry.ts` — Manual DLQ retry endpoint (`refused` in the response; see DLQ replay cap)
- `admin-templates.ts`, `admin-policies.ts` — template and policy admin API (see Templates and policies)

**Library** (`src/lib/`):
- `queue.ts` — Redis queue and retry helpers
- `metrics.ts` — Redis-backed Prometheus counters/gauges (see below)
- `worker.ts` — Background job processor loop
- `db/`, `audit/` — Postgres client, migrations, partition maintenance, audit store, stamps, recovery (see Persistence)
- `auth/secrets.ts` — Load signing secrets from the JSON file at `INTERNAL_SECRETS_JSON`
- `providers/` — Provider implementations (auto-loaded)
- `utils/openapi.ts` — OpenAPI document builder
- `utils/provider-docs.ts` — Provider schema/payload serialization

**Other**:
- `types/index.ts` — `NotifyRequest` and `Job`
- `types/provider.ts` — `ProviderDefinition` interface

**Tests** (`src/**/__tests__/`):
- `lib/__tests__/redis-fake.ts` — in-memory ioredis stand-in shared by the suites
- `lib/__tests__/queue.test.ts`, `lib/__tests__/dedupe.test.ts`, `plugins/__tests__/request-auth.test.ts`

## Environment Setup

Create `.env` from `example.env` and fill with provider credentials:

```bash
cp example.env .env
# Edit .env with API keys for providers you enable
```

Required for API operation:
- `SERVER_PORT` (optional, defaults to 3000)
- `INTERNAL_SECRETS_JSON` — **path to a JSON file**, not an inline secret. `loadSecrets()`
  reads it at boot and throws if the variable is unset. Shape:
  `{"jobstack": {"secret": "ns_jobstack_secret-key"}}`

Required for persistence and Redis:
- `REDIS_PASSWORD` — required; NS refuses to start without it. `REDIS_ALLOW_NO_AUTH=true` lifts that
  for **local/test only**.
- `DATABASE_HOST`, `DATABASE_NAME`, `DATABASE_USER`, `DATABASE_PASSWORD` — all required (no
  localhost fallback). `DATABASE_PORT` (5432), `DATABASE_POOL_MAX` (10; integer **≥ 2** — the
  migration lock session and the migrator each hold a connection).
- `DATABASE_CONNECT_TIMEOUT_MS` (default 2000) and `DATABASE_QUERY_TIMEOUT_MS` (default 5000, used
  for both `query_timeout` and `statement_timeout`) bound every database wait, so an unreachable
  database cannot hold the worker loop.
- `DATABASE_SSL` — `disable` (default; parity with the other services on the shared RDS) or
  `require`. `require` **verifies** the certificate, so supply the RDS CA via `NODE_EXTRA_CA_CERTS`.
- `NS_NETWORK` — the network this deployment serves (opentofu sets it from `signals_network`).
  **Required for the template/policy admin API and boot seeding**: unset, the admin routes answer
  `503 network_not_configured` and seeding is skipped. Still recorded on each event, `unknown`
  when unset.
- `NS_DEFAULT_LOCALE` — optional, default `en`; the last step of the template locale chain.
- `NS_ADMIN_KEY_IDS` — comma-separated HMAC key ids allowed to use `/v1/admin/*`. Unset means
  nobody can.
- `PARTITION_MAINTENANCE_INTERVAL_MS` — optional, default 6h.
- `RECOVERY_MAX_AGE_HOURS` — optional, default 24, positive integer (invalid fails boot). Open
  recoverable sends older than this are marked failed by recovery instead of sent late.

Required for providers (varies by implementation):
- Email transport — **one** of `SMTP_AWS_SES=true` (+ AWS SESv2 credentials) or
  `SMTP_HOST` (+ `SMTP_PORT`/`SMTP_SECURE`/`SMTP_USER`/`SMTP_PASS`), checked in
  that order. Added in #112: before it the only non-SES option was Gmail,
  hardcoded to `smtp.gmail.com:465`, selected by an `SMTP_GMAIL` flag with
  `GMAIL_USER`/`GMAIL_PASS` credentials. Those three variables were **removed** —
  Gmail is now configured like any other relay. Only its *host* is still
  special-cased, and only for the From address: Gmail rewrites or rejects a From
  that is not the authenticated account, so `SMTP_HOST=smtp.gmail.com` sends as
  `SMTP_USER` unless `SMTP_FROM` says otherwise. Resolution lives in
  `src/lib/providers/email/sendMailCore.ts`; the README table is the
  operator-facing version.
- `SMS_PROVIDER` — `msg91` (default) or `pinnacle`. Unknown values throw at boot.
- `MSG91_AUTH_KEY` for SMS (MSG91 Flow API)
- Pinnacle (`SMS_PROVIDER=pinnacle` only): `PINNACLE_API_KEY`,
  `PINNACLE_SENDER_ID`, `PINNACLE_DLT_ENTITY_ID` are required; the send fails
  **permanently** (no retries) if any is missing. `PINNACLE_DLT_HEADER_ID`,
  `PINNACLE_DLT_TAG_ID`, `PINNACLE_TMID` are optional and omitted when unset.
  `PINNACLE_LOGIN_OTP_TEMPLATE_ID` + `SMS_LOGIN_OTP_BODY` configure the one
  named template; a blank id dead-letters with "named but not configured".
- `SMS_LOGIN_OTP_TEMPLATE_ID` — MSG91 flow id for the legacy `login_otp` template.
  Read in `src/lib/providers/sms/msg91.ts`; optional, with a back-compat default of
  the previously-hardcoded id for the legacy send path. The boot seed uses only the env value
  and seeds nothing when it is unset. Per-event DLT flow ids are sent raw and need no env
  (see `allowRawTemplateId`). Note: `MSG91_TEMPLATE_ID` in `example.env` is unused —
  the code never reads it; use `SMS_LOGIN_OTP_TEMPLATE_ID` instead.
- Twilio credentials for WhatsApp
- etc.

## TypeScript Configuration

TypeScript **7**, which removed `moduleResolution: node10`, `baseUrl`, and non-relative
`paths` values — the old config used all three, so `pnpm build` failed outright until it
was fixed (#46).

- **Target:** ES2020. **`module`/`moduleResolution`: `Node16`** — emitted output is still
  CommonJS, because `package.json` has no `"type": "module"`.
- **Why `Node16` matters:** it models the CommonJS/ESM boundary, so importing an ESM-only
  package from this CommonJS code is a **compile error** (`TS1479`) rather than a runtime
  `ERR_REQUIRE_ESM`. That is how the `uuid` bug was caught — `uuid@14` is ESM-only with no
  `require` condition, and `job_id` generation now uses `randomUUID` from `node:crypto`
  instead. Keep this setting; do not "simplify" it back to `moduleResolution: Node`.
- **Path alias:** `src/*` → `./src/*`, declared without `baseUrl` (removed in TS 7). The
  alias is load-bearing — `lib/worker.ts` and `lib/queue.ts` import through it.
  (`lib/providers/sms/gupshup.ts` also did, but it was a never-exported stub and
  was deleted with the Pinnacle work.)
- **Type roots:** `./node_modules/@types` only. There is no `src/types/fastify.d.ts` in this
  repo; `typeRoots` takes directories, and the old entry pointed at a file that never existed.
- **Tests are excluded from the build** (`**/*.test.ts`, `src/**/__tests__/**`). They sit
  beside the code under `src/`, so without that they compile into `dist/` and ship in the
  image. `pnpm test` is what checks them.
- **Linting:** `noUnusedLocals` and `noUnusedParameters` enabled (must fix before build)

## Testing Notes

vitest 4, 378 unit tests across 34 files (plus 63 integration tests). The unit suite runs in about a second because Redis
is a **fake** and Postgres is mocked, not containers.

**Provider tests must mock `src/lib/metrics.ts`.** It imports `./redis`, which opens a real
connection on import and keeps the test process alive until vitest times out. `vi.mock` resolves
its path relative to the *test* file, so from `src/lib/providers/sms/__tests__/` the mock target
is `'../../../metrics'` — a wrong depth silently mocks nothing and every test in the file hangs
for the full 5s timeout.

`src/lib/__tests__/redis-fake.ts` implements only the commands this service uses, with
ioredis's exact return shapes — the ones easy to get wrong: `set(..., 'NX')` → `'OK' | null`,
`brpop` → `[key, value] | null`, `multi().exec()` → `[err, result]` pairs. Inject it with
`vi.mock('../redis', ...)`; the module under test and the test share one instance, so
assertions can read the state the code wrote.

**ioredis 6 `zrange` typing.** ioredis 6 types `zrange`'s `stop` as `string | Buffer` (not
`number`), so `getQueueMetrics` passes **string** indices (`zrange(key, '0', '0', 'WITHSCORES')`)
and the fake coerces its index args with `Number()`. If you add a `zrange`/`zrangebyscore`
call, pass string indices to satisfy the v6 overloads.

`worker.test.ts` covers `processJob`: provider/template routing, attempt counting, the full
backoff ladder (5s → 10 → 20 → 40) and DLQ-on-exhaustion. It mocks `../queue` (these tests are
about which queue call is made, not Redis behaviour) and must mock `../providers`, which
auto-discovers by `require`-ing each `index.js` and so is not importable from source.

The integration suite (`pnpm test:integration`) needs a **real** Redis and Postgres (`docker compose up -d postgres`). `queue.integration.test.ts` covers
the one thing a fake cannot: that `popScheduledRetries` claims atomically. Against the old
two-round-trip implementation, eight concurrent claimers returned **400 claims for 50 jobs** —
every retry sent eight times.

**Deliberately not covered yet:**
- `mainLoop`'s priority ordering (realtime → due retries → other) — it is an infinite loop.
- Provider implementations against the real vendors (SES/Twilio/MSG91/Pinnacle network calls).
  The SMS adapters are covered at the request/response boundary with `fetch` stubbed.

### DLQ replay cap

`MAX_REPLAYS = 3` (`src/lib/queue.ts`). Each DLQ replay increments the job's `replays`; once it has been replayed 3 times, a further
replay is refused. The drain **skips** capped entries (they stay in the DLQ),
reports them in `refused`, and continues, so one capped job cannot block the rest. `/failed/retry`
responds `{retried, retried_count, skipped, refused, not_found}`.

## Observability

`GET /metrics` serves Prometheus text exposition. It is the **only unauthenticated route**,
because Prometheus cannot produce this service's HMAC signature; that is acceptable only
because the exposition carries counts and queue depths — never recipients, variables or message
content. Keep it that way.

Counters live in **Redis**, not process memory, because the worker that performs every send runs
in a *separate process* from the API server that answers the scrape (`src/server.ts` forks it).
An in-process registry would expose an API process that has sent nothing. Queue depths are read
live at scrape time rather than counted, so they cannot drift.

| Metric | Type | Labels |
|---|---|---|
| `ns_sms_send_total` | counter | `provider`, `result` (`ok`/`failed`) |
| `ns_sms_provider_error_total` | counter | `provider`, `code` (`EC1003`, `HTTP_502`, `OTHER`) |
| `ns_job_dlq_total` | counter | `channel`, `reason` |
| `ns_audit_write_failures_total` | counter | `stage` (`dispatching`/`sent`/`queued`/`failed`) |
| `ns_recovery_abandoned_total` | counter | — |
| `ns_partition_default_rows` | gauge | `parent` (1 = default partition non-empty) |
| `ns_provider_balance` | gauge | `provider` |
| `ns_provider_balance_updated_at` | gauge | `provider` |
| `ns_provider_balance_poll_failures_total` | counter | `provider`, `reason` |
| `ns_queue_depth` | gauge | `queue` (`realtime`/`other`/`retry_count`/`dlq`) |
| `ns_retry_eta_seconds` | gauge | — |

Two constraints on this exposition that are easy to undo:

- **Label values are sanitised and error codes are allowlisted** (`EC1\d{3}` /
  `HTTP_\d{3}`, else `OTHER`). `|`, `,` and `=` delimit the Redis field
  encoding, so an unsanitised vendor string round-trips as a different series —
  or as a malformed name, and Prometheus rejects the **entire** scrape document
  on one parse error. Codes come from vendor responses, so they are also an
  unbounded-cardinality source into a hash with no TTL.
- **`renderPrometheus` does not catch its Redis reads.** `incr` swallows because
  it has a send in flight to protect; the scrape has none. Serving 200 with the
  counters absent looks like a healthy service with no traffic, which is exactly
  the reading under which no alert can fire. Let it fail and surface as `up==0`.

`ns_provider_balance` exists because `EC1003 Insufficient Balance` is otherwise a silent
killer: every send fails permanently and looks exactly like a bad template id from the outside.
The worker polls Pinnacle's `/checkbalance` on `BALANCE_POLL_INTERVAL_MS` (default 15 min) and
only when `SMS_PROVIDER=pinnacle`. Metric **writes** are best-effort and swallow their errors —
a Redis hiccup while recording a send must never turn a delivered message into a retry.

The balance gauge ships with `ns_provider_balance_updated_at` and a failure counter because the
value alone cannot distinguish a healthy balance from a poller that died an hour ago, and the
gauge has no TTL — a silent poller would report the last healthy number forever while every send
dead-letters on EC1003. **Alert on staleness, not just on the number.**

## Known Issues

Two design problems found while writing the tests, both filed rather than fixed:

- **#51 — `popScheduledRetries` is not atomic.** It does `zrangebyscore` then
  `zremrangebyscore` in two round trips, deleting by *score range* rather than by the members
  read, despite a comment claiming atomicity. A retry written between the two calls is deleted
  without being returned (silent job loss, no concurrency required), and two workers can both
  return the same jobs.
- **#52 — the nonce is claimed before the signature is verified.** A client with a bad
  signature gets `Invalid signature` first and `Replay detected` on every retry with the same
  nonce, and anyone who knows a key id (it is not secret) can write nonce keys unauthenticated.

## CI

Three workflows (plus `security.yml`). The split is load-bearing: **`ci.yaml` checks,
`notification-image-build.yaml` publishes, and the two are connected by a gate rather than
by `needs:`.**

- **`ci.yaml`** — `pull_request` on `main`/`develop`/`feature` and `push` on `main`/`develop`.
  The `ci` job does a frozen install, `pnpm build` (which is `tsc`, so it is the type-check
  too), then `pnpm test` plus the integration suite against a real Redis service container.
  Added in #46; before that this repo had **no CI at all**, which is how a tsconfig
  incompatible with TypeScript 7 reached `main` and broke image publishing for a week. A
  second job, `smoke-image`, builds the image on the PR path with `push: false` — that is the
  only thing that exercises the `Dockerfile` before a release tag is cut, and the two Docker
  gotchas below are exactly the class of breakage it catches. It is gated on `DOCKERHUB_TOKEN`
  so fork and Dependabot PRs skip with a warning rather than failing on the absent dhi.io
  credential.
- **`notification-image-build.yaml`** — builds and pushes the GHCR image on a **release tag**
  (`v*.*.*`, `20*-s*-rc*`) or a **manual run** only (#756). It previously also published on
  pushes to `main` and `feature`; those triggers are gone, and `:latest` now follows releases
  rather than the `main` branch.
- **`cut-release.yaml`** — the front door for cutting a release. Dispatch it with a tag name
  and a base branch; it checks CI, creates the tag and the GitHub release with generated notes
  in one API call, then dispatches the image build. `dry_run` previews the notes without
  creating anything.

**The CI gate (Blue-Dots-Economy/signals-dpg#765).** This repo never had one — the image build
has always been a separate workflow from `ci.yaml` — so a release tag could publish an image
built from a commit whose tests never ran. Both `notification-image-build.yaml`'s `verify-ci`
job and `cut-release.yaml` now query `ci.yaml` runs for the commit and refuse unless one
concluded `success`. Three things about it are deliberate and easy to undo by accident:

- It reads **workflow runs**, not check runs, so it stays correct if the job names or the job
  graph inside CI change.
- It **fails closed when there are zero runs**. That is the realistic accident (a tag on a
  commit CI never saw), not a tag on a commit CI rejected; a "did it fail?" test would pass it.
- Both carry a `skip_ci_check` input for an emergency publish, which logs a warning naming the
  commit so the bypass is visible.

**Cut releases from `develop` or `main`, never `feature`.** Merges into `feature` run no CI —
`pull_request` runs record the PR head, not the resulting merge commit — so the gate will
refuse a tag cut there.

**Two GitHub behaviours the release path depends on**, both of which look like bugs when you
hit them: a tag pushed with `GITHUB_TOKEN` does **not** trigger `on: push: tags` (GitHub
suppresses it to prevent recursion), which is why `cut-release.yaml` creates the tag through
the REST API and then dispatches the build explicitly; and a workflow is **not dispatchable
until it exists on the default branch**, so `cut-release.yaml` will not appear in the Actions
tab while it sits on a side branch.

**Two Docker gotchas**, both of which broke the image build in ways CI did not see:

1. The Dockerfile must `COPY pnpm-workspace.yaml` alongside `package.json` and
   `pnpm-lock.yaml`. That file holds the pnpm `overrides` (pnpm 10 no longer reads them from
   `package.json`), and `--frozen-lockfile` compares that config against the lockfile — omit
   it and the build fails with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`.
2. The global pnpm must be installed at the **exact** version in `packageManager`, which the
   Dockerfile reads out of `package.json` with `sed` so the two cannot drift. A bare
   `npm install -g pnpm` takes whatever is latest: once pnpm 11 shipped, that newer pnpm
   honoured `packageManager: pnpm@10.x`, tried to self-provision it, and failed with
   `Cannot verify the identity of the @pnpm/exe.linux-x64 native binary: it is missing from
   pnpm-lock.yaml` — a build break with no change on our side.

## Common Patterns

**Adding a route:**
1. Create handler in `src/routes/myroute.ts`
2. Export a Fastify plugin function
3. Register in `src/app.ts` with `app.register(myRoutes)`

**Adding a provider:**
1. Create `src/lib/providers/<name>/` folder
2. Export `ProviderDefinition` from `index.ts`
3. Auto-discovered on startup

**Queue operations:**
Import helpers from `src/lib/queue.ts`:
- `enqueueNotification()` — Push to queue
- `processJob()` — Dequeue and send
- `retryJob()` — Move to retry sorted set
- `moveToDeadLetter()` — Move to DLQ

## Deployment Notes

- **Worker process:** One worker is spawned alongside the API server in the same Node process. For scale, spawn separate worker processes pointing to the same Redis instance.
- **Redis requirement:** Redis 6+ (uses sorted sets for retries, lists for queues), `noeviction`, `INFO` allowed, password set.
- **Postgres requirement:** the `notification` database must exist (bluedots-automation's common-services bootstrap creates it) **before this image is deployed**; NS exits at boot without it. Migrations run on boot under an advisory lock, so multiple API instances can start together behind a load balancer. The pod needs the RDS CA in `NODE_EXTRA_CA_CERTS` if `DATABASE_SSL=require`.
- **Docker:** `Dockerfile` and `docker-compose.yaml` included. Compose also starts Postgres (pg_partman image from `docker/postgres`) and Redis.
- **Node 24** — `dhi.io/node:24-alpine-dev` for the build/prod-deps stages and
  `dhi.io/node:24-alpine` for the runtime (three stages, not two — the runtime has
  no shell, so the production install happens in `prod-deps` and is copied in),
  `node-version: 24` in CI, and
  `engines.node: ">=24"` in `package.json`. Keep all three in step; `@types/node` is pinned to
  the matching major (`^24`) on purpose, since types ahead of the runtime let code compile
  against APIs that do not exist where it runs.
- **Dependency overrides** live in `pnpm-workspace.yaml`, not the `pnpm` field of
  `package.json` (pnpm 10 stopped reading that and only warns). The file is present solely as
  pnpm's settings home — this is not a workspace.
