# Blue Dots Event Platform Design (umbrella)

**Audience:** System architect and engineers building the Blue Dots event/notification platform — the shared event backbone, the consumer SDK, and the redesigned notification-service — and the Signals / aggregator / voice teams who will produce to and consume from it. This is the **umbrella** design: it fixes the whole-platform vision and invariants; each phase (§4.12) gets its own detailed spec.

---

## Contents

1. [Introduction](#1-introduction)
2. [Background & Problem Statement](#2-background--problem-statement)
3. [Key Design Problems](#3-key-design-problems)
4. [Design](#4-design)
5. [Data Model](#5-data-model)
6. [API Spec](#6-api-spec)
7. [Summary](#7-summary)

---

## 1. Introduction

This document describes the redesign of **notification-service** from an HTTP-only delivery service into one consumer of a **network-wide, replayable event backbone** — and the platform that backbone implies.

The single organising idea is this: **events are the spine of the network.** Services emit domain events (`profile.exported`, `tnc.published`, `action.performed`, `job.completed`) to a durable, ordered, replayable log; consumers react to the ones they care about. **Notification** — email, SMS, WhatsApp, and outbound service-triggers like the voice bot — is the **first and most important consumer**, not the centre. Cross-service reactions are **choreography over the log**; multi-step orchestration is **bought or deferred, never hand-built** (§4.7).

The platform has three parts, and only one of them is something we write from scratch:

- **The event backbone** — an operated Apache Kafka cluster plus its contracts. *Infra, not a codebase.*
- **The consumer SDK** — the shared library every producer/consumer depends on (envelope, idempotency, retry/DLQ, rate-limit, trace). *New repo (§4.11).*
- **The notification delivery consumer** — today's notification-service, refactored. *Reused repo (§4.11).*

The design covers:

- The backbone (Kafka/KRaft), the **event envelope**, topics, partitioning, and the log-as-audit-store (§4.2, §4.4)
- **Two ingress doors** — a fast transactional path for OTP/single sends, and the event-stream path for bulk + domain events (§4.3)
- The consumer/worker **runtime** — idempotency, retry, DLQ, rate-limiting, tracing (§4.5)
- The **notification consumer** — pluggable channel adapters, NS-owned templates, consent enforcement, delivery receipts; absorbing aggregator's duplicate stack (§4.6)
- **Choreography vs orchestration** — why we don't build a workflow engine (§4.7)
- **Tenancy and auth** — scoped by verified `network` claim, converging on Keycloak (§4.8)
- **Observability** — audit, replay/reproduce, distributed trace, bulk failure reporting (§4.9)
- The **open bill of materials** and the DPG license rule (§4.10), and the **repo split + phase plan** (§4.11, §4.12)

> **Note on orchestration (out of build scope):** "Trigger workflows across services" is realised as event choreography. We do **not** build a workflow engine; if a genuine multi-step saga with compensation appears, we adopt Temporal (§4.7). This keeps the platform an order of magnitude smaller.

> **Note on prerequisite (provisional):** Tenancy and service-to-service auth (§4.8) converge on the **Keycloak migration** (realm = network, `sub` identity, `client_credentials` Bearer). That migration is itself provisional pending Product. The platform ships behind a **pluggable auth boundary** so it is not blocked: HMAC is the interim, Keycloak the target.

---

## 2. Background & Problem Statement

### Background

**notification-service today** is a Fastify 5 service with **no durable database**. Every endpoint is HMAC-signed (`X-NS-Key/Timestamp/Nonce/Signature`); the only ingestion path is `POST /notify`. It supports three channels through a clean, already-generalised adapter contract — `ProviderDefinition { name, templates, schema, send() }` with a folder-scanning auto-discovery registry: **email** (AWS SES or Gmail SMTP), **SMS** (MSG91; a Gupshup stub is unwired), **WhatsApp** (Twilio). Async work runs on a **hand-rolled Redis queue** — two lists (`queue:realtime`, `queue:other`), a sorted-set retry queue (exponential backoff, 5 attempts), and a DLQ list — drained by a forked worker process. A per-provider **token-bucket rate limiter exists but is dormant** (never called by the worker). **Nothing is persisted** beyond Redis: a Redis restart loses in-flight jobs, and there is no record of what was sent, its status, or any audit trail. There are **no tests**. The only evident caller is **Signals-DPG**, for signup/login OTP and action-event emails. Templates are *not* owned here — callers send pre-rendered HTML; NS only maps a public template id to a provider template id.

**aggregator-dpg** separately runs its **own Redis** and **custom email/SMS scripts** — a second, parallel notification stack with its own (absent) audit story.

**Cross-service interaction today** is point-to-point HTTP RPC. There is no shared event log, so there is no replay, no reproduce, no distributed trace across a flow, and no central, rate-limited place for **bulk fan-out** (T&C re-consent to all participants, a job-fair broadcast).

This work lands alongside two in-flight initiatives it must respect: the **Keycloak migration** (`sub` identity, realm-per-network, `client_credentials` M2M, a shared `jose`/JWKS verifier reused by "future services" — NS is exactly such a service, and is *already* the OTP sender for the Keycloak authenticator), and **consent management** (T&C version bumps trigger re-consent broadcasts; OTP capture rides notification-service).

### Problem Statement

**Problem 1 — No durable record, audit, or replay.** *Core challenge:* NS persists nothing; a Redis restart drops in-flight work, and there is no way to audit what was sent or to reproduce a past failure.

**Problem 2 — No resilient bulk fan-out.** *Core challenge:* broadcasts to all participants (T&C re-consent, campaigns) have no rate-limited, resilient, **reportable** path — and the rate limiter that would protect providers isn't even wired in.

**Problem 3 — Duplicated, fragmented notification stacks.** *Core challenge:* NS and aggregator each send email/SMS their own way, so there is no single authority, no consistent delivery semantics, and no unified audit.

**Problem 4 — Point-to-point coupling for cross-service reactions.** *Core challenge:* services trigger each other by direct RPC; there is no decoupled, replayable, traceable way to react to "X happened" — including the **response-handover** ("async work finished → notify the user").

**Problem 5 — Login and consent ride a fragile delivery path.** *Core challenge:* OTP is the dominant login flow and the consent re-prompt path; it must be **low-latency and must-not-fail**, yet today it rides the same un-audited bespoke queue as everything else.

**Problem 6 — Multi-tenant trust.** *Core challenge:* a shared notification/event service spans networks and instances, but inter-instance calls are currently unauthenticated; tenancy must derive from **verified claims**, never client input.

**Problem 7 — DPG license compliance.** *Core challenge:* a Digital Public Good requires every component to be **OSI-open and free to self-host**, with no enterprise-gated features — which disqualifies several reflexive defaults (Redpanda BSL, Confluent Schema Registry, Redis ≥ 7.4).

---

## 3. Key Design Problems

The design in §4 resolves the seven problems through deliberate choices, each with its trade-off:

- **A durable, replayable log as system-of-record** (§4.2) — Kafka is the audit and replay substrate (solves P1), at the cost of operating a cluster.
- **Two ingress doors** (§4.3) — a fast transactional path beside the log path keeps OTP low-latency (solves P5) without giving up bulk resilience (P2).
- **A typed event envelope + schema registry** (§4.4) — every message self-describes and versions (enables P4, P1), at the cost of contract discipline on producers.
- **A shared consumer/worker runtime** (§4.5) — idempotency, retry, DLQ, rate-limit, trace, once (solves P2), so consumers don't each reinvent them.
- **A redesigned notification consumer** (§4.6) — pluggable adapters, owned templates, consent, receipts; absorbs aggregator (solves P3), at the cost of a migration off its bespoke queue.
- **Choreography over orchestration** (§4.7) — cross-service reactions are event subscriptions (solves P4) and we refuse to build a workflow engine.
- **Tenancy from verified claims, Keycloak-target auth** (§4.8) — safe multi-tenancy (solves P6), behind a pluggable boundary so we don't block on Keycloak.
- **An OSI-open bill of materials** (§4.10) — Kafka + Strimzi + Apicurio + Debezium + Valkey (solves P7), refusing the gated defaults.

---

## 4. Design

### 4.1 Platform shape & the organising model

Events are the spine. Producers emit to a durable log; consumers react. Two ingress doors feed the log layer; the notification consumer is one reactor among several.

```
 producers (Signals, aggregator, voice, …)
    │   ┌───────────────── two ingress doors (§4.3) ─────────────────┐
    ▼   ▼                                                            ▼
 ┌───────────────┐                                          ┌────────────────┐
 │ transactional │  low-latency: OTP, single sends          │  event stream  │  bulk + domain events
 │  API (REST)   │                                          │  (produce SDK) │
 └───────┬───────┘                                          └───────┬────────┘
         └───────────────────────────┬──────────────────────────────┘
                                      ▼
        ┌──────────────────────────────────────────────────────────────┐
        │  APACHE KAFKA (KRaft)  — durable, ordered, replayable log       │  §4.2
        │  + tiered storage = audit/replay store   + Apicurio registry    │  §4.4
        └──────────────────────────────────┬───────────────────────────-─┘
                                            ▼
        ┌──────────────────────────────────────────────────────────────┐
        │  CONSUMER RUNTIME (SDK): idempotency · retry/backoff · DLQ ·    │  §4.5
        │  per-tenant/channel rate-limit · trace propagation             │
        └───────┬───────────────────────┬───────────────────────┬───────┘
                ▼                        ▼                        ▼
   ┌─────────────────────┐   ┌────────────────────┐   ┌────────────────────┐
   │ NOTIFICATION consumer│   │ other reactors      │   │ orchestration?      │
   │ channels · templates │   │ (choreography:      │   │ buy (Temporal) /    │
   │ consent · receipts   │   │  start work,        │   │ defer — NOT built   │
   │ (reused repo, §4.11) │   │  projections)       │   │ (§4.7)              │
   └──────────┬──────────-┘   └────────────────────┘   └────────────────────┘
              ▼
   observability: audit query · replay/reproduce · trace · bulk failure report  §4.9
```

The notification consumer **also serves the transactional API directly** — the fast door bypasses the log for OTP/single sends (§4.3). Everything else (bulk, domain-event reactions) flows through the log.

### 4.2 Event backbone: Apache Kafka (KRaft)

The backbone is **Apache Kafka in KRaft mode** (no ZooKeeper), self-hosted on EKS via the **Strimzi** operator. *Why a log and not a queue:* the audit / replay / reproduce / trace requirements (P1) demand that a message remain readable after consumption and that a consumer be able to re-read from any past offset or timestamp. A queue deletes on ack and cannot reproduce. *Why Kafka specifically* — over the lighter Redpanda and NATS JetStream we evaluated:

- **License (decisive).** Kafka is Apache-2.0 with *everything* open, including **tiered storage** (KIP-405) — which Redpanda gates behind its paid Enterprise tier and a BSL licence. The DPG rule (§4.10, P7) makes "free, fully open, nothing gated" non-negotiable, and Kafka's open tiered storage is exactly the cheap long-retention substrate the audit/replay store wants.
- **Producer outbox without dual-write.** Producers are Postgres-backed (Signals, aggregator on Drizzle). **Debezium** (Apache-2.0) reads a transactional outbox table via CDC and publishes to Kafka, so a producer never has to atomically write its DB *and* the log (§4.3). NATS has no comparable mature CDC path.
- **Escape hatch.** If self-operation hurts, AWS **MSK** is managed Apache Kafka — a connection-string change, no code change, and it keeps the DPG rule (our code stays open; MSK is only hosting).

**Topics & partitioning (provisional):** topic-per-event-family (`notify.transactional`, `notify.bulk`, `domain.events`, plus per-domain subjects as they appear), partition key = **recipient or tenant key** so a given recipient's messages stay ordered and a tenant can't starve others. Retention: hot retention on local disk (days) + tiered storage to S3 for the long audit tail. Topic naming, partition counts, and retention windows are fixed per-phase, not here.

### 4.3 Two ingress doors

We deliberately keep **two** ways in, because OTP and bulk have opposite needs.

```
 OTP / single send ──▶ [ transactional API ]  ──▶ send now (near-sync), then record to log for audit
 bulk / domain event ─▶ [ produce to Kafka ]   ──▶ consumer drains at a rate the provider tolerates
```

- **Transactional door** (`POST /v1/notify`, §6): low-latency, near-synchronous send for OTP and one-off sends. *Why:* routing OTP through a bulk log adds latency and a new failure mode to **login itself** (P5). The transactional door sends immediately and emits an audit event *after the fact*, so the critical path never waits on the log.
- **Event door** (produce via the SDK): the resilient path for bulk fan-out and for reacting to domain events (P2, P4). Producers emit through the **outbox + Debezium** pattern so the emit is atomic with their own DB write.

Both doors are authenticated and tenant-scoped identically (§4.8); they differ only in latency/durability posture.

### 4.4 Event envelope & contracts

Every message — transactional-audit or domain event — carries one envelope, versioned in a registry so consumers can evolve independently:

```jsonc
{
  "id":            "uuid",            // unique event id (dedup key at consumer)
  "type":          "tnc.published",   // dotted event type
  "version":       "1.0",             // schema version (registry-resolved)
  "source":        "signals-dpg",     // emitting service
  "network":       "blue_dot",        // tenant — from verified claim, never client input (§4.8)
  "org_id":        "uuid|null",       // acting org, when applicable
  "subject":       "sub|recipient",   // who it concerns / who to deliver to
  "correlation_id":"uuid",            // groups one logical flow (trace, §4.9)
  "causation_id":  "uuid|null",       // the event that caused this one
  "idempotency_key":"string",         // caller-supplied; collapses retries/replays
  "occurred_at":   "rfc3339",
  "payload":       { }                // type-specific, validated against the registered schema
}
```

The schema registry is **Apicurio** (Apache-2.0), *not* Confluent Schema Registry (Confluent Community License — source-available, restricted; fails P7). Producers register payload schemas; consumers resolve and validate by `type`+`version`. *Why an explicit envelope:* it makes tenancy, idempotency, and trace **first-class and uniform** across every consumer, rather than per-message conventions that drift.

### 4.5 Consumer/worker SDK & runtime

The new repo's core deliverable (§4.11) is a shared runtime so no consumer re-implements the hard parts:

- **At-least-once + idempotency.** Consumers dedup on envelope `id` / `idempotency_key`; processing is idempotent by contract.
- **Retry with backoff → DLQ.** Generalises today's hand-rolled 5-attempt exponential backoff and DLQ (§2) into the SDK, per consumer.
- **Rate-limiting, activated.** The existing per-provider token bucket (today dormant) becomes a runtime concern, keyed **per tenant × channel × provider**, so a bulk job for one network cannot exhaust a shared provider quota (P2).
- **Trace propagation.** `correlation_id` flows through every hop; the SDK stamps spans so a flow is reconstructable end-to-end (§4.9).

> **Note on retry semantics (the hard boundary):** the SDK retries **delivery**, never the **business operation**. A consumer that triggers external work owns that work's idempotency/compensation — the runtime will not re-invoke a non-idempotent operation on its behalf. This is the line that keeps the notification consumer from silently becoming an orchestrator (§4.7).

### 4.6 Notification delivery consumer (redesigned notification-service)

The existing repo is refactored into the first-class notification consumer. It keeps its strengths and gains what P1–P3 demand:

- **Adapter contract, enriched.** Keep `ProviderDefinition` + auto-discovery; extend it with **capabilities** (does this channel report delivery status?) and a **delivery-status** result, so the audit model tolerates "accepted, no receipt available" — which is the normal case for the new **`http_callout` channel** that triggers the **voice bot** and other internal services (an outbound POST, *not* a hosted webhook).
- **Templates, owned here (planned).** Move rendering out of callers (Signals sends raw HTML today). NS owns versioned, localisable templates keyed by `network × channel × template_key × locale` (§5).
- **Consent / opt-out enforcement.** Before delivery, check the **consent-service** (T&C re-consent, channel opt-out). Bulk = provenance, not a fabricated acceptance (per the consent design).
- **Delivery receipts.** Capture async provider status (SES bounces, MSG91 DLR, Twilio status) to close the loop for bulk reporting (P2).
- **Consolidation.** **Absorb aggregator's Redis queue + custom email/SMS scripts** (P3); aggregator stops sending directly and emits events instead. NS becomes the single notification authority and the OTP/consent/T&C delivery path.

### 4.7 Cross-service reactions: choreography, not orchestration

"Trigger workflows across services" is realised as **choreography**: a service emits a domain event; interested services subscribe and react; when async work completes, the owning service emits a completion event that the notification consumer turns into the **response-handover** notification to the user. No central coordinator sequences steps.

*Why we do not build orchestration:* the concrete cases (bulk export → notify; voice trigger; T&C broadcast) are single-step *trigger + outcome*, not multi-step sagas with compensation. Building a workflow engine is a multi-month trap with semantics (step state, compensation, branching) we'd get wrong. **If** a genuine saga appears, we **adopt Temporal** (open-source, self-hostable) as a *separate* consumer — never fold orchestration into the notification consumer, whose retry is delivery-retry only (§4.5 note).

### 4.8 Tenancy & auth

**Tenancy derives from the verified `network` claim**, never from client input — which is what makes a shared/central deployment safe despite today's unauthenticated inter-instance posture (P6). Every produced event and every API call is scoped to its `network`; audit, rate-limits, and templates are all per-network.

**Auth converges on the platform's shared verifier:** service-to-service is `client_credentials` + Bearer JWT, validated by the shared `jose`/JWKS module that signals-api and consent-service already use; `network`/`org_id`/`sub` come from claims. Because the Keycloak migration is provisional, the platform ships behind a **pluggable auth boundary**: today's **HMAC is the interim** strategy; the **Keycloak JWT validator** drops in at the migration's dual-accept window without touching routes or consumers.

### 4.9 Observability: audit, replay/reproduce, trace, bulk reporting

- **Audit.** The Kafka log (with tiered storage) is the event system-of-record; the notification consumer additionally materialises a queryable **audit projection** in Postgres (§5) — what was received, attempted, delivered, or failed.
- **Replay / reproduce.** Re-consume from any offset or timestamp to reproduce a past flow or recover a consumer; idempotency (§4.5) makes replay safe.
- **Trace.** `correlation_id` reconstructs an end-to-end flow across producers and consumers.
- **Bulk failure reporting.** A `bulk_job` snapshot (§5) tracks per-recipient outcome so a campaign can **report back** totals, failures, and a retry/replay handle (P2).

### 4.10 Open bill of materials & DPG compliance

**Invariant: every component is OSI-approved-license and free to self-host, with no enterprise-gated features (P7).** This retires the reflexive defaults and pins the open equivalents:

| Need | ❌ Common default (not OSI-open) | ✅ DPG-compliant choice |
|---|---|---|
| Log/backbone | Redpanda (BSL; tiered storage paid) | **Apache Kafka** (Apache-2.0) |
| Run Kafka on k8s | — | **Strimzi** operator (Apache-2.0, CNCF) |
| Schema registry | Confluent Schema Registry (Confluent Community Licence) | **Apicurio Registry** (Apache-2.0) |
| Outbox CDC | — | **Debezium** (Apache-2.0) |
| Cache / dedup store | Redis ≥ 7.4 (RSALv2/SSPL) | **Valkey** (BSD, Linux Foundation) |

### 4.11 Repo split

```
 NEW repo  (platform)          REUSED repo (notification-service)
 ┌────────────────────────┐    ┌──────────────────────────────────┐
 │ event envelope/contracts│   │ notification delivery consumer     │
 │ consumer/worker SDK     │◀──│  - depends on the platform SDK     │
 │ idempotency·retry·DLQ   │   │  - channel adapters (+ http_callout)│
 │ rate-limit·trace        │   │  - templates · consent · receipts  │
 │ open-BOM conventions    │   │  - transactional API (fast door)   │
 └────────────────────────┘    └──────────────────────────────────┘
        ▲           ▲
        │           │ (also depended on by Signals & aggregator as producers)
```

- **NEW repo (one)** — the shared platform layer: envelope/contracts + the consumer/worker SDK + open-BOM conventions. Separate from any single consumer because *every* service depends on it. Working name **Event Fabric** (`bluedots-eventbus` candidate) — to be fixed when the repo is created.
- **REUSED repo** — `notification-service`, refactored into the delivery consumer; depends on the SDK; keeps its direct API as the fast transactional door.
- **Operated infra** — the Kafka/Strimzi/Apicurio/Debezium stack is deployment config (in `bluedots-automation`), not a code repo.

### 4.12 Phase plan

Build order `0 → {1, 2, 3} → (4 only if needed)`. Each phase is its own branch/plan/spec.

- **Phase 1 (first slice): thin backbone + notification consumer (subsystems 0 + 2).** Minimal Kafka topics + envelope + Apicurio + a queryable audit projection, proven end-to-end by migrating the notification consumer off its bespoke Redis queue. Delivers immediate value (audit + resilient bulk + activated rate-limit) and forces the envelope to be real. The transactional/OTP door stays working throughout.
- **Phase 2: consumer SDK hardening (subsystem 1).** Extract the runtime (idempotency/retry/DLQ/rate-limit/trace) into the new repo as the shared SDK; observability surfaces (replay, trace, bulk reporting).
- **Phase 3: producer integration (subsystem 3).** Outbox + Debezium in Signals and aggregator; migrate Signals' direct `/notify` calls and **aggregator's Redis + custom email/SMS scripts** onto events.
- **Phase 4 (conditional): orchestration.** Only if a real saga appears — adopt Temporal as a separate consumer; otherwise never built.

### 4.13 Open questions / provisional premises

- **Topic taxonomy & partition strategy** (§4.2) are *(provisional)* — fixed in the Phase-1 spec against measured volumes.
- **Template ownership & i18n** (§4.6) are *(planned)* — may land in Phase 1 or be deferred to a notification-specific phase.
- **Auth cutover timing** (§4.8) is coupled to the Keycloak migration's dual-accept window — *(provisional)* until that lands.
- **Where the audit projection lives** — a new Postgres for the notification consumer (§5) vs a shared RDS database/user, following the consent-service precedent — *(provisional)*.
- **Voice-bot result handling** — `http_callout` is fire-and-record by default; whether any caller needs a synchronous result back is unconfirmed.

---

## 5. Data Model

All columns snake_case. The **Kafka log is the event system-of-record**; the tables below are the notification consumer's materialised **audit + reporting projections** in Postgres (Drizzle). *(planned — finalised in the Phase-1 spec.)*

### `notification_event`

| Column | Type | Description |
|---|---|---|
| `id` | uuid PK | |
| `event_id` | text | _envelope `id`; **unique**, the dedup key_ |
| `type` | text | _e.g. `tnc.published`_ |
| `version` | text | _schema version_ |
| `source` | text | _emitting service_ |
| `network` | text | _tenant; **from verified claim**_ |
| `correlation_id` | uuid | _flow grouping for trace (§4.9)_ |
| `causation_id` | uuid null | |
| `idempotency_key` | text | |
| `payload` | jsonb | _validated against registry schema_ |
| `received_at` | timestamptz | |

### `delivery_attempt`

| Column | Type | Description |
|---|---|---|
| `id` | uuid PK | |
| `notification_event_id` | uuid FK | |
| `channel` | text | _email / sms / whatsapp / http_callout_ |
| `provider` | text | _ses / msg91 / twilio / …_ |
| `attempt_no` | int | |
| `status` | text | _accepted / failed / dead_ |
| `provider_message_id` | text null | _for receipt correlation_ |
| `error` | text null | |
| `requested_at` | timestamptz | |
| `completed_at` | timestamptz null | |

### `delivery_receipt`

| Column | Type | Description |
|---|---|---|
| `id` | uuid PK | |
| `delivery_attempt_id` | uuid FK | |
| `status` | text | _delivered / bounced / failed (async provider callback)_ |
| `provider_status` | text | _raw provider code_ |
| `received_at` | timestamptz | |

### `bulk_job`  _(the snapshot that "reports back", §4.9)_

| Column | Type | Description |
|---|---|---|
| `id` | uuid PK | |
| `network` | text | |
| `requested_by` | text | _service/client from claim_ |
| `template_key` | text | |
| `channel` | text | |
| `total` / `succeeded` / `failed` | int | _running counts_ |
| `status` | text | _queued / running / done / partial_ |
| `created_at` | timestamptz | |

### `bulk_job_item`

| Column | Type | Description |
|---|---|---|
| `id` | uuid PK | |
| `bulk_job_id` | uuid FK | |
| `recipient` | text | |
| `status` | text | _pending / sent / failed_ |
| `delivery_attempt_id` | uuid null FK | |

### `template`  _(NS-owned templates, §4.6, planned)_

| Column | Type | Description |
|---|---|---|
| `id` | uuid PK | |
| `network` | text | |
| `channel` | text | |
| `template_key` | text | _e.g. `login_otp`, `tnc_update`_ |
| `version` | int | _immutable per version_ |
| `locale` | text | _i18n_ |
| `subject` | text null | _email only_ |
| `body` | text | |
| `active` | bool | _one active per (network, channel, key, locale)_ |

> **Note:** consent/opt-out state is **read from consent-service**, not stored here (§4.6).

---

## 6. API Spec

The **event door is not REST** — producers emit envelopes (§4.4) via the SDK / outbox. The REST surface is the **transactional fast door** plus admin/reporting. *(planned — finalised per phase.)*

### Public endpoints

#### `POST /v1/notify`  _(transactional fast door, §4.3)_
Request:
```jsonc
{
  "channel":      "email",            // email | sms | whatsapp | http_callout
  "to":           "user@example.com",
  "template_key": "login_otp",        // resolves an NS-owned template (§4.6)
  "locale":       "en",
  "variables":    { },                // validated against the channel/template schema
  "idempotency_key": "string"         // collapses retries
}
```
Responses: `202 { "notification_event_id": "uuid", "accepted": true }`, `4xx { error, message }`.
Validation:
- Auth: Bearer (Keycloak) or HMAC interim (§4.8); `network` from claim.
- `template_key` must resolve to an `active` template for the caller's `network` + `channel`.
- Re-send with the same `idempotency_key` returns the original result, does not re-send.

### Admin / reporting endpoints

#### `POST /v1/bulk`  _(enqueue a campaign → event door)_
Request: `{ template_key, channel, locale, audience_query | recipients[], variables }` → produces to the bulk topic, returns `202 { bulk_job_id }`.

#### `GET /v1/bulk/:id`  — the bulk snapshot (`total/succeeded/failed/status`, §5).
#### `GET /v1/notifications/:id`  — audit lookup for one notification.
#### `POST /v1/failed/retry`  — replay DLQ entries (existing capability, generalised).
#### `GET /v1/metrics/queue`  — queue depths + **consumer lag** (existing, extended).
#### `GET /providers` , `GET /providers/:name`  — channel/provider metadata (existing).

---

## 7. Summary

notification-service stops being a stateless HTTP mailer and becomes the **first consumer of a network-wide event backbone**. The platform is **Apache Kafka (KRaft)** as a durable, replayable log — chosen over Redpanda/NATS on the **DPG open-license rule** and on **open tiered storage + Debezium CDC** — fronted by **two ingress doors** (a fast transactional path that keeps OTP low-latency, and an event path for bulk and domain-event reactions). A shared **consumer SDK** (idempotency, retry/DLQ, per-tenant rate-limit, trace) lives in **one new repo**; the **reused notification-service** depends on it and adds owned templates, consent enforcement, and delivery receipts, **absorbing aggregator's duplicate stack**. Cross-service "workflows" are **choreography**; orchestration is **bought (Temporal) or never built**. Tenancy comes from the verified **`network` claim**; auth is **HMAC-interim, Keycloak-target** behind a pluggable boundary. The whole bill of materials is **OSI-open and free** (Kafka · Strimzi · Apicurio · Debezium · Valkey).

Net effect: durable audit, safe replay/reproduce, end-to-end trace, resilient and reportable bulk fan-out, one notification authority, and a platform an order of magnitude smaller than "build an orchestrator" because we refused to build one. Implementation is phased (§4.12), starting with a **thin backbone + the notification consumer** as the first vertical slice; orchestration is deferred until a real saga justifies it. Open items are tracked in §4.13.
