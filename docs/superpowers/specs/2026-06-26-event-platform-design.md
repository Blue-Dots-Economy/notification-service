# Event Platform & Notification-Service Redesign

> This is the umbrella design. It fixes the whole-platform vision, decisions, and phasing; each phase gets its own detailed spec.
> A formatted version for the system architect lives alongside this file as `2026-06-26-event-platform-design.technical.md`.

## Overview

We're redesigning **notification-service** from an HTTP-only mailer into the **first consumer of a network-wide, replayable event backbone**.

The organising idea: **events are the spine of the network.** Services emit domain events (`tnc.published`, `action.performed`, `job.completed`) to a durable, ordered, replayable log; consumers react to the ones they care about. **Notification** — email, SMS, WhatsApp, and outbound service-triggers like the voice bot — is the **first and most important consumer, not the centre.** Cross-service reactions are **choreography over the log**; multi-step orchestration is **bought or deferred, never hand-built**.

The platform is three parts, only one of which we build from scratch:

- **Event backbone** — an operated Apache Kafka cluster + its contracts. *Infra, not a codebase.*
- **Consumer SDK** — the shared library every producer/consumer depends on (envelope, idempotency, retry/DLQ, rate-limit, trace). *One new repo.*
- **Notification delivery consumer** — today's notification-service, refactored. *Reused repo.*

## Goals

- Durable **audit** of everything sent, with **replay/reproduce** and end-to-end **trace**.
- **Resilient, rate-limited, reportable bulk fan-out** (T&C re-consent, campaigns).
- **One notification authority** — absorb aggregator's duplicate Redis + custom email/SMS stack.
- **Decoupled cross-service reactions** (including async response-handover to the user).
- Keep **OTP/login delivery low-latency and reliable** — it must not regress.
- **Multi-tenant** across networks/instances, with tenancy from **verified claims**.
- Every component **OSI-open and free** (DPG requirement).

## Non-goals

- **Not** building a workflow/orchestration engine. Choreography first; adopt Temporal only if a real saga appears.
- **Not** turning notification-service into a generic RPC/data bus. Bulk export, profile fetch, and metric rollups belong to other services (e.g. a future insights/data-pipeline-service), not here.
- **Not** blocking on the Keycloak migration — auth ships behind a pluggable boundary.

## Where things stand today

notification-service is Fastify 5 with **no database**. Every route is HMAC-signed; `POST /notify` is the only ingestion path. Three channels through an already-clean adapter contract (`ProviderDefinition { name, templates, schema, send() }` + folder auto-discovery): email (SES/Gmail), SMS (MSG91; Gupshup stub unwired), WhatsApp (Twilio). Async work runs on a **hand-rolled Redis queue** (two lists + a sorted-set retry queue with 5-attempt exponential backoff + a DLQ), drained by a forked worker. A per-provider **token-bucket rate limiter exists but is dormant**. **Nothing is persisted** — a Redis restart loses in-flight jobs, and there's no audit. **No tests.** Only caller is Signals (OTP/login/action). Templates aren't owned here — callers send pre-rendered HTML.

Separately, **aggregator-dpg runs its own Redis + custom email/SMS scripts** — a second, parallel notification stack.

This lands alongside the **Keycloak migration** (realm = network, `sub` identity, `client_credentials` M2M, shared JWKS verifier — NS is already the OTP sender for the Keycloak authenticator) and **consent management** (T&C bumps trigger re-consent broadcasts via NS).

## Problems we're solving

1. **No durable record / audit / replay** — NS persists nothing; Redis restart drops work.
2. **No resilient bulk fan-out** — broadcasts have no rate-limited, reportable path; the rate limiter isn't even wired.
3. **Duplicated notification stacks** — NS and aggregator each send their own way; no single authority or audit.
4. **Point-to-point coupling** — services trigger each other by direct RPC; no decoupled, replayable way to react to "X happened" (incl. response-handover).
5. **Login/consent ride a fragile path** — OTP must be low-latency and must-not-fail, yet rides the same un-audited bespoke queue.
6. **Multi-tenant trust** — a shared service spans networks/instances, but inter-instance calls are unauthenticated; tenancy must come from verified claims.
7. **DPG license compliance** — every component must be OSI-open and free; common defaults (Redpanda BSL, Confluent Schema Registry, Redis ≥ 7.4) violate this.

## Key decisions

**Apache Kafka (KRaft), self-hosted via Strimzi, as the backbone.** A log, not a queue, because audit/replay/reproduce need messages to survive consumption and be re-readable from any offset/time. Kafka over the lighter Redpanda and NATS because:
- *License (decisive):* Kafka is Apache-2.0 with **everything** open including **tiered storage** (cheap long retention = the audit store). Redpanda gates tiered storage behind a paid BSL tier — fails the DPG rule.
- *Producer outbox without dual-write:* producers are Postgres-backed, so **Debezium** CDC reads an outbox table and publishes to Kafka. NATS has no comparable mature CDC.
- *Escape hatch:* AWS **MSK** is managed Apache Kafka — a connection-string change, no code change, still DPG-compliant.

**Two ingress doors.** OTP and bulk have opposite needs, so we keep both:
- *Transactional door* (`POST /v1/notify`): near-synchronous send for OTP/single sends, then records an audit event after the fact — the login path never waits on the log.
- *Event door* (produce via SDK + outbox/Debezium): the resilient path for bulk and domain-event reactions.

**A typed event envelope + schema registry (Apicurio).** Every message self-describes: `id`, `type`, `version`, `source`, `network` (tenant), `org_id`, `subject`, `correlation_id`, `causation_id`, `idempotency_key`, `occurred_at`, `payload`. Apicurio (Apache-2.0), not Confluent Schema Registry (restricted licence).

**A shared consumer/worker runtime (the SDK).** At-least-once + idempotency (dedup on `id`/`idempotency_key`), retry/backoff → DLQ, **rate-limiting activated** (per tenant × channel × provider), trace propagation via `correlation_id`. **Hard boundary: the runtime retries *delivery*, never the *business operation*** — a consumer that triggers external work owns that work's idempotency/compensation. This is what keeps the notification consumer from silently becoming an orchestrator.

**Notification consumer redesign.** Keep `ProviderDefinition` + auto-discovery; enrich it with channel **capabilities** and a **delivery-status** result so audit tolerates "accepted, no receipt available" — the normal case for the new **`http_callout` channel** that triggers the voice bot (an outbound POST, *not* a hosted webhook). Add NS-**owned, versioned, localisable templates** (move rendering out of callers); **consent/opt-out enforcement** (read from consent-service); **delivery receipts** (SES bounces, MSG91 DLR, Twilio status). **Absorb aggregator's Redis + email/SMS scripts** — aggregator emits events instead.

**Choreography, not orchestration.** A service emits a domain event; interested services react; when async work finishes, the owning service emits a completion event that NS turns into the response-handover notification. No central coordinator. If a real multi-step saga appears, adopt **Temporal** as a separate consumer — never fold it into NS.

**Tenancy from the verified `network` claim**, never client input — this makes a shared deployment safe despite today's unauthenticated inter-instance posture. **Auth: HMAC-interim → Keycloak `client_credentials`/JWKS-target**, behind a pluggable boundary so we don't block on the parked Keycloak work.

**OSI-open bill of materials.** Kafka · Strimzi · Apicurio (not Confluent SR) · Debezium · Valkey (not Redis ≥ 7.4 — RSALv2/SSPL).

## Architecture

```
 producers (Signals, aggregator, voice, …)
    │   ┌──────────────── two ingress doors ─────────────────┐
    ▼   ▼                                                     ▼
 ┌───────────────┐                                  ┌────────────────┐
 │ transactional │  low-latency: OTP, single sends  │  event stream  │  bulk + domain events
 │  API (REST)   │                                  │  (produce SDK) │  (outbox + Debezium)
 └───────┬───────┘                                  └───────┬────────┘
         └──────────────────────┬──────────────────────────┘
                                ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  APACHE KAFKA (KRaft) — durable, ordered, replayable log        │
   │  + tiered storage = audit/replay store   + Apicurio registry    │
   └──────────────────────────────────┬───────────────────────────-─┘
                                       ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  CONSUMER RUNTIME (SDK): idempotency · retry/backoff · DLQ ·    │
   │  per-tenant/channel rate-limit · trace propagation             │
   └───────┬───────────────────────┬───────────────────────┬───────┘
           ▼                        ▼                        ▼
 ┌─────────────────────┐  ┌────────────────────┐  ┌────────────────────┐
 │ NOTIFICATION consumer│  │ other reactors      │  │ orchestration?      │
 │ channels · templates │  │ (choreography:      │  │ buy (Temporal) /    │
 │ consent · receipts   │  │  start work,        │  │ defer — NOT built   │
 │ (reused repo)        │  │  projections)       │  │                     │
 └──────────┬──────────-┘  └────────────────────┘  └────────────────────┘
            ▼
 observability: audit query · replay/reproduce · trace · bulk failure report
```

The notification consumer **also serves the transactional API directly** — the fast door bypasses the log for OTP/single sends. Everything else flows through the log.

## Data model (notification consumer audit/reporting projection, Postgres/Drizzle — planned)

The Kafka log (with tiered storage) is the event system-of-record; these are the consumer's materialised projections.

- **`notification_event`** — `id`, `event_id` (envelope id, unique dedup key), `type`, `version`, `source`, `network`, `correlation_id`, `causation_id`, `idempotency_key`, `payload` (jsonb), `received_at`.
- **`delivery_attempt`** — `id`, `notification_event_id`, `channel`, `provider`, `attempt_no`, `status`, `provider_message_id`, `error`, `requested_at`, `completed_at`.
- **`delivery_receipt`** — `id`, `delivery_attempt_id`, `status` (delivered/bounced/failed), `provider_status`, `received_at`.
- **`bulk_job`** (the snapshot that "reports back") — `id`, `network`, `requested_by`, `template_key`, `channel`, `total`/`succeeded`/`failed`, `status`, `created_at`.
- **`bulk_job_item`** — `id`, `bulk_job_id`, `recipient`, `status`, `delivery_attempt_id`.
- **`template`** (NS-owned) — `id`, `network`, `channel`, `template_key`, `version`, `locale`, `subject`, `body`, `active`.

Consent/opt-out is **read from consent-service**, not stored here.

## API sketch (transactional + admin; event door is produce-via-SDK, not REST — planned)

- `POST /v1/notify` — transactional fast door. `{ channel, to, template_key, locale, variables, idempotency_key }` → `202 { notification_event_id, accepted }`. Auth Bearer/HMAC; `network` from claim; re-send with same `idempotency_key` returns the original result.
- `POST /v1/bulk` — enqueue a campaign (→ event door). `{ template_key, channel, locale, audience_query|recipients[], variables }` → `202 { bulk_job_id }`.
- `GET /v1/bulk/:id` — bulk snapshot/report.
- `GET /v1/notifications/:id` — audit lookup.
- `POST /v1/failed/retry` — replay DLQ.
- `GET /v1/metrics/queue` — depths + consumer lag.
- `GET /providers`, `GET /providers/:name` — channel metadata (existing).

## Repos

- **One new repo** (platform) — event envelope/contracts + consumer/worker SDK + open-BOM conventions. Separate from any single consumer because *every* service depends on it. Working name **Event Fabric** / `bluedots-eventbus` (fixed when created).
- **Reused** — `notification-service`, refactored into the delivery consumer; depends on the SDK; keeps its direct API as the fast door.
- **Operated infra** — the Kafka/Strimzi/Apicurio/Debezium stack is deployment config in `bluedots-automation`, not a repo.

## Phases

Build order `0 → {1,2,3} → (4 if needed)`. Each phase = its own branch/plan/spec.

1. **Thin backbone + notification consumer** (first slice) — minimal Kafka topics + envelope + Apicurio + a queryable audit projection, proven by migrating the notification consumer off its bespoke Redis queue. Delivers audit + resilient bulk + activated rate-limiting; forces the envelope to be real. Transactional/OTP door stays working throughout.
2. **Consumer SDK hardening** — extract the runtime into the new repo as the shared SDK; observability surfaces (replay, trace, bulk reporting).
3. **Producer integration** — outbox + Debezium in Signals and aggregator; migrate Signals' direct `/notify` calls and aggregator's Redis + email/SMS scripts onto events.
4. **Orchestration (conditional)** — only if a real saga appears; adopt Temporal as a separate consumer. Otherwise never built.

## Open questions

- Topic taxonomy & partition strategy — fixed in the Phase-1 spec against measured volumes.
- Template ownership & i18n — may land in Phase 1 or a later notification-specific phase.
- Auth cutover timing — coupled to the Keycloak migration's dual-accept window.
- Where the audit projection lives — a new Postgres for NS vs shared RDS database/user (consent-service precedent).
- Voice-bot result handling — `http_callout` is fire-and-record by default; whether any caller needs a synchronous result back is unconfirmed.
