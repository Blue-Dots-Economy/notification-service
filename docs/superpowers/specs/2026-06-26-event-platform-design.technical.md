# Blue Dots Event Platform & Notification Authority (umbrella)

**Audience:** System architect and engineers building the Blue Dots notification and event platform — the redesigned notification-service, the shared event backbone, and the consumer SDK — plus the Signals / aggregator / voice teams who will call it and produce to it. This is the **umbrella** design: it fixes the whole-platform vision and invariants; each stage (§4.18) gets its own detailed spec.

**Status:** Revised 2026-08-06. This copy tracks the canonical spec (`2026-06-26-event-platform-design.md`) as of that revision. Where the two differ, the canonical spec wins.

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

This document describes the redesign of **notification-service** (NS) from an HTTP-only mailer into the **notification authority for the network**, and — subsequently — the first consumer of a durable, replayable event backbone.

The organising idea has changed since the June draft, and the change is the most important thing in this document.

**Then:** *events are the spine; everything flows through the log.*
**Now:** *events are the spine, but not the only wire.*

The reframe came from a direct question: if the low-latency path also runs through the bus, does it not get stuck behind the same consumer as everything else? It does — and the answer is not to make the consumer faster. It is to stop treating the bus as the universal transport:

- **Call the consumer's API** when the caller needs to know it worked *now* — OTP, login, single transactional sends. NS's own API is the **contract**, not a fallback lane.
- **Emit an event** when the caller should not know or care who reacts, or when fan-out must be durable and rate-limited.
- **OTP never rides the bus.** A hard non-goal (§4.2), not an implicit consequence.

This generalises past notification: every consumer-routed service exposes its own API, and the bus is not an RPC substitute. Putting a synchronous need behind a shared consumer group *manufactures* the bottleneck the bus was supposed to remove.

The second reframe follows from the first. **Bypassing the bus does not, on its own, isolate OTP** (§4.3). On the direct path it still shares NS's process, its Postgres, and — decisively — the *provider account*. A 200k-recipient T&C broadcast exhausts the MSG91 quota and queues OTPs *at the provider*, whatever the transport. Isolation is a **resource** problem: worker pools and reserved quota.

The platform has three parts, only one of which is written from scratch:

- **The notification service** — today's repo, substantially extended. *Reused.* **Useful on its own, long before any backbone exists** (§4.18).
- **The event backbone** — an operated Apache Kafka cluster plus its contracts. *Infra, not a codebase* (§4.12).
- **The consumer SDK** — the shared library every producer and consumer depends on. *One new repo* (§4.17).

The design covers the routing rule and urgent-path isolation (§4.2–4.3); the template and routing-policy model (§4.4–4.5); content resolution and the consent boundary (§4.6); trace, status, receipts, and retention (§4.7–4.9); tenancy, auth, and security posture (§4.10–4.11); the backbone, envelope, and runtime (§4.12–4.15); and the open bill of materials, repo split, and staged delivery (§4.16–4.18).

> **Note on consent (scope reduction):** NS **enforces nothing about consent** (§4.6). Consent acceptance is enforced in Signals/aggregator code against their own Postgres. NS only *renders* consent content. This removes the consent-service dependency, and with it the parked-Keycloak blocker, from this epic's critical path — the single largest scheduling change in the revision.

> **Note on orchestration (out of build scope):** "Trigger workflows across services" is realised as event choreography (§4.15). We do **not** build a workflow engine; if a genuine multi-step saga with compensation appears, we adopt Temporal as a separate consumer. This keeps the platform an order of magnitude smaller.

> **Note on sequencing (changed):** The stage order is deliberately **not** backbone-first (§4.18). Stages 1–2 deliver a working notification authority with **zero Kafka**, so the template and audit models are validated by a real second consumer before any infrastructure is committed to.

---

## 2. Background & Problem Statement

### Background

**notification-service today** is a Fastify 5 service with **no durable database**. Every endpoint is authenticated by a hand-rolled HMAC over `METHOD\nPATH\nTIMESTAMP\nNONCE`, with keys loaded from a JSON file and Redis-backed nonce replay protection. *(This is unrelated to better-auth, which was Signals' **user** auth — a recurring point of confusion.)* The only ingestion path is `POST /notify`.

Three channels sit behind a clean, already-generalised adapter contract — `ProviderDefinition { name, templates, schema, send() }` with folder-scanning auto-discovery: **email** (AWS SES or SMTP), **SMS** (MSG91; a Gupshup stub is unwired), **WhatsApp** (Twilio). Async work runs on a **hand-rolled Redis queue** — two lists, a sorted-set retry queue with exponential backoff, and a DLQ — drained by a forked worker. A per-provider **token-bucket rate limiter exists but is dormant**. **Nothing is persisted**: a Redis restart loses in-flight jobs, and there is no record of what was sent. A test suite **does** now exist (33 tests, CI-wired) — the June draft's "no tests" is stale. The only caller is Signals-DPG.

**Templates are not owned here, and the three channels are not symmetric.** This asymmetry is load-bearing for §4.4:

```
 CHANNEL     WHERE THE BODY LIVES TODAY                      CAN NS OWN IT?
 ─────────   ─────────────────────────────────────────────   ──────────────
 email       caller sends full subject + html;               YES
             'basic_email' is a sentinel, not a template

 sms         MSG91 flow id — DLT-registered with the         NO
             Indian telecom regulator                        (regulated, provider-side)

 whatsapp    Twilio contentSid — template approved by        NO
             Meta before it may be sent                      (provider-side)
```

WhatsApp additionally exposes an `other` escape hatch that lets any caller pass an arbitrary `contentSid`. That hole is a large part of why template governance is worth building (§4.4, §4.11).

**aggregator-dpg** has a single `MailerAdapter` (SES or SMTP) with four HTML templates, called **synchronously inline** from four route handlers. It has **no SMS stack and no Redis notification queue** — the June draft's "aggregator's Redis + custom email/SMS scripts" overstated this, and the migration is correspondingly smaller (§4.18, Stage 2).

**Cross-service interaction today** is point-to-point HTTP RPC. There is no shared event log, so no replay, no reproduce, no trace across a flow, and no rate-limited place for **bulk fan-out**.

**In-flight initiatives this must respect.** The **Keycloak migration** landed on the `epic/keycloak-iam` branch (signals-dpg #456, aggregator #570, both merged 2026-08-03) but has **not** reached `feature`; merge-back is gated on that epic's unresolved shared-realm-versus-per-DPG-realm question. aggregator #570 implements *shared-realm service auth*, which is the M2M pattern NS adopts (§4.10). Separately, a **Phase-B security audit** of this service is open (#15), with candidate findings held in a private advisory; §4.11 states the design requirements that follow.

### Problem Statement

**Problem 1 — No durable record, audit, or trace.** *Core challenge:* NS persists nothing; a restart drops in-flight work; there is no way to answer "what happened to that message".

**Problem 2 — No resilient bulk fan-out.** *Core challenge:* broadcasts have no rate-limited, resilient, **reportable** path — and the limiter that would protect providers is not wired in.

**Problem 3 — Duplicated notification stacks.** *Core challenge:* NS and aggregator each send their own way, so there is no single authority and no unified audit.

**Problem 4 — No template governance.** *Core challenge:* bodies are hardcoded in adapters or hand-built by callers, and any caller can send an arbitrary approved WhatsApp template. A wrong DLT-registered template is a **compliance incident**, not a formatting bug.

**Problem 5 — No routing policy.** *Core challenge:* nothing expresses "SMS for seekers, email for providers", and nothing decides what happens when a recipient has no email address.

**Problem 6 — Point-to-point coupling.** *Core challenge:* services trigger each other by direct RPC; there is no decoupled, replayable way to react to "X happened", including **response-handover**.

**Problem 7 — Login rides a fragile path.** *Core challenge:* OTP must be low-latency and must-not-fail, yet shares every resource — process, storage, and **provider quota** — with everything else.

**Problem 8 — Multi-tenant trust.** *Core challenge:* a shared service spans networks, domains, and instances; tenancy must come from verified claims and be enforced at *resolution*, not only at the edge.

**Problem 9 — DPG license compliance.** *Core challenge:* every component must be OSI-open and free; the common defaults (Redpanda BSL, Confluent Schema Registry, Redis ≥ 7.4) all violate this.

---

## 3. Key Design Problems

The design in §4 resolves the nine problems through deliberate choices, each with its trade-off:

- **A routing rule, not a universal transport** (§4.2) — consumer-owned APIs are the default contract and the bus is for fan-out and decoupled reaction (solves P7, enables P6), at the cost of two surfaces to keep coherent.
- **Priority pools and reserved provider quota** (§4.3) — isolation treated as a resource problem rather than a transport problem (solves P7 properly), at the cost of a more complex worker topology.
- **Templates and routing as two objects** (§4.4–4.5) — content separated from the decision of which content, on which channel, for whom (solves P4, P5), at the cost of two admin surfaces instead of one.
- **Two render modes** (§4.4) — honest about SMS and WhatsApp bodies living at the provider (solves P4 without pretending), at the cost of a discriminated model.
- **A content resolver behind a consent boundary** (§4.6) — NS renders consent content without enforcing consent (unblocks the epic), at the cost of trusting the caller's audience.
- **Two identifiers and an explicit status lifecycle** (§4.7) — business trace separated from observability trace (solves P1), at the cost of carrying both everywhere.
- **Tiered retention with partition-drop** (§4.9) — a bounded, erasable operational store (solves P1's compliance half), at the cost of a stated 90-day audit horizon until tiered storage exists.
- **A durable, replayable log as long-term system-of-record** (§4.12) — Kafka is the audit and replay substrate (completes P1, solves P2), at the cost of operating a cluster.
- **A typed, harmonized envelope + schema registry** (§4.13) — one contract shared with the telemetry platform (enables P6), at the cost of contract discipline on producers.
- **A shared consumer runtime** (§4.14) — idempotency, retry, DLQ, rate-limit, trace, written once (solves P2).
- **Choreography over orchestration** (§4.15) — cross-service reactions are subscriptions (solves P6), and we refuse to build a workflow engine.
- **Tenancy from verified claims, enforced at resolution** (§4.10) — safe multi-tenancy (solves P8), behind a pluggable boundary so we do not block on Keycloak.
- **An OSI-open bill of materials** (§4.16) — Kafka · Strimzi · Apicurio · Debezium · Valkey (solves P9), refusing the gated defaults.

---

## 4. Design

### 4.1 Platform shape & the organising model

The notification service is the centre of *this* diagram because it is the first consumer built; it is not the centre of the network. Note that the API path reaches the core **without traversing the log** — that is the whole point of §4.2.

```
 callers (Signals, aggregator, voice, …)
    │
    ├── needs to know it worked NOW? ──────────────────────┐
    │                                                      │
    └── doesn't care who reacts, or bulk? ──┐              │
                                            ▼              ▼
              ┌──────────────────────────────────┐   ┌──────────────────────┐
              │  produce via SDK (§4.14)         │   │  NS REST API (§4.2)  │
              │  outbox + Debezium (§4.12)       │   │  POST /v1/notify     │
              └────────────────┬─────────────────┘   │  POST /v1/bulk       │
                               ▼                     │  admin: templates,   │
    ┌──────────────────────────────────────────┐     │         policy       │
    │ APACHE KAFKA (KRaft) — durable, ordered, │     └───────────┬──────────┘
    │ replayable log. Tiered storage = the     │ §4.12           │
    │ long-term audit store. Apicurio registry │ §4.13           │
    └──────────────────┬───────────────────────┘                 │
                       ▼                                         │
    ┌──────────────────────────────────────────┐                 │
    │ CONSUMER RUNTIME (SDK): idempotency ·    │ §4.14           │
    │ retry/backoff · DLQ · rate-limit · trace │                 │
    └──────────────────┬───────────────────────┘                 │
                       │                                         │
                       ▼                                         ▼
 ┌─────────────────────────────────────────────────────────────────────────┐
 │  NOTIFICATION SERVICE core                                              │
 │                                                                         │
 │   policy resolve ──► capability filter ──► template render              │
 │        §4.5              §4.5                   §4.4 (+ §4.6 content)   │
 │          │                                                              │
 │          ▼      ┌──── URGENT pool ────┐                                 │
 │      dispatch   ├──── NORMAL pool ────┤ ◄── split provider quota  §4.3  │
 │                 └──── BULK   pool ────┘                                 │
 │                                                                         │
 │   channels: email · sms · whatsapp · http_callout                       │
 │   audit projection (partitioned, 90d) · aggregate counters        §4.9  │
 └───────────────────────────────┬─────────────────────────────────────────┘
                                 ▲
         provider callbacks ─────┘   SES/SNS · MSG91 DLR · Twilio status
         signature-verified, own low-priority lane → delivery_receipt  §4.8

 trace: correlation_id (business) + trace_id (W3C) on every record   §4.7
```

### 4.2 Ingress: the routing rule and two doors

We keep **two** ways in, because OTP and bulk have opposite needs — but the choice between them is now a stated rule rather than an implementation detail.

```
                          ┌──────────────────────────────────┐
   Does the caller need   │                                  │
   to know it worked NOW? ├── YES ──► CALL THE API           │  synchronous
                          │           POST /v1/notify        │  contract
                          │           (OTP, login, single)   │
                          │                                  │
                          ├── NO, and it doesn't care        │
                          │   who reacts ──► EMIT AN EVENT   │  choreography
                          │                                  │
                          └── NO, but it's mass fan-out      │
                              ──► EMIT AN EVENT              │  durable,
                                  (bulk topic)               │  rate-limited
                          └──────────────────────────────────┘

   INVARIANT: OTP never rides the bus. Not as a fallback, not under load,
              not "temporarily". It is a hard non-goal.
```

- **Transactional door** (`POST /v1/notify`, §6): near-synchronous send. *Why:* routing OTP through a shared log adds latency and a new failure mode to **login itself** (P7). The door sends immediately and records audit *after the fact* — and on the urgent path that audit write is **fire-and-forget** (§4.3), so a slow Postgres cannot delay an OTP.
- **Event door** (produce via the SDK): the resilient path for bulk fan-out and domain-event reactions (P2, P6). Producers emit through **outbox + Debezium** so the emit is atomic with their own database write (§4.12).

Both doors are authenticated and tenant-scoped identically (§4.10); they differ only in latency and durability posture.

> **Note:** This generalises beyond notification. Every consumer-routed service should expose its own API for the synchronous case. The bus is not an RPC substitute — and a shared consumer group in front of a synchronous need is a bottleneck by construction, not by misconfiguration.

### 4.3 Isolating the urgent path

**The door is not the isolation.** This is the correction that most changes the June design. On the direct API path, OTP still contends for three shared resources, and the third is the one that actually bites:

```
  shared resource            does the direct door help?   what actually protects OTP
  ─────────────────────────  ──────────────────────────   ──────────────────────────────
  NS process / event loop    partially                    separate worker pools
  Postgres audit writes      no                           fire-and-forget on urgent path
  PROVIDER ACCOUNT + QUOTA   no — not at all              reserved share of the bucket
  (one MSG91 sender,
   one SES account)
```

A 200k-recipient T&C broadcast will exhaust the SMS quota and queue OTPs **at MSG91**, where no amount of NS architecture can reach them. So:

```
  POST /v1/notify {priority: urgent}          bulk consumer (Stage 3)
            │                                          │
            ▼                                          ▼
  ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐
  │   URGENT pool     │  │   NORMAL pool     │  │    BULK pool      │
  │   workers 1..N    │  │   workers 1..M    │  │   workers 1..K    │
  └─────────┬─────────┘  └─────────┬─────────┘  └─────────┬─────────┘
            │                      │                      │
            ▼                      ▼                      ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │  PROVIDER TOKEN BUCKET  (per network × channel × provider)      │
  │                                                                 │
  │  ├─── reserved for URGENT ───┤├──── shared: normal + bulk ────┤ │
  │        bulk CANNOT draw from this ^                             │
  └─────────────────────────────────────────────────────────────────┘

  audit write:  urgent ──► fire-and-forget   |   normal/bulk ──► awaited
```

- `priority: urgent | normal | bulk`, on the send API or derived from template metadata.
- **Separate worker pools.** A bulk job occupying a worker slot cannot block an urgent one — this removes head-of-line blocking, which a priority *queue* alone does not (a slow provider call still holds the slot).
- **The dormant token bucket is activated *and split*.** Activation alone would still let bulk consume the whole allowance.
- **One deployment, not two.** The pools give the isolation without a second deployment's configuration surface; a second deployment would also still share the provider account, so it solves less than it costs.

### 4.4 Templates: one entity, two render modes

Templates carry *content*. §4.5 decides which content. Keeping them apart is what makes "send to both" expressible at all.

The model must be honest about the asymmetry in §2: NS can own email bodies and can **never** own SMS or WhatsApp bodies, because those are registered with the Indian telecom regulator and approved by Meta respectively.

```
  template  —  key (network, channel, template_key, locale)
  ├── status: draft ──► active ──► retired      exactly one `active` per key
  │                                              retire NEVER deletes (audit refs)
  ├── variables[]: { name, required, type, source, sensitive }
  │        │              │                        │
  │        │              │                        └─ redacted at write (§4.9)
  │        │              └─ 'caller' | 'content_ref'  (§4.6)
  │        └─ validated BEFORE the provider is called — in BOTH modes
  │
  └── render_mode
      │
      ├── 'owned'          (email)
      │     NS stores subject / body_html / body_text and renders.
      │     Variables HTML-escaped by default (§4.11).
      │
      └── 'provider_ref'   (sms, whatsapp)
            NS stores provider_template_id  — MSG91 flow id / Twilio contentSid
                       provider_approval_ref — DLT entity+template id / Meta status
            The PROVIDER renders. NS owns the reference, the variable
            contract, and the lifecycle — not the body.

  caller always sends:  { template_key, locale, variables }
  and never sees which mode it hit.
```

**Why the variable contract matters even where NS cannot own the body.** Pre-dispatch validation is the *only* control point NS has over a `provider_ref` send. Today a malformed MSG91 call simply fails at the provider, with no record and no diagnosis.

**Why lifecycle rather than mutation.** Audit rows (§5) reference the template version that was actually sent. Retire-not-delete keeps a two-year-old delivery explicable.

**Migration.** The hardcoded `templates` maps in the three adapters seed the registry, and the WhatsApp `other` passthrough is retired (§4.11).

### 4.5 Routing policy & recipient capability

```
  notification_policy — key (network, domain, event_type)
                                  ▲          ▲
                     nullable ────┘          └──── nullable
                     → network-wide defaults and per-domain / per-event
                       overrides are ONE mechanism at different specificity.
                       MOST-SPECIFIC-WINS.

  ┌─────────────┬───────────────────────────────────────────────────┐
  │ mode        │ behaviour                                         │
  ├─────────────┼───────────────────────────────────────────────────┤
  │ first_      │ try channels in order; fall through on failure    │
  │  available  │ or on a missing contact point                     │
  │ all         │ fan out to every listed channel                   │
  └─────────────┴───────────────────────────────────────────────────┘

  e.g.  (blue_dot, seeker,   *)              → [sms → email]  first_available
        (blue_dot, provider, *)              → [email]        first_available
        (blue_dot, *,  action.approved)      → [sms, email]   all
        (blue_dot, *,  *)                    → [email]        first_available
```

**Resolution pipeline at send time:**

```
  request ──► resolve policy ──► filter by capability ──► render ──► dispatch
              (network from       (what contact points     §4.4      §4.3
               CLAIM, domain       did the caller give
               from CALLER)        us?)
                    │                      │
                    │                      └─ policy says [sms, email]
                    │                         recipient has phone only
                    │                         ⇒ sms is the only candidate.
                    │                         No special case needed.
                    │
                    └─ most-specific-wins; must be EXPLAINABLE — an operator
                       has to be able to answer "why did this go by SMS?"
```

**NS holds no user directory.** The caller passes every contact point it holds; NS filters. NS never calls Signals to resolve a person: that would put a network hop on the OTP path (§4.3) and turn NS into a PII store subject to erasure obligations it is designed to avoid (§4.9).

**Where the resolution inputs come from** — and this distinction is deliberate:

- `network` — from the **verified claim**, never the body. It is the tenancy boundary (§4.10).
- `domain` — from the **caller**. Only the caller knows which role the recipient is being addressed in; the same person is a seeker in one flow and a provider in another, so it is a property of the *send*, not of the identity. Optional; omitting it resolves the network-wide default.
- `event_type` goes through policy; `template_key` names content directly, bypassing policy — the migration path and the one-off escape hatch. Exactly one is required.

**Fallback has two clocks, and conflating them yields a design that cannot work:**

```
  SYNCHRONOUS failure                    ASYNCHRONOUS failure
  (provider rejects; no contact point)   (bounce / DLR, seconds to hours later)
            │                                       │
            ▼                                       ▼
  fall through to next channel NOW       the send already returned 202.
  — the request is still in flight       Nothing to "retry in place".
                                                    │
                                         Stage 1–2: record terminal `failed`,
                                                    queryable by trace (§4.7)
                                         Stage 3+ : emit notification.delivery_failed;
                                                    a policy MAY opt into async fallback
```

### 4.6 Content resolution & the consent boundary

**NS enforces nothing about consent.** Consent acceptance is enforced in Signals/aggregator code, recorded in their Postgres. Some consent flows need an OTP — an ordinary urgent send. Some consent failures need an SMS or email — an ordinary send. In neither case does NS need to know what consent *is*.

**The caller owns the audience.** For bulk especially, the producer applied consent and opt-out when building the recipient list. `bulk_job.audience_basis` records the caller's assertion so a DPDP audit can answer "why was this person contacted" without NS holding consent state.

**But NS must be able to *render* consent content** — a T&C link, or the statement itself, inside the body. That is a *content* dependency, not a consent dependency:

```
  template variable
      source: 'caller'       ──► value comes from the send request
      source: 'content_ref'  ──► value RESOLVED BY NS from a key
                                          │
                                          ▼
                     ┌──────────────────────────────────────┐
                     │  CONTENT RESOLVER                    │
                     │  key + locale ──► value              │
                     │  cache: (key, locale, version)       │
                     │  keyspace: ALLOWLISTED (§4.11)       │
                     └──────────────┬───────────────────────┘
                                    │  pluggable provider
                     ┌──────────────┼──────────────┐
                     ▼              ▼              ▼
                 configmap        db            http
                 (today)        (later)        (later)

  keys:  tnc.in_force.url    tnc.in_force.text
         tnc.on_offer.url    tnc.on_offer.text
              ▲
              └── NOT "tnc.current". During an advance-notice window
                  "current" is ambiguous: a re-consent broadcast needs the
                  OFFERED version, an acceptance receipt needs the IN-FORCE
                  one. The key must say which.
```

The pluggable provider makes the eventual ConfigMap→DB move a configuration change rather than a rewrite. **Resolution failure fails the send** — a consent notice delivered with a blank T&C link is worse than one not delivered.

### 4.7 Trace & status lifecycle

Two identifiers, deliberately distinct — conflating them loses one of the two things you need:

| Identifier | Meaning | Source | Used for |
|---|---|---|---|
| `correlation_id` | **business** trace spanning a whole flow | caller-supplied or NS-generated | the query key (§6); "what happened to that message" |
| `trace_id` | **W3C observability** trace | `traceparent` header | joining OTel spans; the telemetry design's `cdata.trace_id` bridge |

Status is tracked at two levels, stamped by whichever worker touches the record:

```
  notification_event  (the request)
  ┌──────────┐   ┌──────────┐   ┌─────────────┐   ┌──────┐
  │ accepted │──►│ resolved │──►│ dispatching │──►│ sent │
  └──────────┘   └──────────┘   └─────────────┘   └──┬───┘
    door         policy+template   handed to           │
    admitted it  resolved (§4.5)   a pool (§4.3)       │
                                                       ▼
                      ┌───────────────┬────────────────┬───────────┐
                      ▼               ▼                ▼           │
                 ┌──────────┐  ┌───────────────────┐  ┌────────┐   │
                 │delivered │  │partially_delivered│  │ failed │   │
                 └──────────┘  └───────────────────┘  └────────┘   │
                                        ▲                          │
                    'all' mode fanned out to 2+ channels and       │
                    one bounced while another landed ──────────────┘

  delivery_attempt  (one per channel try)
  ┌────────┐   ┌──────┐   ┌──────────────────────┐
  │ queued │──►│ sent │──►│ accepted_by_provider │
  └────────┘   └──────┘   └──────────┬───────────┘
                                     │  ◄── async receipt arrives (§4.8)
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
              ┌──────────┐     ┌─────────┐      ┌────────┐
              │delivered │     │ bounced │      │ failed │
              └──────────┘     └─────────┘      └────────┘
                    └──────────── rolls up to the event ───────────►
```

One lifecycle covers urgent, queued, and bulk sends — there is no separate mechanism for bulk. Both identifiers carry into the Kafka envelope (§4.13), so the trace survives the move onto the bus.

### 4.8 Delivery receipts

Receipts are provider **callbacks**, so they are already out-of-band from how the send was requested. Bulk and urgent therefore converge on identical handling — the question "do we get receipts for queued and bulk sends?" answers itself.

```
  send (any door, any priority)
        │
        ▼
  delivery_attempt { provider_message_id: 'abc123' }
        │
        │   ...minutes or hours pass...
        │
        ▼
  ┌─────────────────────────────────────────────────────────┐
  │  POST /v1/webhooks/:provider     ◄── SES/SNS bounce      │
  │                                  ◄── MSG91 DLR           │
  │  SIGNATURE VERIFIED (§4.11)      ◄── Twilio status       │
  │  own LOW-PRIORITY lane — highest-volume inbound traffic  │
  │  in the system; must never contend with sends            │
  └────────────────────────┬────────────────────────────────┘
                           ▼
             match on provider_message_id
             (unmatched ⇒ dropped and counted, NEVER created)
                           ▼
              delivery_receipt ──► updates attempt ──► rolls up to event

  BULK REPORTING — two completions, not one:

    t0 ──────────── t1 ─────────────────────────────► t2
    submit          submitted_at                      delivered_at
                    all sends accepted                all receipts in
                    │                                 │
                    └── the report MUST NOT claim ────┘
                        success here                  (hours later)
```

Channels with no receipt capability — notably `http_callout`, the voice-bot trigger, which is an **outbound POST and not a hosted webhook** — declare `receipts: none` and terminate at `accepted`. Audit must treat "accepted, no receipt available" as a normal outcome, not a gap.

### 4.9 Retention & PII lifecycle

Storing every attempt forever is not viable, and it is a **compliance** problem before it is a cost problem: recipient phone and email are personal data subject to DPDP erasure.

```
  ┌─ TIER 1 ── operational detail ──────────────────────────────────────┐
  │  recipient · variables · provider response                          │
  │  Postgres, MONTHLY RANGE PARTITIONS on created_at                   │
  │  ──► dropped BY PARTITION at 90 days (no DELETE ⇒ no vacuum churn)  │
  │                                                                     │
  │   [2026-06] [2026-07] [2026-08] [2026-09] ...                       │
  │      DROP      DROP      live      live                             │
  └─────────────────────────────────────────────────────────────────────┘
                              │  rolled up before expiry
                              ▼
  ┌─ TIER 2 ── aggregate counters ──────────────────────────────────────┐
  │  network × template_key × channel × day → sent/delivered/           │
  │  bounced/failed.  Tiny. PERMANENT. Holds NO personal data — which   │
  │  is precisely why it never needs to be erased.                      │
  └─────────────────────────────────────────────────────────────────────┘

  ┌─ TIER 3 ── long-term event log ─────────────────────────────────────┐
  │  Kafka tiered storage — STAGE 3 ONLY.                               │
  │  ⚠ Before Stage 3, 90 days IS the audit horizon. Stated plainly     │
  │    rather than implying a durability we do not yet have.            │
  └─────────────────────────────────────────────────────────────────────┘
```

> **Note (partitioning is not deferrable):** Tier-1 tables are partitioned **from day one** (§4.18, Stage 1 item 1). Retrofitting partitioning onto a populated, actively-written table is a rewrite, not a migration.

Two hard content rules, both enforced through the §4.4 variable contract rather than a parallel mechanism:

- **OTP codes are never persisted** — not in `variables`, not in a rendered body.
- Variables marked `sensitive: true` are **redacted at write time**, and redaction reaches **logs and queue payloads**, not only database rows (§4.11).

### 4.10 Tenancy & auth

NS targets **Keycloak `client_credentials` + JWKS**, following the shared-realm service-auth pattern from aggregator #570. `network` comes from a **verified claim, never client input** — this is what makes a shared multi-tenant deployment safe despite the network's otherwise unauthenticated inter-instance posture.

```
  ┌──────────────────────────────────────────────────────────────┐
  │  PLUGGABLE AUTH BOUNDARY                                     │
  │                                                              │
  │   HMAC verifier  ──┐                                         │
  │   (existing,       ├──► principal { network, scopes }        │
  │    + body digest)  │         │                               │
  │   Keycloak/JWKS ───┘         │                               │
  │   (target)                   ▼                               │
  │                    every downstream resolution is            │
  │                    scoped by `network` (§4.5, §4.11)         │
  └──────────────────────────────────────────────────────────────┘

  scopes:   send:*        may send for its network
            admin:template   may edit templates   ◄── SEPARATE from send.
            admin:policy     may edit routing         Template edit has a
                                                      compliance blast radius.
```

**Sequencing risk, handled by design.** `epic/keycloak-iam` has not reached `feature`, and merge-back is gated on an unresolved realm-topology question. NS therefore ships with **HMAC working and Keycloak switched on by configuration**, so it is not blocked. Existing `/notify` callers keep HMAC through a **dual-accept window** that closes with the Signals cutover (§4.18, Stage 2.5).

**Who may administer templates is deliberately unresolved here.** The right answer is a **network-admin** role, which does not exist in Keycloak today, and which collides with the same realm-topology fork. It is filed as a *sibling* spec (signals-dpg #499), not absorbed into this epic. Interim: an admin-scoped, network-bound credential.

### 4.11 Security posture

> Requirements below derive from the Phase-B security audit of this service (#15). Candidate findings and their detail are held in a **private** advisory; the repo is public, so these are stated as design requirements rather than as findings. They are **acceptance criteria** for the stage items they sit under, not follow-up work.

A notification service is an unusually attractive target: it reaches every participant in the network, and it renders attacker-influenceable content into messages those participants trust. The redesign both closes exposure and **creates new surface**; both halves need stating.

```
  ┌─ TRUST BOUNDARIES ──────────────────────────────────────────────────┐
  │                                                                     │
  │  callers ──[auth §4.10]──► SEND API      ─┐                         │
  │                                           │                         │
  │  admins  ──[admin scope]─► ADMIN API     ─┼──► NS core              │
  │                            (template edit │                         │
  │                             = compliance  │                         │
  │                             blast radius) │                         │
  │                                           │                         │
  │  PROVIDERS ─[signature IS the authz]────► WEBHOOKS ─┘               │
  │             unverified ⇒ anyone rewrites delivery history           │
  │                                                                     │
  │  content refs ──[ALLOWLIST]──► resolver   (§4.6)                    │
  │             unconstrained ⇒ arbitrary-config-read, rendered into    │
  │             a message the recipient trusts                          │
  └─────────────────────────────────────────────────────────────────────┘
```

**What the redesign closes.** Activating the rate limiter (§4.3) is a security control before it is a performance feature — enforced on *every* send path including retry and replay, and keyed per network so one tenant cannot consume another's headroom. Retiring the WhatsApp `other` passthrough removes a caller's ability to put arbitrary approved content in front of a recipient. Moving durable job state into Postgres narrows how much behaviour anything holding the cache can influence.

**What the redesign adds, and must ship already defended.**

- **Template rendering.** In `owned` mode NS renders HTML from variables, so interpolated values are **HTML-escaped by default**; raw is an explicit, reviewable per-variable decision. URL-typed variables are scheme-checked and, where the value should be ours, allowlisted — link injection into a delivered message is a phishing primitive.
- **The content resolver.** `content_ref` keys resolve against an **allowlist** (§4.6).
- **The admin API.** Admin scopes are separate from send scopes (§4.10).
- **Receipt webhooks.** The provider is the caller, so **the signature is the authorization** (§4.8). This is *new* surface rather than something #15 already covers — NS has no inbound webhooks today, so these endpoints did not exist to be tested.
- **The bulk door.** An authenticated mass-send endpoint is the highest-value target in the system.

**Cross-cutting requirements.**

- **Request integrity must cover the request body.** For as long as HMAC is accepted, the signed canonical string includes a **digest of the body**. Signing only method, path, timestamp, and nonce authenticates the *request* while leaving the *contents of the send* unauthenticated. This must land **with** the dual-accept window (§4.10), not after it. Bearer auth does not inherit the property either — a token proves who is calling, not what they asked for — so scope must bound which networks a credential may send for.
- **Tenancy is enforced at resolution, not just at the edge.** The template and policy a send resolves to must belong to the claim's network. Cross-tenant resolution is a tenancy break, not a lookup bug.
- **Recipients are validated per channel** — RFC-shaped addresses for email, E.164 for phone. Loose recipient typing lets one channel's payload be smuggled into another's. **Sender identity is server-side configuration** bound to the credential's network, never caller-supplied.
- **Redaction reaches everywhere a value comes to rest** — logs and queue payloads, not only database rows. OTP codes and activation URLs never appear in logs **at any level**, including debug and any mail-tracing mode; a verbose flag must not turn a log stream into a credential feed.
- **The cache is authenticated** (no empty-password default, internal network only), retry accounting survives DLQ replay, and a provider exception is contained at the worker-pool boundary so a crash loop in one pool cannot deny the others.

### 4.12 Event backbone: Apache Kafka (KRaft)

The backbone is **Apache Kafka in KRaft mode** (no ZooKeeper), self-hosted via the **Strimzi** operator. *Why a log and not a queue:* audit, replay, and reproduce demand that a message remain readable after consumption and that a consumer be able to re-read from any past offset or timestamp. A queue deletes on ack and cannot reproduce. *Why Kafka specifically*, over the lighter Redpanda and NATS JetStream:

- **License (decisive).** Kafka is Apache-2.0 with *everything* open, including **tiered storage** (KIP-405) — exactly the cheap long-retention substrate Tier 3 (§4.9) wants. Redpanda gates tiered storage behind a paid BSL tier, which fails the DPG rule (§4.16, P9).
- **Producer outbox without dual-write.** Producers are Postgres-backed, so **Debezium** (Apache-2.0) reads a transactional outbox table via CDC and publishes to Kafka; a producer never has to atomically write its database *and* the log. NATS has no comparable mature CDC path.
- **Escape hatch.** AWS **MSK** is managed Apache Kafka — a connection-string change, no code change, and it keeps the DPG rule (our code stays open; MSK is only hosting).

**Topics & partitioning (provisional):** topic-per-event-family, partition key = recipient or tenant key so a given recipient's messages stay ordered and a tenant cannot starve others. Hot retention on local disk plus tiered storage for the long audit tail. Fixed in the Stage 3 spec against measured volumes, not here.

### 4.13 Event envelope & contracts

**One harmonized envelope, adopted from the telemetry design rather than invented here** — the Sunbird-v3-aligned envelope (`pdata` / `cdata` / `rollup` = network→domain→instance→org), carrying the event-platform fields `id`, `type`, `version`, `source`, `network`, `subject`, `correlation_id`, `causation_id`, `idempotency_key`, `occurred_at`, `payload`.

> **Note (why this is not a free choice):** the telemetry platform and this one instrument the **same producers**. Two envelopes would mean instrumenting Signals and aggregator twice, or maintaining a translation layer permanently. Telemetry later adds its `telemetry.*` streams and insight consumer on this same contract; `cdata.trace_id` is the bridge to §4.7's `trace_id`.

**Registry: Apicurio** (Apache-2.0), not Confluent Schema Registry (restricted licence — §4.16).

### 4.14 Consumer/worker SDK & runtime

The shared runtime every producer and consumer depends on: at-least-once delivery with **idempotency** (dedup on `id` / `idempotency_key`), retry with backoff → **DLQ**, **rate limiting** per tenant × channel × provider, and **trace propagation** (`correlation_id`, `causation_id`, `trace_id`).

> **Hard boundary — the reason this is a separate concern:** the runtime retries **delivery**, never the **business operation**. A consumer that triggers external work owns that work's idempotency and compensation. This is what stops the notification consumer from quietly becoming an orchestrator (§4.15).

### 4.15 Cross-service reactions: choreography, not orchestration

A service emits a domain event; interested services react; when async work finishes, the **owning** service emits a completion event that NS turns into the response-handover notification. No central coordinator. If a genuine multi-step saga with compensation appears, we adopt **Temporal** as a separate consumer — never folded into NS.

### 4.16 Open bill of materials & DPG compliance

Every component must be OSI-open and free, with nothing gated. The common defaults all fail this, which is why each pin is deliberate:

| Component | Chosen | Rejected | Reason |
|---|---|---|---|
| Log | Apache Kafka (KRaft) | Redpanda | BSL; tiered storage is paid-tier |
| Operator | Strimzi | — | Apache-2.0 |
| Registry | Apicurio | Confluent SR | restricted licence |
| CDC | Debezium | — | Apache-2.0 |
| Cache | Valkey | Redis ≥ 7.4 | RSALv2 / SSPL |

### 4.17 Repo split

- **One new repo** (platform) — event envelope/contracts + consumer SDK + open-BOM conventions. Separate from any single consumer because *every* service depends on it. Working name **Event Fabric** / `bluedots-eventbus`.
- **Reused** — `notification-service`, extended into the notification authority and later the first consumer.
- **Operated infra** — the Kafka/Strimzi/Apicurio/Debezium stack is deployment config in `bluedots-automation`, not a repo.

> **Note (provisional):** the platform repo does not exist yet. Stage 3 items 15–16 are filed against notification-service and move when it is created.

### 4.18 Stage plan & issue map

Ordering is deliberately **not** backbone-first. Stages 1–2 deliver a working notification authority with **zero Kafka**, so the template and audit models are validated by a real second consumer before infrastructure is committed to.

```
  STAGE 1 — NS becomes the notification authority          [no Kafka]
  ┌──────────────────────────────────────────────────────────────┐
  │ #56 persistence ◄── automation#114 Postgres                  │
  │   │                                                          │
  │   ├──► #57 templates ──┐                                     │
  │   ├──► #58 policy ─────┼──► #60 send API ──► #61 priority    │
  │   └──► #59 content ────┘                        isolation    │
  │                                                              │
  │        #62 Keycloak auth + admin scopes (parallel)           │
  └───────────────────────────┬──────────────────────────────────┘
                              ▼
  STAGE 2 — aggregator migrates                            [no Kafka]
  ┌──────────────────────────────────────────────────────────────┐
  │ aggr#596 port templates + swap call sites                    │
  │        └──► aggr#597 retire the mailer                       │
  └───────────────────────────┬──────────────────────────────────┘
                              │  ◄── validates the model with a REAL consumer
                              ▼      before any infra is bought
  STAGE 2.5 — NS tranche 2                    (overlaps Stage 2)
  ┌──────────────────────────────────────────────────────────────┐
  │ #63 receipts ──► #64 audit query    #65 retention & rollups  │
  │ signals#496 cut over to template_key; retire basic_email     │
  └───────────────────────────┬──────────────────────────────────┘
                              ▼
  STAGE 3 — event bus + consumer SDK              [Kafka arrives]
  ┌──────────────────────────────────────────────────────────────┐
  │ #66 envelope ──┐                                             │
  │ #67 SDK ───────┼──► #68 bulk door (NS as first consumer)     │
  │ automation#115 ┘                                             │
  └───────────────────────────┬──────────────────────────────────┘
                              ▼
  STAGE 4 — producers emit events
  ┌──────────────────────────────────────────────────────────────┐
  │ signals#497 outbox + Debezium                                │
  │        └──► signals#498 non-urgent → events                  │
  │             aggr#598 emit events                             │
  │                                                              │
  │  ⚠ OTP stays on the direct API. Permanently. (§4.2)          │
  └───────────────────────────┬──────────────────────────────────┘
                              ▼
  STAGE 5 — orchestration (CONDITIONAL — likely never built)
        only if a real saga appears; Temporal as a separate consumer
```

Umbrella: notification-service **#14**, with all 21 items linked as sub-issues. Sibling (**not** a child): signals-dpg **#499**, network-admin role (§4.10).

### 4.19 Open questions / provisional premises

- **Topic taxonomy and partition strategy** — fixed in the Stage 3 spec against measured volumes.
- **Whether a 90-day Tier-1 audit horizon is acceptable to compliance** before tiered storage exists (§4.9). If it is not, Stage 3 moves earlier.
- **Voice-bot result handling** — `http_callout` is fire-and-record by default; whether any caller needs a synchronous result back is unconfirmed.
- **When the HMAC dual-accept window closes** — depends on `epic/keycloak-iam` reaching `feature`, which depends on the realm-topology fork (§4.10).
- **Where the network-admin role lands** — signals-dpg #499, blocked on the same fork.

---

## 5. Data Model

All columns snake_case. Tier-1 tables are **monthly `RANGE`-partitioned on `created_at`** (§4.9). *(planned — finalised per stage spec.)*

### `template`  _(§4.4)_

| Column | Type | Description |
|---|---|---|
| `id` | uuid PK | |
| `network` | text | _tenant_ |
| `channel` | text | _email / sms / whatsapp / http_callout_ |
| `template_key` | text | _stable caller-facing name_ |
| `version` | int | |
| `locale` | text | |
| `render_mode` | text | _`owned` \| `provider_ref`_ |
| `status` | text | _draft / active / retired; one `active` per (network, channel, key, locale)_ |
| `subject` | text null | _`owned` only_ |
| `body_html` | text null | _`owned` only_ |
| `body_text` | text null | _`owned` only_ |
| `provider` | text null | _`provider_ref` only_ |
| `provider_template_id` | text null | _MSG91 flow id / Twilio contentSid_ |
| `provider_approval_ref` | text null | _DLT entity+template id / Meta status_ |
| `variables` | jsonb | _`[{name, required, type, source, sensitive}]`_ |
| `created_at` | timestamptz | |

### `notification_policy`  _(§4.5)_

| Column | Type | Description |
|---|---|---|
| `id` | uuid PK | |
| `network` | text | |
| `domain` | text null | _null ⇒ network-wide default_ |
| `event_type` | text null | _null ⇒ applies to all events_ |
| `mode` | text | _`first_available` \| `all`_ |
| `channels` | jsonb | _ordered `[{channel, template_key}]`_ |
| `status` | text | |
| `created_at` | timestamptz | |

### `notification_event`  _(Tier 1, partitioned)_

| Column | Type | Description |
|---|---|---|
| `id` | uuid PK | |
| `correlation_id` | uuid | _**business trace**, the query key (§4.7)_ |
| `trace_id` | text null | _W3C, from `traceparent`_ |
| `event_id` | text null | _envelope `id`; **unique**, the dedup key (Stage 3)_ |
| `idempotency_key` | text null | |
| `event_type` | text | |
| `network` | text | _**from verified claim**_ |
| `domain` | text null | _from the caller (§4.5)_ |
| `source` | text | |
| `priority` | text | _urgent / normal / bulk_ |
| `status` | text | _§4.7 lifecycle_ |
| `payload` | jsonb | _**redacted** per variable contract (§4.9)_ |
| `received_at` | timestamptz | |

### `delivery_attempt`  _(Tier 1, partitioned)_

| Column | Type | Description |
|---|---|---|
| `id` | uuid PK | |
| `notification_event_id` | uuid FK | |
| `channel` | text | |
| `provider` | text | |
| `template_id` | uuid FK null | _the version actually sent_ |
| `attempt_no` | int | _preserved across DLQ replay (§4.11)_ |
| `status` | text | _§4.7 lifecycle_ |
| `provider_message_id` | text null | _receipt correlation key (§4.8)_ |
| `error` | text null | |
| `requested_at` | timestamptz | |
| `completed_at` | timestamptz null | |

### `delivery_receipt`  _(Tier 1, partitioned)_

| Column | Type | Description |
|---|---|---|
| `id` | uuid PK | |
| `delivery_attempt_id` | uuid FK | |
| `status` | text | _delivered / bounced / failed_ |
| `provider_status` | text | _raw provider code_ |
| `received_at` | timestamptz | |

### `bulk_job`  _(§4.8 — two completions)_

| Column | Type | Description |
|---|---|---|
| `id` | uuid PK | |
| `network` | text | |
| `requested_by` | text | |
| `audience_basis` | text | _caller's assertion of why (§4.6)_ |
| `template_key` | text | |
| `channel` | text | |
| `total` / `succeeded` / `failed` | int | |
| `status` | text | |
| `submitted_at` | timestamptz null | _all sends accepted_ |
| `delivered_at` | timestamptz null | _all receipts in — **hours later**_ |
| `created_at` | timestamptz | |

### `bulk_job_item`

| Column | Type | Description |
|---|---|---|
| `id` | uuid PK | |
| `bulk_job_id` | uuid FK | |
| `recipient` | text | |
| `status` | text | |
| `delivery_attempt_id` | uuid FK null | |

### `notification_counter`  _(Tier 2 — permanent, no personal data)_

| Column | Type | Description |
|---|---|---|
| `network` | text | |
| `template_key` | text | |
| `channel` | text | |
| `day` | date | |
| `sent` / `delivered` / `bounced` / `failed` | int | |

---

## 6. API Spec

The **event door is not REST** — producers emit envelopes (§4.13) via the SDK / outbox. The REST surface is the transactional door, audit, admin, and operational endpoints. *(planned — finalised per stage.)*

### Send

#### `POST /v1/notify`  _(transactional door, §4.2)_

```jsonc
{
  "event_type":   "action.approved",   // OR "template_key" — exactly one
  "domain":       "seeker",            // optional; from the CALLER (§4.5)
  "to":           { "email": "user@example.com", "phone": "+919876543210" },
  "locale":       "en",
  "variables":    { },                 // validated against the variable contract
  "priority":     "urgent",            // urgent | normal | bulk  (§4.3)
  "idempotency_key": "string",
  "correlation_id":  "uuid"            // optional; generated if absent (§4.7)
}
```

Responses: `202 { notification_event_id, correlation_id, accepted }`, `4xx { error, message }`.

Validation:
- Auth: Bearer (Keycloak) or HMAC **with body digest** (§4.10, §4.11); `network` **from the claim**, never the body.
- Exactly one of `event_type` (resolved through policy, §4.5) or `template_key` (names content directly).
- The resolved template and policy must belong to the claim's network (§4.11).
- Recipients validated **per channel** — RFC-shaped email, E.164 phone (§4.11).
- Re-send with the same `idempotency_key` returns the original result and does not re-send.

#### `POST /v1/bulk`  _(→ event door; Stage 3)_
`{ template_key | event_type, channel, locale, audience_basis, recipients[], variables }` → `202 { bulk_job_id }`.

#### `GET /v1/bulk/:id`  _(Stage 3)_
The bulk snapshot, with `submitted_at` and `delivered_at` **distinct** (§4.8).

### Audit

#### `GET /v1/notifications/:id` · `GET /v1/notifications?correlation_id=…`
The full tree — event → attempts → receipts (§4.7). Redacted fields stay redacted in responses.

### Admin  _(admin scope; network-admin role when it exists, §4.10)_

#### `GET|POST|PATCH /v1/admin/templates` · `POST /v1/admin/templates/:id/publish|retire|preview`
#### `GET|POST|PATCH /v1/admin/policies` · `POST /v1/admin/policies/:id/publish|retire`

### Operational

#### `POST /v1/webhooks/:provider` — signature-verified receipt ingestion (§4.8, §4.11).
#### `POST /v1/failed/retry` — DLQ replay; rate-limited like any other send path (§4.11).
#### `GET /v1/metrics/queue` — depths + consumer lag.
#### `GET /providers` · `GET /providers/:name` — channel metadata (existing).

---

## 7. Summary

notification-service becomes the **notification authority for the network** first, and the first consumer of an event backbone second — in that order, deliberately.

The organising correction is that **the bus is not the universal transport**. Consumer-owned APIs are the default synchronous contract; the log is for durable fan-out and decoupled reaction; **OTP never rides the bus**. And because bypassing the bus does not by itself isolate the urgent path, isolation is treated as a **resource** problem: per-priority worker pools, a **split provider token bucket** with reserved urgent quota, and fire-and-forget audit writes on the urgent path.

Content and routing are separated into **templates** (one entity, two render modes — honest that DLT-registered SMS and Meta-approved WhatsApp bodies live at the provider) and **routing policy** (`network` × `domain` × `event_type` → ordered channels, `first_available` or `all`, most-specific-wins), with capability filtering that keeps NS free of any user directory. NS **enforces no consent** — it only renders consent content through an allowlisted content resolver — which takes consent-service and Keycloak off this epic's critical path. A **`correlation_id` / `trace_id`** pair plus a two-level status lifecycle makes a message traceable from origination to closure, including asynchronous receipts, for which a bulk job has **two completions**, not one. Retention is **tiered and partition-dropped**, because recipient data is erasable personal data, not just rows.

The backbone remains **Apache Kafka (KRaft)** — chosen on the DPG open-licence rule and on open tiered storage plus Debezium CDC — carrying **one harmonized envelope** shared with the telemetry platform so producers are instrumented once. Cross-service reactions are **choreography**; orchestration is bought or never built. The bill of materials is OSI-open throughout.

Net effect: a single notification authority with governed templates, explainable routing, an end-to-end trace, a bounded and erasable audit store, and an urgent path that a mass broadcast cannot starve — delivered in a sequence where the first two stages need **no new infrastructure at all**, and where a real second consumer validates the model before any cluster is operated. Security requirements from the Phase-B audit are acceptance criteria on the stage items rather than follow-up work (§4.11). Open items are tracked in §4.19.
