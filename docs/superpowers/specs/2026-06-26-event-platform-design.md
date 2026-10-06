# Event Platform & Notification-Service Redesign

> This is the umbrella design. It fixes the whole-platform vision, decisions, and phasing; each stage gets its own detailed spec.
> The architect copy alongside this file (`2026-06-26-event-platform-design.technical.md`) reflects the 2026-08-06 revision and is **superseded** by this one until it is regenerated.

## Revision history

- **2026-06-26** — original.
- **2026-08-06** — substantial revision. Reframed the ingress model (consumer-owned APIs are the default contract, the bus is for fan-out and decoupled reaction); added urgent-path isolation, the template/routing-policy split, the content resolver, the trace and status lifecycle, and a retention/PII policy; removed consent enforcement from notification-service's scope; re-ordered the stages so notification-service delivers value before any Kafka infrastructure exists; added the issue decomposition.
- **2026-08-06 (later)** — added §Security, reconciling the design against the Phase-B security audit (#15). Request integrity must cover the request **body**, and the `content_ref` keyspace must be allowlisted.
- **2026-10-04** — reconciled against two months of change across the repos. Keycloak (single shared realm) reached `feature` and is the only auth provider; Pinnacle was added as a second SMS vendor; Keycloak login OTP gained an `http` path into NS; the caller inventory grew well beyond the original draft. Decisions changed in this revision:
  - **One SMS/email/WhatsApp vendor per channel per deployment.** Templates carry the vendor's identifiers directly; render mode is a property of the vendor, not of the template. Multi-vendor routing is not built.
  - **All OTP is delivered through NS** — Keycloak login OTP (SMS *and* email) and Signals guardian OTP. Login OTP is generated and verified in Keycloak; guardian OTP is generated and verified in Signals-DPG. NS only delivers it (decided 2026-10-06).
  - **No legacy `/notify`.** `/v1/notify` replaces it in one coordinated release with Signals; Signals' cutover moves from Stage 2.5 into Stage 1.
  - **Network comes from deployment config**, not a token claim — one network per deployment.
  - **HMAC is permanent** for callers that cannot use `client_credentials` (Keycloak itself), and is extended to sign the body.
  - Postgres is a **database + role on the shared per-cluster RDS**; migrations run **on boot** under an advisory lock; partitions are managed by **`pg_partman`**.
  - Urgent sends carry a **deadline** and are dropped, not retried, once it passes.
  - aggregator's **BullMQ campaign email** joins Stage 2. **Valkey** leaves Stage 1.

## Overview

We're redesigning **notification-service** (NS) from an HTTP-only mailer into the **notification authority for the network**, and — later — the first consumer of a replayable event backbone.

The organising idea: **events are the spine of the network, but not the only wire.** Services emit domain events to a durable, ordered, replayable log; consumers react. Notification — email, SMS, WhatsApp, and outbound service-triggers like the voice bot — is the **first and most important consumer, not the centre.**

The routing rule that follows from that:

- **Call the consumer's API** when the caller needs to know it worked *now*. OTP, login, single transactional sends. NS's own API is the contract, not a fallback lane.
- **Emit an event** when the caller shouldn't know or care who reacts, or when fan-out must be durable and rate-limited.
- **OTP never rides the bus.** A hard non-goal.

This generalises: every consumer-routed service exposes its own API. The bus is not an RPC substitute, and putting a synchronous need behind a shared consumer group makes the consumer a bottleneck.

The platform is three parts, only one of which we build from scratch:

- **Event backbone** — an operated Apache Kafka cluster + its contracts. *Infra, not a codebase.*
- **Consumer SDK** — the shared library every producer/consumer depends on (envelope, idempotency, retry/DLQ, rate-limit, trace). *One new repo.*
- **Notification service** — today's notification-service, substantially extended. *Reused repo.* Useful on its own, long before the backbone exists.

## Goals

- **One notification authority** — every SMS, email, and WhatsApp message in the network, including all OTP, is delivered by NS; aggregator's parallel mail stack is retired. NS owns templates, routing, and delivery.
- Durable **audit** of what was sent, with an end-to-end **trace** from origination to closure.
- **Resilient, rate-limited, reportable bulk fan-out** (T&C re-consent, campaigns).
- Keep **OTP/login delivery low-latency and reliable** — it must not regress, and bulk must not be able to starve it.
- **Template governance** an admin can operate — content, DLT/Meta identifiers, and variable contracts edited through an API, not code.
- **Decoupled cross-service reactions** (including async response-handover to the user), from Stage 3.
- Every component **OSI-open and free** (DPG requirement).

## Non-goals

- **Not** enforcing consent. NS is a tool consent flows *use*, never a consent authority. See §Consent boundary.
- **Not** raising or verifying OTP. NS delivers a code it is handed. Which service owns OTP generation and verification is an open question (§Open questions); the answer does not change NS.
- **Not** routing one channel across several vendors. One vendor per channel per deployment (§Templates).
- **Not** building a workflow/orchestration engine. Choreography first; adopt Temporal only if a real saga appears.
- **Not** a generic RPC/data bus. Bulk export, profile fetch, and metric rollups belong elsewhere.
- **Not** a user directory. NS never resolves a person to their contact points; callers pass what they hold.

## Where things stand today

*As of 2026-10-04, `feature` at `38baa78`.*

**notification-service** is Fastify 5 with **no database**. Every route except `GET /metrics` is authenticated by a **hand-rolled HMAC** — `HMAC-SHA256` over `METHOD\npath\ntimestamp\nnonce` (the body is not signed), keys loaded from the JSON file at `INTERNAL_SECRETS_JSON`, Redis nonce replay protection (`src/plugins/request-auth.ts`). The nonce is claimed before the signature is verified (#52).

`POST /notify` is the only ingestion path. Three channels sit behind the `ProviderDefinition` contract with folder auto-discovery. Since the last revision:

- **Two SMS vendors**, selected per deployment by `SMS_PROVIDER` (`msg91` default, `pinnacle`). They are not the same shape: MSG91 Flow takes a flow id + named variables and renders the DLT body itself; Pinnacle takes fully **rendered text** plus explicit DLT ids, so NS renders (`ProviderDefinition.bodies`, `src/lib/providers/sms/render.ts`). Design: `2026-09-14-pinnacle-sms-provider-design.md`, whose deferred items 2–4 are resolved by this revision.
- **SMS raw pass-through** (`allowRawTemplateId`): callers send DLT flow ids directly, plus an optional free-text `body`. Most SMS ids therefore live in Signals, not NS.
- **Deduplication** (#88): explicit `dedupe_id` → 1 h window, `200 {enqueued:false}`; otherwise a 5 s content-hash guard → `409 duplicate-fallback`. Callers branch on the 409.
- **Email** gained configurable SMTP/SES transport, attachments, cc, and reply-to.
- **`retryable`** on send results (permanent failures dead-letter immediately), `provider_message_id` on results, Prometheus `GET /metrics` with Redis-backed counters, and a Pinnacle balance gauge.

Unchanged: async work runs on a **hand-rolled Redis queue** (`realtime`/`other` lists, a retry sorted set with 5-attempt backoff, a DLQ) drained by a forked worker; the per-provider **token bucket exists but has no callers**; **nothing is persisted**; WhatsApp's `other` escape hatch accepts an arbitrary `contentSid`. Test suite: ~160 tests, CI-wired.

**Callers today:**

| Caller | Sends | Notes |
| --- | --- | --- |
| signals-dpg | email via `basic_email` (Signals renders the HTML from properties-file copy) for ~15 cases: welcome, item lifecycle, connect/apply/shortlist, retire/cancel, aggregator-init, support (with attachments/cc/reply-to); guardian OTP by email **and** SMS; WhatsApp welcome via `other` | single dispatcher (`apps/api/src/notifications/email/dispatch_email.ts`); HMAC |
| keycloak-otp-authenticator | login OTP by SMS via its `http` provider → `/notify` `login_otp` | HMAC, key id `keycloak`. **Off on every live cluster** — they set `smsProvider: msg91` and call MSG91 directly. Login **email** OTP uses Keycloak's own SMTP. |
| aggregator-dpg | — | **Does not call NS.** `packages/mailer` (SMTP/SES) with ~8 templates from ~7 call sites, plus **bulk campaign email from a BullMQ worker**. No SMS. |
| bluedots-e2e | — | Reads NS's Redis queues directly to assert enqueues. |

So, today, **neither login OTP channel touches NS**, and neither does any aggregator email.

**Auth context:** Keycloak with **one shared `bluedots` realm** is live on `feature` and in infra; better-auth is retired. Service-to-service tokens are verified with `jose` against the realm JWKS, checking `azp`/`aud` allowlists (`signals-dpg/apps/api/src/utils/keycloak_token.ts`); the caller-side token provider pattern is aggregator's `packages/signalstack-writer`. Realm config source of truth: `aggregator-dpg/infra/keycloak/realms/realm.json`. No NS client exists.

**Infra context:** each cluster has one shared AWS RDS (PG 17) with a database and role per service, created by the `postgresBootstrap` job in `bluedots-automation/helm/common-services`. NS is a subchart of the `signals` umbrella chart, so NS and Signals deploy in one Helm release. Redis is a shared, auth-enabled Redis 7.4 instance. Secrets are SOPS + age (ALIMCO-TCS still has one Ansible-Vault file).

## Problems we're solving

1. **No durable record / audit / trace** — NS persists nothing; a Redis restart drops work; there is no way to answer "what happened to that message".
2. **Login delivery bypasses the authority** — login OTP goes straight from Keycloak to MSG91 or Keycloak's SMTP, and guardian OTP is separate again. Changing vendor or auditing OTP delivery means touching Keycloak.
3. **Duplicated notification stacks** — NS and aggregator each send their own way, including aggregator's bulk campaigns.
4. **No template governance** — bodies are hand-built by callers or held in Signals properties files, SMS DLT ids live in caller config, and any caller can send an arbitrary WhatsApp template. A wrong DLT template is a compliance incident and, because drift is scrubbed at the operator, a silent one.
5. **No routing policy** — nothing expresses "SMS for seekers, email for providers", or what to do when a recipient has no email.
6. **No resilient bulk fan-out** — broadcasts have no rate-limited, reportable path; the rate limiter isn't wired.
7. **Point-to-point coupling** — services trigger each other by direct RPC; no decoupled, replayable way to react to "X happened".
8. **Weak request integrity** — HMAC does not cover the body.
9. **DPG license compliance** — every component must be OSI-open and free; common defaults (Redpanda BSL, Confluent Schema Registry, Redis ≥ 7.4) violate this.

## Key decisions

### Ingress and isolation

**Two doors, with an explicit routing rule** (see §Overview). The transactional door (`POST /v1/notify`) is a near-synchronous send; the event door (produce via SDK + outbox/Debezium, Stage 3) is the resilient path for bulk and domain events.

**All OTP enters through the transactional door.** Keycloak login OTP (SMS and email) and Signals guardian OTP call `/v1/notify` with `priority: urgent`. For SMS on MSG91 this needs no new vendor capability — Keycloak's `http` provider sends `{ message: <code> }`, which NS maps to the same `var` the flow already uses. Email OTP needs a new `http` path in `keycloak-otp-authenticator`. Clusters switch only after priority isolation lands (Stage 1, item 10).

**Isolating the urgent path is a resource question, not a door question.** Bypassing the bus does not protect OTP — on the direct path it still shares NS's process, its Postgres, and the *vendor account*. A 200k-recipient broadcast will exhaust the vendor quota and queue OTPs at the vendor regardless of wiring. Therefore:

- `priority: urgent | normal | bulk` on the send API.
- **Separate worker pools per priority.** Bulk workers can never occupy an urgent slot.
- **Reserved vendor quota.** The token bucket is activated, keyed per channel × vendor, and *split*: urgent holds a configurable reserved share that bulk physically cannot consume.
- **Audit writes on the urgent path are fire-and-forget.** A slow Postgres must never delay an OTP.
- **Urgent sends carry a deadline.** `deadline` (defaulting per template, e.g. the OTP lifetime) bounds retries; once passed the attempt is terminal `expired` — not retried, not dead-lettered. A late OTP is worse than none, and a dead-lettered OTP job would keep a live code at rest.

One NS deployment, not two — the pools give the isolation without a second deployment's config surface.

### Templates and routing — two objects, not one

Templates carry *content*. Routing policy decides *which* template on *which* channel for *whom*. Collapsing them produces an unusable composite key and cannot express "send to both".

**One vendor per channel per deployment.** Each deployment configures one active vendor per channel (as `SMS_PROVIDER` does today). Running two vendors on one channel at once has no product requirement, and getting a template set DLT- or Meta-approved with a second vendor is a large enough task that deployments will not do it. Nothing below prevents adding it later — the vendor fields would move into a per-vendor binding table — but it is not built.

**`template`** — key `(network, channel, template_key, locale)`, versioned:

- **Content, constant across vendors.** Email: `subject`, `body_html`, `body_text`. SMS: `body_text`, which must be **byte-identical to the DLT-registered text** — stored for every vendor, because Pinnacle sends it, and for MSG91 it drives preview and variable validation. WhatsApp: the approved body, for preview and validation.
- **Vendor identifiers.** `provider` plus `provider_template_id` (MSG91 flow id / Pinnacle DLT template id / Twilio `contentSid`) and optional `sender_id`, `dlt_entity_id`, `dlt_header_id`, `dlt_tag_id`, `approval_ref`. Optional fields override deployment-level config (most deployments set sender and entity once).
- **Variable contract** — `name`, `required`, `type`, `source`, `sensitive` — validated at send time *before* the vendor is called, in every mode.

**The vendor is checked, never chosen.** A template's `provider` must match the deployment's configured vendor for that channel; a mismatch fails at publish and again, defensively, at send. Changing vendor is a deliberate re-registration of the template set — which a vendor change requires anyway, since DLT template ids are registered per telemarketer.

**Render mode is a property of the vendor.** Each `ProviderDefinition` declares `renders: 'ns' | 'provider'`. Email and Pinnacle render in NS from the stored body; MSG91 Flow and Twilio render vendor-side and receive only variables. There is no `render_mode` column and no third mode.

Lifecycle `draft → active → retired`; exactly one `active` per key; **retire never deletes**, because audit rows reference old versions. Callers send one stable `template_key` (or `event_type`) + variables and never see vendor identifiers.

**`notification_policy`** — key `(network, domain, event_type)` → ordered channel list, per-channel `template_key`, and a mode:

| Mode | Meaning |
| --- | --- |
| `first_available` | Try channels in order; fall through on failure or missing contact point |
| `all` | Fan out to every listed channel |

`domain` and `event_type` are nullable, so network-wide defaults and per-domain/per-event overrides are the same mechanism at different specificity; **most-specific-wins**.

**Policy lives in NS's database, edited through the admin API — not in `network.json`.** `network.json` is the network *contract*; how to notify a domain is a delivery concern. In `network.json`, every routing tweak would be a cross-repo PR plus a ConfigMap sync plus a redeploy per instance.

**Recipient capability — NS holds no user directory.** The caller passes every contact point it has (`{ email?, phone? }`); NS filters the resolved channel list to what is reachable. NS never calls Signals to resolve a person.

**Fallback has two clocks:**

- *Synchronous* failure (vendor rejects; no contact point for the channel) → fall through to the next channel immediately.
- *Asynchronous* failure (a bounce or DLR arriving later) → cannot be a retry-in-place. Before the backbone exists it records a terminal `failed` status, queryable by trace. From Stage 3 it emits `notification.delivery_failed`, and a policy may opt into async fallback.

### Consent boundary

**NS enforces nothing about consent.** Consent acceptance is enforced in Signals/aggregator code with records in their Postgres. Some consent flows need an OTP (an ordinary urgent send); some consent failures need an SMS or email (an ordinary send). In neither case does NS need to know what consent *is*.

**The caller owns the audience.** For bulk especially, the producer is responsible for having applied consent/opt-out when building the recipient list. `bulk_job.audience_basis` records the caller's assertion so a DPDP audit can answer "why was this person contacted" without NS holding consent state.

**But NS must be able to *render* consent content** — a T&C link or statement in the message body. That is served by the **content resolver**: a template variable may declare `source: content_ref` with a key like `tnc.in_force.url` or `tnc.on_offer.text`, resolved per locale by a pluggable provider — `configmap` today, `db`/`http` later — cached by `(key, locale, version)`. `in_force` versus `on_offer` is deliberate: during a consent notice period "the current T&C" is ambiguous.

### Trace and status lifecycle

Two identifiers, deliberately distinct:

- **`correlation_id`** — the business trace, caller-supplied or NS-generated, spanning the whole flow. The query key.
- **`trace_id`** — the W3C observability trace from `traceparent`, so records join OTel traces and the telemetry design's `cdata.trace_id`.

```
notification_event   accepted → resolved → dispatching → sent
                     → delivered | partially_delivered | failed | expired

delivery_attempt     queued → sent → accepted_by_provider
                     → delivered | bounced | failed | expired
```

`partially_delivered` exists because `all` mode fans out. `expired` is the urgent-deadline terminal state. Both identifiers carry into the Kafka envelope in Stage 3.

### Delivery receipts

Every send creates a `delivery_attempt` carrying the vendor's `provider_message_id` (already returned by the adapters today). Receipts update the attempt, which rolls up to the event; `bulk_job_item` links to its attempt, so bulk reports aggregate receipts as they arrive. Receipts arrive two ways, because vendors differ:

- **Callbacks** — SES → SNS bounce/complaint, MSG91 DLR, Twilio status. Public inbound endpoints; **vendor signature verification is a hard requirement** (MSG91's is weak and needs a shared-secret path parameter).
- **Polling** — Pinnacle documents no DLR webhook, only `/index.php/response` by `uniqueid`. A polling lane queries outstanding attempts.

Both run in their own low-priority lane. **A bulk job has two completions** — submitted and delivered, potentially hours apart; reports must not claim success at submit time. Channels with no receipt capability (the `http_callout` voice trigger) declare `receipts: none` and terminate at `accepted`.

### Retention and PII

Recipient phone and email are PII subject to DPDP erasure. Three tiers:

- **Tier 1 — operational detail** (recipient, variables, vendor response). Postgres, monthly `RANGE` partitions on `created_at` managed by **`pg_partman`**, **dropped by partition at 90 days** (Stage 1: a row lives at least 90 days and at most about 121 — the month it was written in, plus 90 days).
- **Tier 2 — aggregate counters** (network × template × channel × day). No personal data; retained indefinitely.
- **Tier 3 — long-term event log.** Kafka tiered storage, Stage 3 only. **Before Stage 3, 90 days is the audit horizon.**

Content rules:

- **OTP codes are never persisted** — not in Postgres, not in logs, not in a dead-letter entry. They exist in the Redis job only while the send is in flight, bounded by the urgent deadline.
- Variables marked `sensitive: true` are **redacted at write time**, in rows, logs, and dead-letter payloads.

### Auth and tenancy

**Tenancy is deployment configuration.** Each NS deployment serves one network (`NS_NETWORK`); every row is stamped with it and no caller can supply it. Template and policy rows keep a `network` column so that serving several networks later is additive.

**Two credential types behind one pluggable boundary:**

- **Keycloak bearer tokens** — verified with `jose` against the shared `bluedots` realm JWKS, reusing the Signals verification pattern. NS is registered as a **resource-server client** (`notification-service`; it never logs in). An audience mapper puts `aud: notification-service` on tokens issued to NS's callers; NS requires that audience and an allowlisted `azp`, so a token minted for another service cannot be replayed here — necessary precisely because every service shares one realm and one signing key. Client roles `notify:send` and `templates:admin` separate sending from administering.
- **HMAC, permanently** — for callers that cannot obtain a `client_credentials` token. The defining case is Keycloak itself: its OTP plugin would otherwise have to fetch a token from its own token endpoint in the middle of a login. HMAC moves to a **`v2` canonical string that includes the body**: `METHOD\npath\ntimestamp\nnonce\nsha256(body)`. `v1` is not accepted. The signature is verified before the nonce is claimed.

Signals moves to bearer tokens using its existing `signals-api` client; aggregator starts on bearer tokens in Stage 2; Keycloak's plugin uses HMAC `v2`.

**Who may administer templates and policy:** anyone holding `templates:admin` — a person or a service account. The **network-admin** role (signals-dpg #499) remains a sibling spec; it is no longer blocked on realm topology (settled: one shared realm) but needs product definition, and when it exists it maps onto this role. There is **no admin UI** in this design (§Open questions).

### Backbone (unchanged from the original)

**Apache Kafka (KRaft), self-hosted via Strimzi.** A log, not a queue, because audit/replay need messages to survive consumption. Kafka over Redpanda (BSL tiered storage fails the DPG rule) and NATS (no mature CDC). **Debezium** outbox for producers; AWS **MSK** as the escape hatch.

**One harmonized envelope, adopted from the telemetry design** — Sunbird-v3 `pdata`/`cdata`/`rollup` plus the event-platform fields (`id`, `type`, `version`, `source`, `network`, `subject`, `correlation_id`, `causation_id`, `idempotency_key`, `occurred_at`, `payload`), so producers are instrumented once.

**Registry: Apicurio** (Apache-2.0), not Confluent Schema Registry.

**A shared consumer/worker runtime (the SDK):** at-least-once + idempotency, retry/backoff → DLQ, rate-limiting, trace propagation. **The runtime retries *delivery*, never the *business operation*.**

**Choreography, not orchestration.** If a real saga appears, adopt **Temporal** as a separate consumer — never fold it into NS.

**OSI-open bill of materials.** Kafka · Strimzi · Apicurio · Debezium · Valkey. The Valkey move replaces the *shared* Redis instance that every service uses, so it is its own infra item alongside Stage 3, not a Stage 1 dependency.

## Security

> Requirements below derive from the Phase-B security audit of this service (notification-service #15). Candidate findings are held in a **private** advisory; this repo is public, so what follows is stated as design requirements. They are acceptance criteria for the stage items they sit under, not follow-up work.

A notification service can reach every participant in the network and renders attacker-influenced content into messages those participants trust.

**What the redesign closes**

- **Activating the rate limiter** is a security control before it is a performance feature. It is enforced on *every* send path — the transactional API, the worker pools, and the retry/replay endpoints.
- **Retiring raw provider ids, free-text SMS bodies, `basic_email`, and the WhatsApp `other` passthrough** — all in the Stage 1 cutover — removes every way a caller can put arbitrary content under an approved template in front of a recipient.
- **Signing the body** closes the gap where HMAC authenticated the request but not its contents.
- **Moving durable job state into Postgres** narrows how much behaviour can be influenced by anything holding the cache.

**What the redesign adds, and must ship already defended**

- **Template rendering.** Interpolated values are **HTML-escaped by default** in email; raw is an explicit, reviewable per-variable decision. URL-typed variables are scheme-checked and, where the value should be ours, allowlisted.
- **SMS body integrity.** A stored SMS body that drifts from its DLT registration is scrubbed silently by the operator. Publish shows the exact rendered text; edits to an active SMS body require a new version, never an in-place change.
- **The content resolver.** `content_ref` keys resolve against an **allowlist**. Resolution failure fails the send.
- **The admin API.** `templates:admin` is separate from `notify:send`: a credential that may send cannot edit templates.
- **Receipt endpoints.** Public, and **the signature is the authorization**. Unmatched `provider_message_id` values are dropped and counted, never created.
- **The bulk door.** The highest-value target in the system; `audience_basis` records why the audience was contacted.

**Cross-cutting requirements**

- **Recipients are validated per channel** — RFC-shaped addresses for email, E.164 for phone. **Sender identity is server-side configuration**, never caller-supplied.
- **Redaction reaches everywhere a value comes to rest** — logs, queue payloads, dead-letter entries, and rows. OTP codes and activation URLs never appear in logs at any level.
- **The cache is authenticated** (already true in infra) and a vendor exception is contained at the worker-pool boundary.
- **`GET /metrics` stays unauthenticated and content-free** — counts and depths only, never recipients, variables, or content.

## Architecture

```
 callers: Signals · Keycloak (OTP) · aggregator · voice · …
    │
    │  ── needs to know it worked NOW? ──────────► POST /v1/notify   (OTP, single sends)
    │  ── doesn't care who reacts / bulk? ───────► event stream      (Stage 3)
    ▼
 ┌───────────────────────────┐        ┌──────────────────────────────┐
 │  NOTIFICATION SERVICE API │        │  produce via SDK             │
 │  POST /v1/notify          │        │  (outbox + Debezium)         │
 │  POST /v1/bulk  (S3)      │        └───────────────┬──────────────┘
 │  admin: templates/policy  │                        ▼
 │  auth: KC bearer | HMAC v2│   ┌──────────────────────────────────────┐
 └────────────┬──────────────┘   │ APACHE KAFKA (KRaft) — Stage 3       │
              │                  └───────────────┬──────────────────────┘
              │                                  ▼
              │                  ┌──────────────────────────────────────┐
              │                  │ CONSUMER RUNTIME (SDK)               │
              │                  └───────────────┬──────────────────────┘
              ▼                                  ▼
 ┌───────────────────────────────────────────────────────────────────┐
 │  NOTIFICATION SERVICE core                                        │
 │                                                                   │
 │  policy resolve ─► capability filter ─► template (+ vendor ids)   │
 │        │                                 render in NS or vendor   │
 │        ▼   ┌──── URGENT pool ──── reserved quota · deadline ──┐   │
 │   dispatch ├──── NORMAL pool ────────────────────────────────  │   │
 │            └──── BULK   pool ────────────────────────────────  │   │
 │                                                                   │
 │  channels (one vendor each): email · sms · whatsapp · http_callout│
 │  Postgres: audit projection (pg_partman, 90d) · counters          │
 │  Redis: dispatch queues · nonces · dedupe guard                   │
 └───────────────────────────┬───────────────────────────────────────┘
                             ▲
     receipts ───────────────┘  callbacks (SES/SNS · MSG91 DLR · Twilio),
                                signature-verified · polling (Pinnacle)

 trace: correlation_id (business) + trace_id (W3C) on every record
```

**Durability model.** Postgres is the record; Redis stays the dispatch queue. On the normal and bulk paths an attempt is written to Postgres *before* it is queued, and a startup sweep re-queues attempts left in `queued` or `dispatching`, so a Redis restart no longer loses work. On the urgent path the job is queued first and audited fire-and-forget; a Redis loss can drop an in-flight OTP, which the user recovers from by requesting a new code.

**Schema migrations** are Drizzle-generated and run **on boot**: the API process applies pending migrations under a Postgres advisory lock (one replica migrates, others wait) *before* it forks the worker.

## Data model (Postgres/Drizzle — planned)

Tier-1 tables are monthly `RANGE`-partitioned on `created_at` via `pg_partman`.

- **`template`** — `id`, `network`, `channel`, `template_key`, `version`, `locale`, `status`, `subject`, `body_html`, `body_text`, `variables` (jsonb: `name`/`required`/`type`/`source`/`sensitive`), `provider`, `provider_template_id`, `sender_id`, `dlt_entity_id`, `dlt_header_id`, `dlt_tag_id`, `approval_ref`, `default_deadline_s`, `created_at`.
- **`notification_policy`** — `id`, `network`, `domain` (nullable), `event_type` (nullable), `mode` (`first_available`|`all`), `channels` (jsonb: ordered `[{channel, template_key}]`), `status`, `created_at`.
- **`notification_event`** — `id`, `correlation_id`, `trace_id`, `idempotency_key`, `event_type`, `template_key`, `network`, `domain`, `source` (`azp` or HMAC key id), `priority`, `deadline`, `status`, `payload` (jsonb, redacted), `received_at`. Unique `(network, idempotency_key)`.
- **`delivery_attempt`** — `id`, `notification_event_id`, `channel`, `provider`, `template_id`, `attempt_no`, `status`, `provider_message_id`, `error`, `requested_at`, `completed_at`.
- **`delivery_receipt`** *(Stage 2.5)* — `id`, `delivery_attempt_id`, `status`, `provider_status`, `received_at`.
- **`bulk_job`**, **`bulk_job_item`** *(Stage 3)* — as before: `audience_basis`, two completions, item → attempt link.
- **`notification_counter`** *(Stage 2.5; Tier 2, unpartitioned)* — `network`, `template_key`, `channel`, `day`, `sent`, `delivered`, `bounced`, `failed`, `expired`.

## API sketch (planned)

**Send**

- `POST /v1/notify` — the only send endpoint. `{ event_type | template_key, domain?, to: { email?, phone? }, locale?, variables, priority: urgent|normal|bulk, idempotency_key?, correlation_id?, deadline? }`, plus email-only `cc?`, `reply_to?`, `attachments?` → `202 { notification_event_id, correlation_id, status: "accepted" }`.
  - Exactly one of `event_type` (resolved through policy) or `template_key` (names the content directly). `domain` is caller-supplied because only the caller knows which role the recipient is addressed in; omitted → network-wide default policy.
  - Not accepted: free-text bodies, raw vendor template ids, sender identity, `network`.
  - **Idempotency:** `idempotency_key` is persisted, unique per network, for the Tier-1 window; a repeat returns `200` with the **original** `notification_event_id`. Without a key, the existing 5 s content-hash guard still answers `409 duplicate-fallback`.
- `POST /v1/bulk`, `GET /v1/bulk/:id` — *(Stage 3)*.

**Audit** *(Stage 2.5)* — `GET /v1/notifications/:id`, `GET /v1/notifications?correlation_id=…`.

**Admin** (`templates:admin`)

- `GET|POST|PATCH /v1/admin/templates`, `POST /v1/admin/templates/:id/publish|retire`, `POST /v1/admin/templates/:id/preview`.
- `GET|POST|PATCH /v1/admin/policies`, `POST /v1/admin/policies/:id/publish|retire`.

**Operational** — `POST /v1/webhooks/:provider` *(Stage 2.5)*; `POST /v1/failed/retry`; `GET /v1/metrics/queue`; `GET /metrics` (Prometheus, unauthenticated); `GET /providers`.

Legacy `POST /notify` is **removed** in the Stage 1 cutover, not kept alongside.

## Repos

- **One new repo** (platform, Stage 3) — event envelope/contracts + consumer/worker SDK. Working name `bluedots-eventbus`.
- **Reused** — `notification-service`.
- **Changed for the Stage 1 cutover** — `signals-dpg` (all sends to `/v1/notify`), `keycloak-otp-authenticator` (email `http` path, HMAC `v2`, `/v1/notify`), `bluedots-e2e` (stop reading NS's Redis queues), `aggregator-dpg` realm config (NS client), `bluedots-automation` / `bluedots-infra-deployments` (database, secrets, `smsProvider` flip).
- **Operated infra** — Kafka/Strimzi/Apicurio/Debezium as deployment config in `bluedots-automation`.

## Stages and issue decomposition

Ordering is deliberately **not** backbone-first. Stages 1–2 deliver a working notification authority with no Kafka. `[repo]` marks work outside notification-service.

### Stage 1 — NS becomes the notification authority

Build order; auth (item 8) runs in parallel from the start.

1. `[automation]` **Provision the NS database** (automation#114) — a `notification` database + role on the shared RDS via `postgresBootstrap`; `pg_partman` installed by the bootstrap; password through `random_passwords` → SOPS `global-secrets.yaml`. ALIMCO-TCS needs its Vault file moved to SOPS first.
2. **Persistence foundation** (#56) — Postgres + Drizzle, migrate-on-boot under an advisory lock; `notification_event` + `delivery_attempt` with the status lifecycle and both trace ids; `pg_partman` partition creation from day one (pre-make maintenance driven by NS) **and the 90-day partition drop** (moved here from #65 so recipient data is not kept indefinitely once all OTP flows through NS); record-before-queue with the startup re-queue sweep.
3. **Template registry + admin API** (#57) — the one-vendor-per-channel model, vendor-declared render mode, lifecycle, locale fallback, variable contract including `sensitive`, publish-time vendor check, preview.
4. **Routing policy + admin API** (#58).
5. **Content resolver** (#59) — off the cutover's critical path; no template needs it at cutover.
6. **Send API v1** (#60) — `/v1/notify`, policy resolution, capability filtering, synchronous fallback, persisted idempotency, email extras. Legacy `/notify` removed.
7. **Priority isolation** (#61) — urgent/normal/bulk pools, split token bucket with reserved urgent quota, urgent `deadline` → `expired`, fire-and-forget urgent audit.
8. **Service auth + admin scopes** (#62) — Keycloak bearer (`aud` + `azp`), NS resource-server client and roles in `realm.json`, HMAC `v2` with body digest, signature-before-nonce.
9. **Cutover release** — one coordinated release, NS + Signals in the same Helm release:
   - `[Signals]` **Every send moves to `/v1/notify`** (signals#496, pulled forward from Stage 2.5) — ~15 email cases, guardian OTP (email + SMS), WhatsApp welcome; their copy and DLT/Meta identifiers seeded as NS templates and policies; Signals stops rendering HTML; bearer auth.
   - `[e2e]` Assertions move off NS's Redis internals.
   - `[keycloak-otp-authenticator]` **Email OTP over `http`**, HMAC `v2`, `/v1/notify` with `template_key: login_otp` — must ship before any cluster flips (item 10).
10. `[infra-deployments]` **Route all OTP through NS** — per cluster: confirm NS's login-OTP template matches Keycloak's current MSG91 flow id, add the HMAC secret where missing (Test-dev), switch Keycloak SMS and email to `http`. Gated on item 7.

### Stage 2 — aggregator-dpg migrates onto NS

11. `[aggregator]` **Port templates and call sites** (aggr#596) — ~8 templates from ~7 call sites, **and the BullMQ campaign email**, which calls `/v1/notify` with `priority: bulk` (rate-limited by the bulk pool) until Stage 3's bulk door exists. Bearer auth.
12. `[aggregator]` **Retire the mailer** (aggr#597) — delete `packages/mailer` and its SES/SMTP configuration and secrets.

### Stage 2.5 — NS tranche 2

13. **Delivery receipts** (#63) — callbacks with vendor signature verification, plus a **Pinnacle polling lane**; own low-priority lane.
14. **Audit query API** (#64).
15. **Rollups and erasure** (#65) — Tier-2 counters, erasure across tiers, redaction enforcement. (The 90-day Tier-1 partition drop shipped in Stage 1.)

### Stage 3 — event bus + consumer SDK

16. `[new repo]` **Envelope contract + Apicurio schemas** (#66).
17. `[new repo]` **Consumer SDK runtime** (#67).
18. `[automation]` **Kafka (KRaft) + Strimzi + Apicurio** (automation#115).
19. `[automation]` **Valkey** replacing the shared Redis.
20. **Bulk door, NS as first consumer** (#68) — `POST /v1/bulk`; aggregator campaigns move onto it.

### Stage 4 — producers emit events

21. `[Signals]` **Outbox + Debezium CDC** (signals#497).
22. `[Signals]` **Non-urgent notifications become events** (signals#498); OTP stays on the direct API permanently.
23. `[aggregator]` **Emit events** (aggr#598).

### Stage 5 — orchestration (conditional)

Only if a real saga appears; Temporal as a separate consumer. Not decomposed.

## Deferred and out of scope

- **network-admin role** — sibling spec signals-dpg #499. Realm topology is settled; it needs product definition. `templates:admin` stands in until then.
- **Multiple vendors per channel** — not built; the model leaves room (§Templates).
- **Consent enforcement and opt-out** — owned by Signals/aggregator.
- **Orchestration** — Stage 5, conditional.

## Open questions

- **OTP ownership** — decided 2026-10-06: login OTP is generated and verified in Keycloak, guardian OTP in Signals-DPG. NS is the carrier for both and never generates or checks a code.
- **Admin UI** — the templates and policy APIs have no UI in any stage. Whether network admins need one, and where it lives.
- Topic taxonomy and partition strategy — Stage 3 spec.
- Whether the 90-day Tier-1 horizon is acceptable to compliance before Stage 3.
- Voice-bot result handling — whether any caller needs a synchronous result from `http_callout`.
