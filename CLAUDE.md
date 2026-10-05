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
     is logged and the periodic sweep (every 5 minutes) retries. Config validation
     (`validateBootConfig`, `src/lib/boot-config.ts`) includes the **worker's** pool, rate-limit,
     deadline and timeout settings, so a typo such as `RATE_SMS_BURST=abc` fails the API boot
     before listen instead of killing only the forked worker.
   - Spawns one background worker process. If the worker exits for any reason, the API exits
     with its code (1 if it was killed by a signal), so the orchestrator restarts the pod: there
     is never a healthy-looking API queueing work that nothing drains.

2. **Request Pipeline** (e.g., `POST /notify`)
   - Authentication: bearer token or HMAC signature, plus route scope (`src/plugins/auth.ts`)
   - Payload validation via Zod schemas
   - Record in Postgres and enqueue to Redis (order depends on priority; see Persistence)

3. **Background Worker** (`src/lib/worker.ts`)
   - Runs in a separate process spawned by server
   - Runs worker pools, one per priority (urgent, normal, bulk), each loop on its own blocking
     Redis connection, plus a retry scheduler that moves due retries back into their own queue
   - Takes a vendor-quota token before every send; a denied job is deferred, not failed
   - Retries failed sends with exponential backoff; expires jobs past their deadline
   - Moves exhausted or permanently failed non-redacted jobs to the dead-letter queue
   - See *Priority isolation* below

### Redis Queues

Five Redis structures drive the queue model:

```
queue:realtime  → List of urgent jobs (internal priority `realtime`)
queue:other     → List of normal jobs (internal priority `other`)
queue:bulk      → List of bulk jobs
queue:retry     → Sorted set for delayed retries and deferrals (score = Date.now() + delay, epoch MS)
queue:dlq       → List of dead-letter jobs (max retries exhausted)
```

Each queue has its own pool of loops (`src/lib/pools.ts`), sized by
`WORKER_URGENT_CONCURRENCY`, `WORKER_NORMAL_CONCURRENCY` and `WORKER_BULK_CONCURRENCY`
(defaults 2 / 2 / 1; a value that is not a positive integer fails the API boot).
Every loop owns one blocking connection (`redis.duplicate()`): a `BRPOP` blocks its connection,
so a shared one would let a bulk pop hold up an urgent pop. A long bulk send therefore blocks only
its own loop. Per-connection Redis errors are logged at most once a minute per message, with no
values.

The retry scheduler (one per worker) moves due members of `queue:retry` back to the queue of their
own priority in one atomic Lua step, at most `RETRY_BATCH` (1000) per call, so a retry never
changes pool. A queue or retry entry that is not JSON, or has no string `job_id`, is dead-lettered
raw and logged without its content, never lost. This includes malformed `queue:realtime`
entries: a raw entry cannot be classified as redacted, so it is the one way an urgent payload can
reach the DLQ (only a non-NS writer could produce one).

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
- **Redaction is sticky.** `/notify` sets `audit.redactValues` (true for realtime) on the job, and
  `toAcceptedRecord` keys on it, not on the current priority: a DLQ replay of an OTP as `other`
  still persists names only and no job copy. Jobs without the flag fall back to the priority.
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

**Attempt markers.** The worker writes `ns:attempt:<attemptId>` = `<sent|retry|failed|expired>:<attemptNo>`
(TTL 7 days). `sent`/`failed`/`expired` are written right after the fate is decided and **before** the stamp
(best-effort); a v1 fall-through's `failed` marker rides in the MULTI that queues the next delivery. `retry` is written **after** the `queued` stamp, in the **same MULTI** as the
retry-set ZADD (`queue.scheduleRetryWithMarker`), so the marker exists iff the retry is scheduled:
a crash before the MULTI leaves no marker and recovery re-queues the job. The number
is the attempt the matching stamp would write (`retry` → the next attempt), so a marker left by an
earlier attempt never hides a later attempt's crash. A failed `sent` stamp therefore no longer
leads to a re-send. A double failure (stamp fails **and** Redis loses the marker) can still
re-send: delivery is at-least-once.

**Status model.** Rows are upserted monotonically on `(attempt_no, status_rank)`, so a late or
replayed stamp cannot move a row backwards. An event's status mirrors its *current* attempt, so it
can read `accepted` again when a retry is queued. A DLQ replay is a **new** attempt row (fresh
`attemptId`, same event) and **clears the job's deadline** (an explicit operator action; redacted
jobs never reach the DLQ). Multi-attempt events (`delivery_mode` `all` / `first_available`) are
rolled up from all their attempts by `rollUpEvent` (`store.ts`), under a `FOR UPDATE` lock on the
event row, from both `upsertAttempt` and recovery: `all` → `partially_delivered` when mixed;
`first_available` → `sent`/`delivered` if **any** attempt reached it (never back to `failed`),
else the latest attempt (open first, then most recently completed: attempts share `created_at`).

**Recovery (`recoverLostJobs`).** `ns:epoch` in Redis means "Redis still has its data".
- If it is missing, the holder of a short `ns:recovery` lock re-queues recoverable open attempts
  last touched **before Redis started** (uses `INFO server` uptime) and sets the epoch only after
  every batch committed. The cutoff (`now() - uptime`) is computed **once** before the first batch
  as an absolute timestamp; a per-batch `now()` would drift forward and re-queue rows that live
  traffic wrote during the run. NS therefore needs `INFO` allowed on Redis; with `INFO` disabled every
  recovery run fails while the epoch is missing (**including the first deploy**), so lost work is
  never recovered.
- Stale `dispatching` rows (> 10 min) are re-queued: at-least-once by design.
- Every event whose attempt recovery writes (stamped from a marker, abandoned or re-queued) is
  rolled up by `rollUpEvent` in the same transaction, in sorted order.
- Every candidate (recoverable, with a job copy) is resolved in order: its **attempt marker**
  (`sent`/`failed`/`expired` → that state is stamped and the event rolled up, `retry` → left alone, the job is in the retry set);
  then **age** — created more than `RECOVERY_MAX_AGE_HOURS` (default 24) ago → marked `failed`
  (`abandoned: not delivered within recovery window`), counted in `ns_recovery_abandoned_total`;
  otherwise re-queued onto **its own priority's queue** (`pushManyToPriority`: one `MULTI`, each
  job to `QUEUE_KEYS[job.priority]`, an unknown name to `queue:other`), so a recovered job never
  changes pool.
- Work runs in keyset batches of 500 (`FOR UPDATE SKIP LOCKED`), each its own transaction with
  `SET LOCAL statement_timeout = '60s'` and one Redis `MULTI` push; a failed push rolls back that
  batch only. A connection whose `ROLLBACK` fails is destroyed (`release(err)`).
- A `FLUSHALL` without a Redis restart is **not** fully recovered (only stale `dispatching` rows).
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

### Authentication

One preHandler, `authenticate({ scope, legacyHmacV1? })` (`src/plugins/auth.ts`), guards every route except `GET /metrics` (unauthenticated, content-free). A request carries **one** of two credential types:

- **HMAC v2** headers: `X-NS-Key`, `X-NS-Timestamp`, `X-NS-Nonce`, `X-NS-Signature: v2=<64 lowercase hex>`.
- **Keycloak bearer token**: `Authorization: Bearer <jwt>`.

An `Authorization` header together with any of the four HMAC headers is `401 Ambiguous credentials`; the caller picks one.

**HMAC v2.** The signature is HMAC-SHA256 with the key's secret over
```
METHOD\npath\ntimestamp\nnonce\nsha256(body)
```
`path` is `req.url` including the query string. The digest is lowercase hex SHA-256 of the exact body bytes, or of the empty string when there is no body. The signature format is strict: `v1=` or `v2=` followed by 64 lowercase hex characters. Allowed clock skew is 30 s; a non-numeric timestamp is `401 Request expired`. The **signature is verified first, then the nonce is claimed** (`nonce:<keyId>:<nonce>`, `SET NX EX 60`), so `Replay detected` always means a correctly signed request seen twice.

**Bodies.** JSON is the only accepted body type; any other content type is `415` before authentication runs, and every accepted body is covered by the v2 signature. A bodyless POST (publish, retire, `POST /failed/retry`) sends no `Content-Type`, or sends `{}` as JSON; an empty body declared as `application/json` is `400`. `registerRawJsonBody` (`src/plugins/raw-body.ts`) removes all default content-type parsers and installs one `application/json` parser that keeps the raw bytes on `req.rawBody` and then parses with Fastify's own JSON parser. The built-in parser is replaced because it hands over only the parsed object, and re-serialising an object does not reproduce the bytes the caller signed.

**HMAC v1** (`METHOD\npath\ntimestamp\nonce`, no body digest) is accepted on legacy `POST /notify` only (`legacyHmacV1: true`), until the cutover release deletes that route. Every other route answers `401 Signature version not accepted` for `v1=`.

**Scopes.** Two scopes: `notify:send` and `templates:admin`. A route's scope is in its `authenticate` options; the table is pinned by `src/__tests__/route-scopes.test.ts`.

| Route | Scope |
| --- | --- |
| `POST /v1/notify` | `notify:send` |
| `POST /notify` (legacy; HMAC v1 or v2) | `notify:send` |
| `/v1/admin/templates*`, `/v1/admin/policies*` | `templates:admin` |
| `POST /failed/retry` | `templates:admin` |
| `GET /providers`, `GET /providers/:name`, `GET /metrics/queue` | any authenticated principal |
| `GET /metrics` | none |
| `GET /`, `GET /openapi.json` | none; registered only when `NS_DOCS_ENABLED=true` |

A missing scope is `403 {"error":"Insufficient scope","required":"<scope>"}`. `POST /failed/retry` needs `templates:admin` because replaying the dead-letter queue re-sends other callers' messages: a sending-only credential gets `403` there. Administration of DLT-registered templates likewise needs the admin scope, which a sending credential does not carry.

**HMAC keys and scopes.** `INTERNAL_SECRETS_JSON` names a file of this shape (`src/lib/auth/secrets.ts`, validated at boot):
```json
{ "<keyId>": { "secret": "...", "scopes": ["notify:send", "templates:admin"] } }
```
`scopes` is optional and defaults to `["notify:send"]`, so a key may send but administers nothing unless it is granted `templates:admin`. Unknown scopes (reported by index, `scopes[<i>] is not a known scope`, never by value), an empty list, a non-string `secret` or a non-object entry fail the boot. An entry whose `secret` is **empty or whitespace-only** is skipped with a `console.warn` naming the key id only, and `getKey` returns `null` for it (`401 Invalid key` at request time): deployments render an unset secret as `""` (e.g. `"keycloak": {"secret": ""}` when the SMS plugin secret is unset) and chart defaults use a placeholder space, and throwing would stop the pod from booting. Each `loadSecrets()` replaces the whole key set.

**Bearer tokens** (`src/lib/auth/bearer.ts`). One Keycloak realm is shared by every service, so a token must carry `aud` = `NS_AUTH_AUDIENCE` **and** an `azp` on the `NS_AUTH_ALLOWED_AZP` allowlist. Signature, issuer and audience alone are not enough.
- `typ` must be `Bearer`; `exp` and `sub` are required. Algorithms: RS256, PS256, ES256; 30 s clock tolerance.
- Scopes are the `notification-service` client roles in `resource_access` (`notify:send`, `templates:admin`). The audience comes from the role grant (Keycloak's built-in `roles` client scope adds `aud: notification-service` to a token whose subject holds a `notification-service` client role), so granting a role is the whole act of authorising a caller and no client definition changes.
- Principal id: the caller is a service account only when `client_id === azp` (id = `azp`); otherwise the id is `<azp>:<sub>`.
- Env: `NS_KEYCLOAK_ISSUER` turns bearer auth on; it must equal the token `iss` exactly (`https://<host>/auth/realms/<realm>`), with **no trailing slash**, and be an http(s) URL, or boot fails. `NS_KEYCLOAK_JWKS_URI` is optional (default `<issuer>/protocol/openid-connect/certs`). `NS_AUTH_AUDIENCE` defaults to `notification-service`. `NS_AUTH_ALLOWED_AZP` (comma-separated client ids) must list at least one client when the issuer is set. With no issuer, a bearer token is `401 Bearer auth not enabled`.
- Status codes: a bad, expired, wrong-audience or non-allowlisted token is `401`; a key set that cannot be fetched (unreachable, timeout, non-200 or invalid set) is `503 Auth service unavailable`.
- **`jose` is ESM-only**, and this package builds as CommonJS under `module: Node16`. It is loaded with `await import('jose')`; a static `import` is compile error TS1479. Type-only imports use `with { 'resolution-mode': 'import' }`. Tests inject a local key set with `setKeyResolverForTests`.

**`NS_DOCS_ENABLED`.** The API reference (`/`) and `/openapi.json` are registered only when `NS_DOCS_ENABLED=true`. The local-dev `example.env` sets it; deployed environments leave it unset.

**Caller identity in audit rows.** The audit `source` on `/notify` and `/v1/notify`, and the admin `created_by`/`published_by`, are `principalLabel(req.principal)`: `hmac:<keyId>` or `bearer:<id>`. Rows written before this change hold the bare key id.

**Rejection logging.** Every refused request logs `{ status, error, credential }` with message `auth rejected` (`credential` is `bearer`, `hmac`, or `both` for ambiguous credentials) — at `warn`, or at `error` for a `503`. The token, signature, nonce, key secret and `Authorization` header are never logged.

Implementation: `src/lib/auth/` (`secrets.ts`, `hmac.ts`, `bearer.ts`, `principal.ts`), `src/plugins/auth.ts`, `src/plugins/raw-body.ts`.

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
`admin-policies.ts`. Send API v1 (`POST /v1/notify`) uses them; legacy `/notify` does not.

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
→ `(domain, any)` → `(any, any)` default. Publish requires an active template for every channel
listed, checked at publish only: a template retired later surfaces as an error at send time.
`planDelivery(policy, contacts)` filters the channel list by what the caller supplied (email needs
an email address; sms and whatsapp need a phone) because NS holds no user directory. `first_available`
tries candidates in order; `all` fans out.

**Admin scope.** `/v1/admin/templates` and `/v1/admin/policies` need the `templates:admin` scope, from an HMAC key's `scopes` entry or a bearer token's role (see Authentication). Editing a DLT-registered template has a compliance blast radius a sending credential must not carry; a credential without the scope gets `403 Insufficient scope`.
Request bodies (including each variable spec) are strict, so unknown keys → `400`; list query params are not strict.
Errors: `404 not_found`, `409 invalid_state`, `422` for any other rule violation, `503
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
environment defaults. If rows exist only for another vendor (the deployment switched vendor), the
current vendor's template is created and published, which retires the old vendor's active row. Replicas booting together
serialise on a session advisory lock. Seeding is non-fatal (logged, never blocks listen) and is
skipped when `NS_NETWORK` is unset; a template that fails publish validation is left as a draft.

### Content resolver

Code: `src/lib/content/` (`types`, `configmap`, `resolver`, `inject`). A template variable can take its
value from shared content, such as a terms-and-conditions link, instead of from the caller.

**Variable fields.** `source: "request"` (default) or `"content_ref"`, plus `contentKey` for
`content_ref`. The key is dotted lowercase segments matching `CONTENT_KEY`
(`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,7}$`), e.g. `tnc.in_force.url` or `tnc.on_offer.text`; NS does
not interpret the segments, and `in_force` versus `on_offer` is part of the key (an acceptance receipt
carries the in-force text, a re-consent broadcast the offered one). A `content_ref` variable is always
required, is never `sensitive` (shared public content has nothing to redact), and may be `raw` under
the same email-only rule as other variables.

**File format.** One JSON document, at most 1 MiB:
`{ "version": "2026-10-01", "entries": { "<key>": { "<locale>": "<value>" } } }`. `version` matches
`^[A-Za-z0-9._-]{1,64}$`; locales look like `en` or `en-IN`; at most 500 keys; each value is a
non-blank string of at most 2000 characters. Unknown top-level fields are rejected. A `url` variable's
value passes the same checks as a caller URL (http(s), no userinfo, `urlHosts` when declared).

**Configuration.** `NS_CONTENT_PROVIDER` (`configmap`), `NS_CONTENT_FILE` (the path), and
`NS_CONTENT_RELOAD_MS` (1 to 3600000, default 30000). Deployments set
`NS_CONTENT_FILE=/app/content/content.json`. The provider reads only that file, never environment
variables, secrets or other config. The provider interface leaves room for `db` and `http` providers
as a configuration change.

**Allowlist (E1).** The keys of the loaded file are the allowlist. A template may reference a key only
if the current file defines it; there is no second list of permitted prefixes. Keys come from template
contracts, which only `templates:admin` can write, never from requests.

**Resolution at accept (E2).** Content resolves where the send is planned, so a failure is a
synchronous `422` and a queued message carries the version current when it was accepted. The worker
never consults content. Values are memoised per `(key, locale, version)`. Preview and publish resolve
content too: publish checks that the key exists, that the template's locale chain resolves
(`content_unresolved`), and that the value passes the variable's type and `urlHosts` checks
(`invalid_content`). A template cannot be published before its content exists for its locale.

**Locale chain.** The resolved template's locale, then its language, then `NS_DEFAULT_LOCALE`.

**Errors.** All four are configuration errors (`422`, `kind: configuration` on `/v1/notify`), and a
send is refused rather than rendered with an empty value:
`content_unavailable` (no content loaded), `unknown_content_key`, `content_unresolved` (no value for
the locale chain), `invalid_content` (the value fails the variable's type or `urlHosts` check).
Messages name the key and variable, never the value.

**Callers cannot supply content.** A request variable under a content variable's name is
`422 unknown_variable` (a caller error); content variables are not part of the caller contract.

**Event record (E3).** The event payload carries `content_refs`, a per-channel map
`{ "<channel>": [{ key, version, locale }] }`, de-duplicated per channel and built from each planned
delivery's own references. These are references, never values, and are recorded for redacted sends
too, so an audit can answer which terms version a message carried.

**Reload and boot (E4).** The first load happens at boot and the file is re-read every
`NS_CONTENT_RELOAD_MS`; a slow load never overlaps the next. Every successful reload takes effect
and clears the memo. A same-version reload that has different content still takes effect and logs a
warning (bump the version on edits). A bad or unreadable file keeps the last good snapshot and logs
the problem without values. An invalid `NS_CONTENT_PROVIDER` or `NS_CONTENT_RELOAD_MS` fails boot
like other config (`validateBootConfig`); a missing or broken content file never does: until a valid
file loads, `content_ref` sends answer `422 content_unavailable`.

**Rollout.** Publish templates with `content_ref` variables only after every pod runs a build with
the content resolver: an older pod treats the variable as a caller variable and answers
`missing_variable`.

**Isolation.** A template with no content variables never consults the resolver, so OTP and every
other send are unaffected by content being off, missing or broken.

**Mounting.** Mount the ConfigMap as a directory, not with `subPath`: Kubernetes updates directory
mounts in place and never updates `subPath` mounts, so only a directory mount receives edits
without a restart.

## Send API v1

Code: `src/routes/v1-notify.ts`, `src/lib/send/` (`request`, `plan`, `errors`, `idempotency`,
`resolver-cache`), and the
`job.v1` branch of `src/lib/worker.ts` (`processV1Job`, `failDelivery`, `fallThrough`). Legacy `/notify`
is unchanged and stays until the cutover release.

**Request** (`V1NotifySchema`, strict: unknown keys → `400`). Exactly one of `event_type` (a policy
picks the channels) or `template_key`; `template_key` requires `channel`, `event_type` forbids it.
`to` carries `email` and/or E.164 `phone` (at least one). `priority` is `urgent | normal | bulk`
(default `normal`), mapped to `realtime | other | bulk` by `PRIORITY_MAP`. `cc`, `reply_to` and
`attachments` are email-only: with `template_key` they require `channel: 'email'`, with `event_type`
they apply to the email deliveries (they ride only on jobs that hold an email delivery). `network` is never request input: it is `currentNetwork()`, and
unset answers `503 network_not_configured` on `/v1/notify` only. Free-text bodies and sender
identity are not accepted; the sender is server config (`EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME`).
Without `EMAIL_FROM_ADDRESS` an email delivery fails permanently with `email sender not configured`.

**Planning** (`planSend`) renders and validates everything before the request is accepted. Request
variables are checked against the union of the planned templates' contracts (a name declared by none
is `unknown_variable`); each template renders with only its own declared variables. A failure is
`422 {error, kind, message, details?}` and counts `ns_send_rejected_total{kind,code}`:
- `caller`: `missing_variable`, `unknown_variable`, `invalid_variable`, `no_reachable_channel`.
- `configuration`: `not_found`, `vendor_mismatch`, `incomplete_template`, `body_too_long`,
  `unknown_channel`, `no_policy`.
With `template_key` a configuration problem fails the request. With a policy, a candidate whose
template cannot resolve or render is skipped while another can carry the message; if none can, the
first configuration error is returned. Messages name variables and keys, never values.

**Resolver cache** (`resolver-cache.ts`). `planSend` resolves templates and policies through an
in-process stale-while-revalidate cache keyed by network and the resolver arguments (channel, key,
locale; domain, event type), so a send for a template or policy this pod has already resolved makes
**no Postgres read**. Only positive results are cached: a missing policy or a template error
(`not_found`, `vendor_mismatch`, ...) re-queries every time. An entry older than
`NS_RESOLVE_CACHE_TTL_MS` (default 60 s, validated at boot) is still served, and one single-flight
background refresh per key replaces it; a refresh that fails on the database keeps the stale entry
(logged through `describeDbError`), one that finds nothing active drops it. A **cold miss** does read
Postgres; if that read fails the send is refused `503 {"error":"template store unavailable"}` and the
claim released. Bounded to 1000 keys, oldest first. Admin publish/retire clears this pod's cache;
other pods pick the change up through the background refresh, so each key there serves the old
version for up to the TTL, plus one more request if the key sat idle longer than the TTL.

**Modes and event status.** `single` (template_key), `first_available` and `all` (policy). A request's
jobs are enqueued in one MULTI (`pushManyToPriority`): `all` is one job per delivery,
the others one job carrying every candidate. Event status: `single` mirrors its attempt; `all` is a
roll-up across deliveries (`partially_delivered` when outcomes are mixed); `first_available` is
`sent`/`delivered` if any attempt got there, otherwise the latest attempt's status, so it never
regresses. `rollUpEvent` (`audit/store.ts`) does this inside the attempt's transaction under the
event row lock.

**Fallthrough** is synchronous only. A `first_available` delivery that fails permanently or exhausts
its retries is closed `failed` and the next candidate starts as a **new attempt row** (fresh attempt
id, attempt counter reset; `ns_send_fallthrough_total{from,to}`). Order, like a retry: stamp the new
attempt `queued` → one MULTI {LPUSH it, SET the old attempt's `failed` marker}
(`queue.pushToPriorityWithMarker`) → stamp the old attempt `failed`, so the old marker exists iff the
next delivery is queued. If the deadline has passed the event
expires instead. The `expired` fate is recorded by marker (`markAttempt`). Async bounces after a
vendor accepted a message are out of scope (Stage 2.5/3). The last delivery takes the legacy fate
(`dropOrDeadLetter`). `sendRendered` sends the content rendered at accept and never re-renders; a
vendor change since accept (`vendor_changed`) fails the delivery.

**Redaction.** A send is redacted when its priority is `urgent` **or** any planned template declares
a `sensitive` variable. A redacted send persists only the variable **names** (`audit.variableNames`),
keeps no job copy, is not recoverable, and is never dead-lettered (`ns_job_dropped_total`). Urgent
sends enqueue first and write the audit row afterwards, so the audit write never delays an OTP (planning
reads Postgres only on a resolver-cache miss);
normal and bulk record first and answer `503 audit store unavailable` if they cannot. The event
payload records every contact point the request supplied (`to: {email, phone}`, via
`audit.recipients`), recipients only, for redacted sends too.

**Deadline**, in order: request `deadline` (ISO-8601 with offset, in the future, at most 24 h ahead,
else `400 invalid_deadline`) → the smallest `default_deadline_s` among the planned templates → for
`urgent`, `URGENT_DEFAULT_DEADLINE_S`. DLQ replay clears the deadline (an explicit operator action).

**Idempotency** (`idempotency.ts`). `idempotency_key` is 1-128 chars and is claimed before planning.
`urgent` claims live in Redis (`idem:<network>:<key>`, 15-minute window) so the claim makes no
Postgres round trip (with the resolver cache warm, neither does planning); `normal` and `bulk` use the
Postgres `idempotency_key` table, pruned after 90 days. A repeat returns `200` with the original
response; a repeat while the first is in flight is `409 idempotency_in_progress`. **Urgent replays
expire with the Redis window**: after 15 minutes the same key is a new send. A Postgres claim with no
response older than 15 minutes is reclaimable (Redis expires by TTL). Completing the claim is retried
once; if both tries fail the send still stands and the claim stays pending, so a repeat answers `409`
until the 15-minute window makes it reclaimable. Any refusal after a claim releases it. Without a key,
a 5-second content guard answers a repeat with `409 duplicate-fallback`.

**Correlation id.** The body's `correlation_id` (trimmed, at most 128, else `400`) wins over the
`x-correlation-id` header; blank falls back to the header, then the event id.

**Response:** `202 {notification_event_id, correlation_id, status: "accepted", mode, deliveries:
[{channel}]}`. See README for examples.

## Key Files

**Routes** (`src/routes/`):
- `docs.ts` — Scalar API reference and OpenAPI JSON
- `notify.ts` — Enqueue notification endpoint (legacy)
- `v1-notify.ts` — Send API v1 (see Send API v1)
- `providers.ts` — Provider discovery endpoints
- `metrics.ts` — Queue metrics endpoint (authenticated JSON) **and** `/metrics`,
  the unauthenticated Prometheus scrape endpoint
- `retry.ts` — Manual DLQ retry endpoint (`refused` in the response; see DLQ replay cap)
- `admin-templates.ts`, `admin-policies.ts` — template and policy admin API (see Templates and policies)

**Library** (`src/lib/`):
- `queue.ts` — Redis queue and retry helpers
- `metrics.ts` — Redis-backed Prometheus counters/gauges (see below)
- `worker.ts` — `processJob` (deadline, quota, send, retry/DLQ decision) and worker boot
- `pools.ts` — Per-priority worker pools and the retry scheduler
- `rate_limit.ts` — Split shared/reserved vendor quota
- `deadline.ts` — Deadline and redaction helpers
- `db/`, `audit/` — Postgres client, migrations, partition maintenance, audit store, stamps, recovery (see Persistence)
- `auth/` — `secrets.ts` (signing keys and scopes from `INTERNAL_SECRETS_JSON`), `hmac.ts`, `bearer.ts`, `principal.ts`
- `providers/` — Provider implementations (auto-loaded)
- `utils/openapi.ts` — OpenAPI document builder
- `utils/provider-docs.ts` — Provider schema/payload serialization

**Other**:
- `types/index.ts` — `NotifyRequest` and `Job`
- `types/provider.ts` — `ProviderDefinition` interface

**Tests** (`src/**/__tests__/`):
- `lib/__tests__/redis-fake.ts` — in-memory ioredis stand-in shared by the suites
- `lib/__tests__/queue.test.ts`, `lib/__tests__/dedupe.test.ts`, `plugins/__tests__/auth.test.ts`, `__tests__/route-scopes.test.ts`

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
- `NS_KEYCLOAK_ISSUER`, `NS_KEYCLOAK_JWKS_URI`, `NS_AUTH_AUDIENCE`, `NS_AUTH_ALLOWED_AZP` — bearer-token
  auth; see Authentication. `NS_DOCS_ENABLED` — serves `/` and `/openapi.json` when `true`.
- `NS_CONTENT_FILE` — optional; the content file for `content_ref` variables. Unset, content is off.
  Deployments set `/app/content/content.json`. `NS_CONTENT_PROVIDER` (default and only value
  `configmap`) and `NS_CONTENT_RELOAD_MS` (integer 1 to 3600000, default 30000) are validated
  whether or not a file is set: an invalid value fails boot like other config. A missing or broken
  content file never fails boot. See Content resolver.
- `NS_RESOLVE_CACHE_TTL_MS` — optional, default 60000, positive integer (invalid fails boot). See
  Resolver cache.
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

vitest 4, 711 unit tests across 51 files, plus 119 integration tests across 15 files. The unit suite runs in about a second because Redis
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
- Provider implementations against the real vendors (SES/Twilio/MSG91/Pinnacle network calls).
  The SMS adapters are covered at the request/response boundary with `fetch` stubbed.

### Priority isolation

A bulk send must not delay an OTP, and it must not exhaust the vendor quota an OTP needs. Three
mechanisms (`src/lib/pools.ts`, `rate_limit.ts`, `deadline.ts`, `worker.ts`):

**Split vendor quota.** Every send, from `/notify`, retries and DLQ replays alike, takes a token
first. Each channel and vendor has two token buckets, `rl:<channel>:<vendor>:shared` and
`rl:<channel>:<vendor>:reserved`. Urgent takes `shared` first, then `reserved`; normal and bulk
take `shared` only, so they can never consume the reserve. A denied job is **deferred** back to
`queue:retry` after `RATE_LIMIT_DEFER_MS` (default 250) plus up to 50% jitter, and the attempt is
**not** counted: a rate-limited job has not been tried. A token-check error (Redis hiccup) defers
the same way rather than dropping the popped job. The refill is clamped to the bucket capacity and
the key TTL is at least the time to refill, so an idle bucket expires cleanly. The bucket's stored
`ts` only moves forward (`max(ts, now)`): with clock skew between worker pods, or EVALs arriving
out of order, an older `now` would otherwise rewind it and re-credit the same gap (2 ms of skew
measured 15 grants against a 10/s limit before the fix).

**Deferral backoff.** `processJob` returns `{ deferredMs }` when it defers a job, and the pool
loop waits that long before its next pop, so a loop denied a token idles ~250–375 ms instead of
re-popping and re-denying in a tight loop. Every other outcome returns as before.

| Variable | Default | |
|---|---|---|
| `RATE_<CH>_PER_SEC` | sms 100, email 100, whatsapp 100 | Vendor rate, tokens per second; may be fractional |
| `RATE_<CH>_BURST` | sms 40, email 50, whatsapp 10 | Bucket size |
| `RATE_URGENT_SHARE` | `0.2` | Reserved fraction of rate and burst; `0 < share < 1` |
| `RATE_LIMIT_DEFER_MS` | `250` | Deferral before jitter |
| `PROVIDER_TIMEOUT_MS` | `10000` | Cap on every vendor call (HTTP, SMTP/SES, Pinnacle balance poll); a timeout is a retryable failure |
| `URGENT_DEFAULT_DEADLINE_S` | `600` | Deadline the legacy `/notify` gives `realtime` jobs |

`validateWorkerConfig` parses all of these at worker boot, and the API parses them (plus the pool
sizes) before listen via `validateBootConfig`. A bad value exits the process; a value parsed per
job would throw after the job was popped and drop it.

**Ops note — urgent pool sizing.** A hung vendor holds an urgent loop for up to
`PROVIDER_TIMEOUT_MS` (10 s) per job. With the default 2 urgent loops, a vendor that hangs on every
call caps urgent throughput at ~0.2 jobs/s; size `WORKER_URGENT_CONCURRENCY` for the urgent rate
you need times the timeout, or lower the timeout.

**Deadlines.** `Job.deadline` is an absolute epoch-ms. Legacy `/notify` sets it for `realtime` jobs
to now plus `URGENT_DEFAULT_DEADLINE_S`. `processJob` checks it first, and again before every
deferral and before scheduling a retry. A job past its deadline is never sent: marker `expired`,
status `expired` (the error keeps the last provider error, `deadline passed: <error>`),
`ns_job_expired_total`, and never the DLQ. An OTP that arrives late is worse than none.

**Redacted jobs are never dead-lettered.** A job with `audit.redactValues` (else `realtime`)
that would dead-letter instead ends `failed`, with the marker set, and is counted in
`ns_job_dropped_total{channel,reason}`; a DLQ entry would keep a live code at rest.
`dropOrDeadLetter` in `worker.ts` is the only DLQ writer in the worker, and the log lines say
`dropped (redacted, no DLQ)` or `→ DLQ` to match, with job ids only. Rollout: OTP jobs
dead-lettered before this change stay in `queue:dlq` until ops inspect and clear them. During the
rollout window, pods still on the pre-priority-isolation build ignore deadlines and still
dead-letter OTPs; all of them must be gone before bulk sends are accepted (Plan C2).

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
| `ns_rate_limited_total` | counter | `channel`, `priority` |
| `ns_job_expired_total` | counter | `channel` |
| `ns_job_dropped_total` | counter | `channel`, `reason` |
| `ns_send_rejected_total` | counter | `kind` (`caller`/`configuration`), `code` |
| `ns_send_fallthrough_total` | counter | `from`, `to` (channels) |
| `ns_queue_depth` | gauge | `queue` (`realtime`/`other`/`bulk`/`retry_count`/`dlq`) |
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

Design problems found while writing the tests, filed rather than fixed unless marked resolved:

- **#51 — `popScheduledRetries` is not atomic.** It does `zrangebyscore` then
  `zremrangebyscore` in two round trips, deleting by *score range* rather than by the members
  read, despite a comment claiming atomicity. A retry written between the two calls is deleted
  without being returned (silent job loss, no concurrency required), and two workers can both
  return the same jobs.
- **#52 — resolved.** The HMAC signature is now verified before the nonce is claimed, so only a correctly signed request can claim one and `Replay detected` always means a valid request seen twice.

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
