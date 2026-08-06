# Event Platform & Notification-Service Redesign

> This is the umbrella design. It fixes the whole-platform vision, decisions, and phasing; each stage gets its own detailed spec.
> A formatted version for the system architect lives alongside this file as `2026-06-26-event-platform-design.technical.md`. **That copy predates the 2026-08-06 revision and is stale.**

## Revision history

- **2026-06-26** — original.
- **2026-08-06** — substantial revision. Reframed the ingress model (consumer-owned APIs are the default contract, the bus is for fan-out and decoupled reaction); added urgent-path isolation, the template/routing-policy split, the content resolver, the trace and status lifecycle, and a retention/PII policy; removed consent enforcement from notification-service's scope; re-ordered the stages so notification-service delivers value before any Kafka infrastructure exists; added the issue decomposition.

## Overview

We're redesigning **notification-service** (NS) from an HTTP-only mailer into the **notification authority for the network**, and — later — the first consumer of a replayable event backbone.

The organising idea: **events are the spine of the network, but not the only wire.** Services emit domain events to a durable, ordered, replayable log; consumers react. Notification — email, SMS, WhatsApp, and outbound service-triggers like the voice bot — is the **first and most important consumer, not the centre.**

The routing rule that follows from that, and which the original draft under-stated:

- **Call the consumer's API** when the caller needs to know it worked *now*. OTP, login, single transactional sends. NS's own API is the contract, not a fallback lane.
- **Emit an event** when the caller shouldn't know or care who reacts, or when fan-out must be durable and rate-limited.
- **OTP never rides the bus.** Stated as a hard non-goal, not left as an implicit consequence.

This generalises: every consumer-routed service exposes its own API. The bus is not an RPC substitute, and putting a synchronous need behind a shared consumer group makes the consumer a bottleneck.

The platform is three parts, only one of which we build from scratch:

- **Event backbone** — an operated Apache Kafka cluster + its contracts. *Infra, not a codebase.*
- **Consumer SDK** — the shared library every producer/consumer depends on (envelope, idempotency, retry/DLQ, rate-limit, trace). *One new repo.*
- **Notification service** — today's notification-service, substantially extended. *Reused repo.* Useful on its own, long before the backbone exists.

## Goals

- **One notification authority** — absorb aggregator's parallel mail stack; NS owns templates, routing, and delivery.
- Durable **audit** of what was sent, with an end-to-end **trace** from origination to closure.
- **Resilient, rate-limited, reportable bulk fan-out** (T&C re-consent, campaigns).
- Keep **OTP/login delivery low-latency and reliable** — it must not regress, and bulk must not be able to starve it.
- **Decoupled cross-service reactions** (including async response-handover to the user).
- **Multi-tenant** across networks/domains/instances, with tenancy from verified claims.
- Every component **OSI-open and free** (DPG requirement).

## Non-goals

- **Not** enforcing consent. NS is a tool consent flows *use*, never a consent authority. See §Consent boundary.
- **Not** building a workflow/orchestration engine. Choreography first; adopt Temporal only if a real saga appears.
- **Not** a generic RPC/data bus. Bulk export, profile fetch, and metric rollups belong elsewhere.
- **Not** a user directory. NS never resolves a person to their contact points; callers pass what they hold.
- **Not** blocking on the Keycloak migration — auth ships behind a pluggable boundary.

## Where things stand today

**notification-service** is Fastify 5 with **no database**. Every route is authenticated by a **hand-rolled HMAC** — `HMAC-SHA256` over `METHOD\npath\ntimestamp\nnonce`, keys loaded from a JSON file at `INTERNAL_SECRETS_JSON`, Redis nonce replay protection (`src/plugins/request-auth.ts`). This is unrelated to better-auth, which was Signals' *user* auth.

`POST /notify` is the only ingestion path. Three channels sit behind an already-clean adapter contract (`ProviderDefinition { name, templates, schema, send() }` + folder auto-discovery). Async work runs on a **hand-rolled Redis queue** (two lists + a sorted-set retry queue with 5-attempt exponential backoff + a DLQ), drained by a forked worker. A per-provider **token-bucket rate limiter exists but is dormant**. **Nothing is persisted** — a Redis restart loses in-flight jobs, and there is no audit. A test suite now exists (33 tests, CI-wired, plus the atomic retry-claim and auth-ordering fixes; #50/#53/#54 on `feature`). Only caller is Signals (OTP/login/action).

**Templates today are not owned here, and the three channels are not symmetric:**

| Channel | Where the body lives | Can NS own it? |
| --- | --- | --- |
| Email | Caller sends full `subject` + `html`; `basic_email` is a sentinel, not a template | **Yes** |
| SMS (MSG91) | MSG91 flow id `6896c26d…`, DLT-registered | **No** — regulated, provider-side |
| WhatsApp (Twilio) | Twilio `contentSid` `HXa9cc97…`, Meta-approved | **No** — provider-side |

WhatsApp also has an `other` escape hatch that lets any caller pass an arbitrary `contentSid`. That hole is a large part of why template governance is worth building.

**aggregator-dpg** has a single `MailerAdapter` (SES or SMTP) with four HTML templates (`admin-review`, `applicant-approved`, `applicant-rejected`, `support-request`), called **synchronously inline** from four route handlers (`aggregator-approvals` ×2, `registration-notify`, `support`). It has **no SMS stack and no Redis notification queue** — the original draft overstated this, and the migration is correspondingly smaller.

Context: the **Keycloak migration** landed on the `epic/keycloak-iam` branch (signals-dpg #456, aggregator #570, both merged 2026-08-03) but has **not** reached `feature`; merge-back is gated on that epic's unresolved shared-realm-vs-per-DPG-realm question. aggregator #570 implements *shared-realm service auth*, which is the M2M pattern NS adopts.

## Problems we're solving

1. **No durable record / audit / trace** — NS persists nothing; a Redis restart drops work; there is no way to answer "what happened to that message".
2. **No resilient bulk fan-out** — broadcasts have no rate-limited, reportable path; the rate limiter isn't even wired.
3. **Duplicated notification stacks** — NS and aggregator each send their own way, with no single authority.
4. **No template governance** — bodies are hardcoded in adapters or hand-built by callers, and any caller can send an arbitrary WhatsApp template. A wrong DLT template is a compliance incident.
5. **No routing policy** — nothing expresses "SMS for seekers, email for providers", or what to do when a recipient has no email.
6. **Point-to-point coupling** — services trigger each other by direct RPC; no decoupled, replayable way to react to "X happened".
7. **Login rides a fragile path** — OTP must be low-latency and must-not-fail, yet shares every resource with everything else.
8. **Multi-tenant trust** — a shared service spans networks/domains/instances; tenancy must come from verified claims, never client input.
9. **DPG license compliance** — every component must be OSI-open and free; common defaults (Redpanda BSL, Confluent Schema Registry, Redis ≥ 7.4) violate this.

## Key decisions

### Ingress and isolation

**Two doors, with an explicit routing rule** (see §Overview). The transactional door (`POST /v1/notify`) is a near-synchronous send; the event door (produce via SDK + outbox/Debezium) is the resilient path for bulk and domain events.

**Isolating the urgent path is a resource question, not a door question.** Bypassing the bus alone does not protect OTP — on the direct path it still shares NS's process, its Postgres, and, decisively, the *provider account*. A 200k-recipient T&C broadcast will exhaust the MSG91 quota and queue OTPs at the provider regardless of how NS is wired. Therefore:

- `priority: urgent | normal | bulk`, carried on the send API or derived from template metadata.
- **Separate worker pools per priority.** Bulk workers can never occupy an urgent slot. This is what removes head-of-line blocking.
- **Reserved provider quota.** The dormant token bucket is activated *and split*: urgent holds a guaranteed share that bulk physically cannot consume.
- **Audit writes on the urgent path are fire-and-forget.** A slow Postgres must never delay an OTP.
- Later, the bulk consumer group stays separate from anything urgent by construction.

One NS deployment, not two — the pools give the isolation without a second deployment's config surface.

### Templates and routing — two objects, not one

Templates carry *content*. Routing policy decides *which* template on *which* channel for *whom*. Collapsing them produces an unusable composite key and cannot express "send to both".

**`template`** — key `(network, channel, template_key, locale)`, with a `render_mode` discriminator that is honest about the provider asymmetry:

```
render_mode = 'owned'         (email)     NS stores subject/body_html/body_text and renders
render_mode = 'provider_ref'  (sms, wa)   NS stores provider_template_id (MSG91 flow /
                                          Twilio contentSid) + provider_approval_ref
                                          (DLT entity/template id, Meta status);
                                          the provider renders
```

Both modes declare a **variable contract** (`name`, `required`, `type`, `source`, `sensitive`), validated at send time *before* the provider is called. This is the main win for SMS/WhatsApp even though NS cannot own their bodies — today a malformed MSG91 call simply fails at the provider.

Lifecycle `draft → active → retired`; exactly one `active` per resolution key; **retire never deletes**, because audit rows reference old versions. Callers always send one stable `template_key` + variables and never see the render-mode difference.

**`notification_policy`** — key `(network, domain, event_type)` → ordered channel list, per-channel `template_key`, and a mode:

| Mode | Meaning |
| --- | --- |
| `first_available` | Try channels in order; fall through on failure or missing contact point |
| `all` | Fan out to every listed channel |

`domain` and `event_type` are nullable, so network-wide defaults and per-domain/per-event overrides are the same mechanism at different specificity; **most-specific-wins**. This expresses "SMS for seekers, email for providers", "the same for everyone", and "send to both" without three features.

**Policy lives in NS's database, edited through the admin API — not in `network.json`.** `network.json` is the network *contract* (what domains exist) and is consumed by aggregator and match-engine too; how to notify a domain is a delivery concern. Putting it in `network.json` would make every routing tweak a cross-repo PR plus a ConfigMap sync plus a redeploy per instance.

**Recipient capability — NS holds no user directory.** The caller passes every contact point it has (`{ email?, phone? }`); NS filters the resolved channel list down to what is reachable. NS never calls Signals to resolve a person: that would put a network hop on the OTP path and turn NS into a PII store. "Registered by phone only" then needs no special case — the policy says `[sms, email]`, there is no email, `sms` is the only candidate.

**Fallback has two clocks**, and conflating them produces a design that cannot work:

- *Synchronous* failure (provider rejects; no contact point for the channel) → fall through to the next channel immediately.
- *Asynchronous* failure (a bounce or DLR arriving seconds to hours later) → cannot be a retry-in-place. Before the backbone exists this records a terminal `failed` status, queryable by trace. From Stage 3 it emits `notification.delivery_failed`, and a policy may opt into async fallback.

### Consent boundary

**NS enforces nothing about consent.** Consent acceptance is enforced in Signals/aggregator code with records in their Postgres. Some consent flows need an OTP (an ordinary urgent send); some consent failures need an SMS or email (an ordinary send). In neither case does NS need to know what consent *is*. This removes the consent-service dependency — and with it the parked-Keycloak blocker — from this epic's critical path.

**The caller owns the audience.** For bulk especially, the producer is responsible for having applied consent/opt-out when building the recipient list. `bulk_job.audience_basis` records the caller's assertion (free text, e.g. `"tnc_v3_pending"`) so a DPDP audit can answer "why was this person contacted" without NS holding consent state.

**But NS must be able to *render* consent content** — a T&C link or the statement itself in the message body. That is a content dependency, not a consent dependency, and it is served by the **content resolver**: a template variable may declare `source: content_ref` with a key like `tnc.in_force.url` or `tnc.on_offer.text`, resolved per locale by a pluggable provider — `configmap` today (mounted file), `db`/`http` later. Resolved values are cached by `(key, locale, version)`.

`in_force` versus `on_offer` is deliberate: the consent design's advance-notice version windows make "the current T&C" ambiguous during a notice period. A re-consent broadcast needs the *offered* version; an acceptance receipt needs the *in-force* one. The content key must say which.

### Trace and status lifecycle

Two identifiers, deliberately distinct:

- **`correlation_id`** — the business trace. Caller-supplied or NS-generated, spanning the whole flow (consent broadcast → send → provider → receipt → closure). This is the query key.
- **`trace_id`** — the W3C observability trace, accepted via the `traceparent` header, so notification records join OTel traces. This is what makes the telemetry design's `cdata.trace_id` bridge work.

Status is tracked at two levels, stamped by whichever worker touches the record:

```
notification_event   accepted → resolved → dispatching → sent
                     → delivered | partially_delivered | failed

delivery_attempt     queued → sent → accepted_by_provider
                     → delivered | bounced | failed
```

`partially_delivered` exists because `all` mode fans out to several channels and one may bounce while another lands. Async receipts update the attempt, which rolls up to the event — so one lifecycle covers urgent, queued, and bulk sends with no separate mechanism. Both identifiers carry into the Kafka envelope in Stage 3, so the trace survives the move onto the bus.

### Delivery receipts

Receipts are provider **callbacks**, so they are already out-of-band from how the send was requested; bulk and urgent converge on identical handling. Every send creates a `delivery_attempt` carrying a `provider_message_id`; the provider calls back (SES → SNS bounce/complaint, MSG91 DLR, Twilio status webhook); NS matches on `provider_message_id`, writes a `delivery_receipt`, and updates the attempt. `bulk_job_item` links to its attempt, so bulk reports aggregate receipts as they arrive.

Three consequences that must be designed for, not discovered:

- **A bulk job has two completions** — "submitted" (all sends accepted) and "delivered" (all receipts in), potentially hours apart. `bulk_job` carries both, and the report must not claim success at submit time.
- **Receipt ingestion gets its own low-priority lane.** It is the highest-volume inbound traffic in the system and must never contend with sends.
- **Receipt webhooks are public inbound endpoints** and require provider signature verification (SES SNS signature, Twilio signature; MSG91's is weaker and needs a shared-secret path parameter). This is a hard requirement, not a follow-up.

Channels with no receipt capability — notably the `http_callout` voice-bot trigger, an outbound POST and *not* a hosted webhook — declare `receipts: none` and terminate at `accepted`.

### Retention and PII

Storing every attempt forever is not viable, and it is a **compliance** problem before it is a cost problem: recipient phone and email are PII subject to DPDP erasure. Three tiers:

- **Tier 1 — operational detail** (recipient, variables, provider response). Postgres, monthly `RANGE` partitions on `created_at`, **dropped by partition at 90 days**. Partition-drop rather than `DELETE`, so there is no vacuum churn.
- **Tier 2 — aggregate counters** (network × template × channel × day: sent/failed/bounced/delivered). Tiny, retained indefinitely. This is what dashboards and historical bulk reports read once Tier 1 has aged out.
- **Tier 3 — long-term event log.** Kafka tiered storage, from Stage 3 only. **Before Stage 3, 90 days is the audit horizon** — better stated plainly than implied away.

Two hard content rules:

- **OTP codes are never persisted** — not in `variables`, not in a rendered body.
- Variables marked `sensitive: true` in the template's variable contract are **redacted at write time**, reusing the variable-contract machinery rather than adding a parallel one.

### Auth and tenancy

NS targets **Keycloak `client_credentials` + JWKS** natively, following the shared-realm service-auth pattern from aggregator #570; `network` comes from a **verified claim, never from client input**; the template and policy admin API is gated by admin scopes.

Because `epic/keycloak-iam` has not reached `feature`, this ships behind the **pluggable auth boundary**: HMAC keeps working and Keycloak is switched on by configuration. NS is therefore not blocked if the realm question drags. Existing `/notify` callers keep HMAC through a dual-accept window that closes with the Signals cutover.

**Who may administer templates and policy** is genuinely unresolved: the right answer is a **network-admin** role, which does not exist in Keycloak today. That is filed as a *sibling* spec (§Deferred), not absorbed here. Interim: an admin-scoped, network-bound credential.

### Backbone (unchanged from the original)

**Apache Kafka (KRaft), self-hosted via Strimzi.** A log, not a queue, because audit/replay/reproduce need messages to survive consumption and be re-readable from any offset. Kafka over Redpanda and NATS because:

- *License (decisive):* Kafka is Apache-2.0 with everything open including **tiered storage** (cheap long retention = the audit store). Redpanda gates tiered storage behind a paid BSL tier — fails the DPG rule.
- *Producer outbox without dual-write:* producers are Postgres-backed, so **Debezium** CDC reads an outbox table and publishes to Kafka. NATS has no comparable mature CDC.
- *Escape hatch:* AWS **MSK** is managed Apache Kafka — a connection-string change, still DPG-compliant.

**One harmonized envelope, adopted from the telemetry design** — the Sunbird-v3-aligned envelope (`pdata`/`cdata`/`rollup` = network→domain→instance→org) carrying the event-platform fields (`id`, `type`, `version`, `source`, `network`, `subject`, `correlation_id`, `causation_id`, `idempotency_key`, `occurred_at`, `payload`). Producers are instrumented once; the telemetry platform later adds its `telemetry.*` streams and insight consumer on the same contract. Two envelopes across the same producers would mean instrumenting twice or maintaining a permanent translation layer.

**Registry: Apicurio** (Apache-2.0), not Confluent Schema Registry (restricted licence).

**A shared consumer/worker runtime (the SDK).** At-least-once + idempotency (dedup on `id`/`idempotency_key`), retry/backoff → DLQ, rate-limiting, trace propagation. **Hard boundary: the runtime retries *delivery*, never the *business operation*** — a consumer that triggers external work owns that work's idempotency and compensation. This is what keeps the notification consumer from silently becoming an orchestrator.

**Choreography, not orchestration.** A service emits a domain event; interested services react; when async work finishes, the owning service emits a completion event that NS turns into the response-handover notification. No central coordinator. If a real multi-step saga appears, adopt **Temporal** as a separate consumer — never fold it into NS.

**OSI-open bill of materials.** Kafka · Strimzi · Apicurio (not Confluent SR) · Debezium · Valkey (not Redis ≥ 7.4 — RSALv2/SSPL).

## Architecture

```
 callers (Signals, aggregator, voice, …)
    │
    │  ── needs to know it worked NOW? ──────────► direct API  (OTP, single sends)
    │  ── doesn't care who reacts / bulk? ───────► event stream
    ▼
 ┌───────────────────────────┐        ┌──────────────────────────────┐
 │  NOTIFICATION SERVICE API │        │  produce via SDK             │
 │  POST /v1/notify          │        │  (outbox + Debezium)         │
 │  POST /v1/bulk            │        └───────────────┬──────────────┘
 │  admin: templates/policy  │                        ▼
 └────────────┬──────────────┘   ┌──────────────────────────────────────┐
              │                  │ APACHE KAFKA (KRaft) — durable,      │
              │                  │ ordered, replayable log; tiered      │
              │                  │ storage = audit; Apicurio registry   │
              │                  └───────────────┬──────────────────────┘
              │                                  ▼
              │                  ┌──────────────────────────────────────┐
              │                  │ CONSUMER RUNTIME (SDK): idempotency ·│
              │                  │ retry/DLQ · rate-limit · trace       │
              │                  └───────────────┬──────────────────────┘
              ▼                                  ▼
 ┌───────────────────────────────────────────────────────────────────┐
 │  NOTIFICATION SERVICE core                                        │
 │                                                                   │
 │  policy resolve ─► capability filter ─► template render           │
 │        │                                                          │
 │        ▼   ┌──── URGENT pool ──── reserved provider quota ────┐   │
 │   dispatch ├──── NORMAL pool ────────────────────────────────  │   │
 │            └──── BULK   pool ────────────────────────────────  │   │
 │                                                                   │
 │  channels: email · sms · whatsapp · http_callout                  │
 │  audit projection (partitioned, 90d) · aggregate counters         │
 └───────────────────────────┬───────────────────────────────────────┘
                             ▲
        provider callbacks ──┘  (SES/SNS · MSG91 DLR · Twilio status)
        signature-verified, own low-priority lane → delivery_receipt

 trace: correlation_id (business) + trace_id (W3C) on every record
```

## Data model (Postgres/Drizzle — planned)

Tier-1 tables are monthly `RANGE`-partitioned on `created_at`.

- **`template`** — `id`, `network`, `channel`, `template_key`, `version`, `locale`, `render_mode`, `status`, `subject`, `body_html`, `body_text`, `provider`, `provider_template_id`, `provider_approval_ref`, `variables` (jsonb: `name`/`required`/`type`/`source`/`sensitive`), `created_at`.
- **`notification_policy`** — `id`, `network`, `domain` (nullable), `event_type` (nullable), `mode` (`first_available`|`all`), `channels` (jsonb: ordered `[{channel, template_key}]`), `status`, `created_at`.
- **`notification_event`** — `id`, `correlation_id`, `trace_id`, `event_id` (envelope id, unique dedup key), `idempotency_key`, `event_type`, `network`, `domain`, `source`, `priority`, `status`, `payload` (jsonb, redacted), `received_at`.
- **`delivery_attempt`** — `id`, `notification_event_id`, `channel`, `provider`, `template_id`, `attempt_no`, `status`, `provider_message_id`, `error`, `requested_at`, `completed_at`.
- **`delivery_receipt`** — `id`, `delivery_attempt_id`, `status` (delivered/bounced/failed), `provider_status`, `received_at`.
- **`bulk_job`** — `id`, `network`, `requested_by`, `audience_basis`, `template_key`, `channel`, `total`/`succeeded`/`failed`, `status`, `submitted_at`, `delivered_at`, `created_at`.
- **`bulk_job_item`** — `id`, `bulk_job_id`, `recipient`, `status`, `delivery_attempt_id`.
- **`notification_counter`** (Tier 2, unpartitioned, permanent) — `network`, `template_key`, `channel`, `day`, `sent`, `delivered`, `bounced`, `failed`.

## API sketch (planned)

**Send**

- `POST /v1/notify` — transactional door. `{ event_type | template_key, domain?, to: { email?, phone? }, locale, variables, priority, idempotency_key, correlation_id? }` → `202 { notification_event_id, correlation_id, accepted }`. Re-send with the same `idempotency_key` returns the original result.

  **Where the resolution inputs come from** — `network` is taken from the verified claim and is never read from the body, because it is the tenancy boundary. `domain` *is* supplied by the caller, because only the caller knows which role the recipient is being addressed in — the same person can be a seeker in one flow and a provider in another, so it is a property of the send, not of the identity. It is optional; omitting it resolves against the network-wide default policy. `template_key` bypasses policy resolution entirely and names the content directly (the migration path and the escape hatch for one-off sends); `event_type` goes through policy. Exactly one of the two is required.
- `POST /v1/bulk` — enqueue a campaign (event door). `{ template_key | event_type, channel, locale, audience_basis, recipients[], variables }` → `202 { bulk_job_id }`. *(Stage 3)*
- `GET /v1/bulk/:id` — bulk snapshot, with `submitted_at` and `delivered_at` distinct. *(Stage 3)*

**Audit**

- `GET /v1/notifications/:id` and `GET /v1/notifications?correlation_id=…` — the full tree: event → attempts → receipts.

**Admin** (admin scope; network-admin role when it exists)

- `GET|POST|PATCH /v1/admin/templates`, `POST /v1/admin/templates/:id/publish|retire`, `POST /v1/admin/templates/:id/preview`.
- `GET|POST|PATCH /v1/admin/policies`, `POST /v1/admin/policies/:id/publish|retire`.

**Operational**

- `POST /v1/webhooks/:provider` — signature-verified receipt ingestion.
- `POST /v1/failed/retry` — DLQ replay. `GET /v1/metrics/queue` — depths + consumer lag. `GET /providers` — channel metadata (existing).

## Repos

- **One new repo** (platform) — event envelope/contracts + consumer/worker SDK + open-BOM conventions. Separate from any single consumer because *every* service depends on it. Working name **Event Fabric** / `bluedots-eventbus` (fixed when created).
- **Reused** — `notification-service`, extended into the notification authority and later the first consumer; depends on the SDK; keeps its direct API as the fast door.
- **Operated infra** — the Kafka/Strimzi/Apicurio/Debezium stack is deployment config in `bluedots-automation`, not a repo.

## Stages and issue decomposition

Ordering is deliberately **not** backbone-first. Stages 1–2 deliver a working notification authority with no Kafka at all, which means the audit projection and template model get validated by a real consumer (aggregator) before any infrastructure is committed to. `[repo]` marks work outside notification-service.

### Stage 1 — NS becomes the notification authority

1. **Persistence foundation** — Postgres + Drizzle + config/migrations; `notification_event` + `delivery_attempt` with the two-level status lifecycle and both trace identifiers; **monthly RANGE partitions from day one** (retrofitting is a rewrite); durable job state replacing the restart-lossy Redis queue.
2. `[automation]` **Provision the NS Postgres** — settles "new database vs shared RDS database/user" on the consent-service precedent.
3. **Template registry + admin API** — two render modes, lifecycle, locale fallback, variable contract including `sensitive`, seeded from the three hardcoded adapter maps.
4. **Routing policy + admin API** — `(network, domain, event_type)` → ordered channels + per-channel `template_key`, `first_available` | `all`, most-specific-wins.
5. **Content resolver** — `source: content_ref` variables, pluggable provider (`configmap` now, `db`/`http` later), locale- and version-aware caching, `in_force` / `on_offer` keys.
6. **Send API v1** — `event_type` or explicit `template_key`; recipient contact points; policy resolution + capability filtering + synchronous fallback; `idempotency_key`; `priority`; `basic_email` dual-accept.
7. **Priority isolation** — urgent/normal/bulk worker pools; token bucket activated and split with reserved urgent quota; fire-and-forget audit on the urgent path; OTP codes never persisted.
8. **Keycloak-native service auth + admin scopes** — `client_credentials` + JWKS following aggregator #570's shared-realm pattern, `network` from a verified claim, behind the pluggable boundary with HMAC dual-accept.

### Stage 2 — aggregator-dpg migrates onto NS

9. `[aggregator]` **Port the four email templates and swap the call sites** — `aggregator-approvals` ×2, `registration-notify`, `support`; `MailerAdapter` → NS client.
10. `[aggregator]` **Retire the mailer** — delete the adapter and its SES/SMTP configuration and secrets.

### Stage 2.5 — NS tranche 2 (overlaps Stage 2)

11. **Delivery receipts** — SES/SNS, MSG91 DLR, Twilio webhooks; **provider signature verification** (relates to pentest issue #15); own low-priority ingestion lane.
12. **Audit query API** — by id and by `correlation_id`, returning event → attempts → receipts.
13. **Retention and rollups** — Tier-2 aggregate counters, partition-drop automation at 90 days, redaction enforcement.
14. `[Signals]` **Cut over to `template_key`/`event_type`** — stop rendering HTML in code; then retire `basic_email` and the WhatsApp `other` escape hatch in NS.

### Stage 3 — event bus + consumer SDK

15. `[new repo]` **Envelope contract + Apicurio schemas** — the harmonized Sunbird-v3 envelope.
16. `[new repo]` **Consumer SDK runtime** — idempotency, retry/backoff/DLQ, per-tenant rate limit, trace propagation.
17. `[automation]` **Kafka (KRaft) + Strimzi + Apicurio deployment.**
18. **Bulk door, NS as first consumer** — `POST /v1/bulk`, `bulk_job`/`bulk_job_item`, two-completion reporting, `audience_basis`, DLQ replay, `notification.delivery_failed` enabling async fallback.

### Stage 4 — producers emit events

19. `[Signals]` **Outbox + Debezium CDC** → domain events.
20. `[Signals]` **Non-urgent notifications become events**; OTP stays on the direct API permanently.
21. `[aggregator]` **Emit events** for its non-urgent paths.

### Stage 5 — orchestration (conditional)

Only if a real saga appears; adopt Temporal as a separate consumer. Otherwise never built. Not decomposed.

## Deferred and out of scope

- **network-admin role** — a *sibling* spec, filed against the Keycloak IAM epic (signals-dpg #420), not a child of this one. Initial capabilities: manage notification templates and routing policy; publish terms and consent statements (a manual task today). It collides with that epic's open shared-realm-vs-per-DPG-realm decision, which this design does not pre-empt.
- **Consent enforcement and opt-out** — owned by Signals/aggregator; NS renders consent *content* only.
- **Orchestration** — Stage 5, conditional.

## Open questions

- Topic taxonomy and partition strategy — fixed in the Stage 3 spec against measured volumes.
- Whether the 90-day Tier-1 horizon is acceptable to compliance before tiered storage exists in Stage 3.
- Voice-bot result handling — `http_callout` is fire-and-record by default; whether any caller needs a synchronous result back is unconfirmed.
- Timing of the HMAC dual-accept window's close, which depends on `epic/keycloak-iam` reaching `feature`.
