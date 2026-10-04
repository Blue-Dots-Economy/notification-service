# NS Stage 1 · Plan C2 — Send API v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `POST /v1/notify`: callers name an `event_type` (routed by policy) or a `template_key`, pass the contact points they hold and the variables; NS validates and renders against the registered templates before accepting, records the send, and the worker delivers pre-rendered content through the deployment's vendor — falling through to the next channel when one fails.

**Architecture:** A pure request schema, a planner (`planSend`) that turns a request into an ordered list of fully-rendered deliveries using Plan B's `resolvePolicy` / `planDelivery` / `resolveTemplate` / `renderTemplate`, an idempotency store, and a thin route. Jobs carry the rendered deliveries (`Job.v1`); providers gain `sendRendered`, so nothing is re-rendered in the worker. `first_available` is one job whose deliveries are tried in order (each try a new attempt row); `all` is one job per delivery under one event, whose status rolls up across attempts. Legacy `/notify` stays untouched until the cutover release (Plan F) removes it.

**Tech Stack:** TypeScript 7 (CommonJS), Fastify 5, Zod 4, drizzle-orm 0.45, PostgreSQL 17, ioredis 6, vitest 4.

**Spec:** `docs/superpowers/specs/2026-06-26-event-platform-design.md` (rev 2026-10-04) — §API sketch (Send), §Templates and routing (capability filter, fallback clocks), §Trace and status lifecycle, §Retention and PII, §Security. Issue: Blue-Dots-Economy/notification-service#60. Plan B ledger "Plan C notes" are folded in below.

**Branch:** `notification-service` `feat/ns-send-api-v1`, cut from `feat/ns-priority-isolation` (Plan C1). Stacked; rebase onto `feature` as the lower PRs merge.

## Global Constraints

- Plans A, B, C1 Global Constraints and rulings still apply (CommonJS, `describeDbError`, never log or persist variable values for redacted sends, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, public-repo wording).
- **Public priorities** `urgent | normal | bulk` (default `normal`) map to internal `realtime | other | bulk` via `PRIORITY_MAP`.
- **`network` is never read from the request** (strict schema rejects it); it is `currentNetwork()`; unset → `503 {"error":"network_not_configured"}` on `/v1/notify` only — legacy `/notify` is unaffected.
- **Exactly one of `event_type` (policy-routed) or `template_key`**. `template_key` requires `channel`; `event_type` forbids it.
- **Recipients**: `to.email` (Zod email, ≤254) and/or `to.phone` (E.164, `^\+[1-9]\d{6,14}$`); at least one.
- **Not accepted** (strict schema → 400): free-text bodies, raw vendor ids, `from`/`fromName`/`fromEmail`, `network`, unknown keys.
- **Email extras** `cc` (≤10 emails), `reply_to`, `attachments` (the existing attachment schema and limits): with `template_key` they require `channel: 'email'` (else 400); with `event_type` they apply to email deliveries only.
- **Sender identity is server config**: `EMAIL_FROM_ADDRESS` (required to send v1 email) and `EMAIL_FROM_NAME`; missing → the email delivery fails permanently with `email sender not configured`.
- **Variables**: the request's variables are validated against the **union** of the planned templates' contracts — a name declared by none is `unknown_variable`; each template renders with only its own declared variables.
- **Error kinds**: `missing_variable`, `unknown_variable`, `invalid_variable`, `no_reachable_channel` are **caller** errors; `not_found`, `vendor_mismatch`, `incomplete_template`, `body_too_long`, `unknown_channel`, `no_policy` are **configuration** errors. Both answer `422 {"error": code, "kind": "caller"|"configuration", "message", "details"?}` and count `ns_send_rejected_total{kind,code}`.
- **Fallthrough (`first_available`) is synchronous only**: a candidate whose template fails to resolve at accept time is skipped (counted as a configuration rejection); at send time a permanent failure or exhausted retries moves to the next delivery as a **new attempt row**. Async bounces are out of scope (Stage 2.5/3).
- **Redaction**: a send is redacted (`audit.redactValues = true`: names only, no job copy, not recoverable, never dead-lettered) if its priority is `urgent` **or** any planned template declares a `sensitive` variable.
- **Deadline**: request `deadline` (ISO-8601 with offset; must be in the future and ≤ 24 h ahead, else 400) → else the smallest `default_deadline_s` among planned templates → else, for `urgent`, `URGENT_DEFAULT_DEADLINE_S`.
- **Idempotency**: `idempotency_key` (1–128 chars). `normal`/`bulk`: Postgres table `idempotency_key` `(network, key)` kept 90 days. `urgent`: Redis `idem:<network>:<key>` with a 15-minute TTL (no Postgres round trip before an OTP). A repeat returns `200` with the original response; a repeat while the first is still in flight → `409 {"error":"idempotency_in_progress"}`. Without a key, a 5-second content guard answers a repeat with `409 {"error":"duplicate-fallback"}`. Any refusal after a claim releases it.
- **Response**: `202 {"notification_event_id", "correlation_id", "status":"accepted", "mode", "deliveries":[{"channel"}]}`.
- Event `delivery_mode`: `single` (template_key), `first_available`, `all`. `all` events roll their status up across attempts (`partially_delivered` when mixed); others mirror the current attempt.

## Review Focus

- **A policy routes SMS then email and the caller sends only the SMS template's variables** → accepted; email renders with its own subset; a name declared by neither template is rejected (Task 4, test `variables are checked against the union of planned contracts`).
- **The first channel's vendor rejects permanently** → the next delivery is attempted immediately as a new attempt row; the event ends `sent` if the second succeeds (Task 7, test `first_available falls through on permanent failure`).
- **Two identical requests with the same `idempotency_key` arrive together** → one is accepted, the other gets `409 idempotency_in_progress` or the original `200`; never two sends (Task 5, test `concurrent claims: exactly one fresh`).
- **An urgent OTP with Postgres down** → accepted and queued (queue-first; idempotency in Redis), never `503` (Task 6, test `urgent is accepted when the audit store is down`).
- **A rendered OTP body contains `{{x}}` from a variable value** → delivered as-is; the worker never re-renders (Task 2, test `pinnacle sendRendered sends the text verbatim`).

---

### Task 1: Audit model for multi-delivery events and the idempotency table

**Files:**
- Create (custom migration): `drizzle/0002_event_delivery_mode.sql` via `pnpm db:generate --custom --name=event_delivery_mode`
- Modify: `src/lib/db/partitioned.ts`, `src/lib/db/schema.ts` (idempotency table) + generated `drizzle/0003_idempotency_key.sql`, `src/lib/audit/store.ts`, `src/lib/audit/redact.ts`
- Test: `src/lib/audit/__tests__/rollup.integration.test.ts`

**Interfaces:**
- Produces:
  - `type DeliveryMode = 'single' | 'first_available' | 'all'`; `AuditIds.deliveryMode?: DeliveryMode` (absent = `single`)
  - `notification_event.delivery_mode text NOT NULL DEFAULT 'single'`
  - table `idempotency_key (network text, key text, response jsonb NULL, created_at timestamptz default now(), PRIMARY KEY (network, key))`; drizzle `idempotencyKey`
  - `recordAcceptedMany(records: AcceptedRecord[]): Promise<void>` — one event row (from `records[0]`) + one attempt row per record, one transaction, `ON CONFLICT DO NOTHING`
  - `upsertAttempt` event update: `all` → roll up over every attempt of the event; otherwise unchanged (mirror the written attempt)

Roll-up for `all` (success = `sent|accepted_by_provider|delivered`; failure = `failed|bounced|expired`): any attempt open (`queued|dispatching`) → `dispatching` if any attempt is `dispatching` or successful, else `accepted`; all closed → all successful: `delivered` if all `delivered` else `sent`; all failed: `expired` if all `expired` else `failed`; otherwise `partially_delivered`.

- [ ] **Step 1: Write the failing integration test**

`src/lib/audit/__tests__/rollup.integration.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getPool } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { recordAcceptedMany, upsertAttempt, type AcceptedRecord } from '../store';

beforeAll(async () => { await runMigrations(); });
afterAll(async () => { await closeDb(); });
beforeEach(async () => { await getPool().query(`DELETE FROM delivery_attempt; DELETE FROM notification_event;`); });

function records(n: number, mode: 'all' | 'first_available'): AcceptedRecord[] {
  const eventId = randomUUID();
  const createdAt = new Date().toISOString();
  return Array.from({ length: n }, (_, i) => ({
    ids: { eventId, attemptId: randomUUID(), createdAt, correlationId: 'c', deliveryMode: mode },
    network: 'n', source: 's', priority: 'other', channel: i === 0 ? 'sms' : 'email',
    templateId: 't', payload: {}, recoverable: true, job: { job_id: `j${i}` },
  }));
}
async function eventStatus(r: AcceptedRecord) {
  const { rows } = await getPool().query(`SELECT status, delivery_mode FROM notification_event WHERE id = $1`, [r.ids.eventId]);
  return rows[0];
}

describe('multi-delivery events', () => {
  it('records one event and one attempt per delivery', async () => {
    const rs = records(2, 'all');
    await recordAcceptedMany(rs);
    const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM delivery_attempt WHERE notification_event_id = $1`, [rs[0]!.ids.eventId]);
    expect(rows[0].n).toBe(2);
    expect(await eventStatus(rs[0]!)).toEqual({ status: 'accepted', delivery_mode: 'all' });
  });

  it('all: mixed outcomes roll up to partially_delivered', async () => {
    const rs = records(2, 'all');
    await recordAcceptedMany(rs);
    await upsertAttempt(rs[0]!, { status: 'sent', attemptNo: 1 });
    expect((await eventStatus(rs[0]!)).status).toBe('dispatching');
    await upsertAttempt(rs[1]!, { status: 'failed', attemptNo: 1, error: 'x' });
    expect((await eventStatus(rs[0]!)).status).toBe('partially_delivered');
  });

  it('all: every delivery sent → sent; every one failed → failed', async () => {
    const ok = records(2, 'all');
    await recordAcceptedMany(ok);
    for (const r of ok) await upsertAttempt(r, { status: 'sent', attemptNo: 1 });
    expect((await eventStatus(ok[0]!)).status).toBe('sent');
    const bad = records(2, 'all');
    await recordAcceptedMany(bad);
    for (const r of bad) await upsertAttempt(r, { status: 'failed', attemptNo: 1 });
    expect((await eventStatus(bad[0]!)).status).toBe('failed');
  });

  it('first_available mirrors the current attempt', async () => {
    const [a, b] = records(2, 'first_available');
    await recordAcceptedMany([a!]);
    await upsertAttempt(a!, { status: 'failed', attemptNo: 1 });
    await upsertAttempt(b!, { status: 'sent', attemptNo: 1 });
    expect((await eventStatus(a!)).status).toBe('sent');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run the integration command (Postgres 55432 / Redis 56379 as in earlier plans).
Expected: FAIL — `recordAcceptedMany` not exported / `delivery_mode` missing.

- [ ] **Step 3: Migrations**

Run `pnpm db:generate --custom --name=event_delivery_mode` (with the `DATABASE_*` env) and write:

```sql
-- Delivery mode of a send: 'single' (template_key), 'first_available' (try channels
-- in order), 'all' (fan out). Decides how the event's status is derived from its
-- attempts. Added on the partitioned parent; pg_partman children inherit it.
ALTER TABLE notification_event ADD COLUMN delivery_mode text NOT NULL DEFAULT 'single';
--> statement-breakpoint
ALTER TABLE notification_event ADD CONSTRAINT notification_event_delivery_mode_ck
  CHECK (delivery_mode IN ('single', 'first_available', 'all'));
```

Add `deliveryMode: text('delivery_mode').$type<DeliveryMode>().notNull().default('single')` to `notificationEvent` in `partitioned.ts` (export `DeliveryMode`).

In `schema.ts` add:

```ts
/** Send idempotency for normal/bulk priority (urgent uses Redis). Kept 90 days. */
export const idempotencyKey = pgTable(
  'idempotency_key',
  {
    network: text('network').notNull(),
    key: text('key').notNull(),
    response: jsonb('response'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.network, t.key] })],
);
```

(import `primaryKey`), then `pnpm db:generate --name=idempotency_key`; inspect, never hand-edit.

- [ ] **Step 4: Store changes**

In `store.ts`: add `deliveryMode?: DeliveryMode` to `AuditIds`; `insertEvent` writes `delivery_mode = ${rec.ids.deliveryMode ?? 'single'}`. Add:

```ts
/** One event, one attempt per delivery, atomically. Replay-safe. */
export async function recordAcceptedMany(records: AcceptedRecord[]): Promise<void> {
  if (records.length === 0) return;
  await getDb().transaction(async (tx) => {
    await tx.execute(insertEvent(records[0]!, 'accepted'));
    for (const rec of records) await tx.execute(insertAttempt(rec));
  });
}
```

(extract the attempt INSERT from `recordAccepted` into `insertAttempt(rec)` and reuse it there.)

Replace the event `UPDATE` at the end of `upsertAttempt` with: if `rec.ids.deliveryMode === 'all'`, run

```sql
UPDATE notification_event e SET status = r.status, updated_at = now()
FROM (
  SELECT CASE
    WHEN bool_or(a.status IN ('queued','dispatching')) THEN
      CASE WHEN bool_or(a.status = 'dispatching' OR a.status IN ('sent','accepted_by_provider','delivered'))
           THEN 'dispatching' ELSE 'accepted' END
    WHEN bool_and(a.status IN ('sent','accepted_by_provider','delivered')) THEN
      CASE WHEN bool_and(a.status = 'delivered') THEN 'delivered' ELSE 'sent' END
    WHEN bool_and(a.status IN ('failed','bounced','expired')) THEN
      CASE WHEN bool_and(a.status = 'expired') THEN 'expired' ELSE 'failed' END
    ELSE 'partially_delivered'
  END AS status
  FROM delivery_attempt a
  WHERE a.notification_event_id = ${eventId} AND a.created_at = ${createdAt}
) r
WHERE e.id = ${eventId} AND e.created_at = ${createdAt}
```

otherwise keep the existing mirror update. (Attempts of one event share the event's `createdAt`, so the partition is pinned.)

In `redact.ts`, keep `toAcceptedRecord` as is (it copies `job.audit`, so `deliveryMode` flows through).

- [ ] **Step 5: Run and commit**

Run: `pnpm build && pnpm test` and the integration command.
Expected: PASS; `drizzle-kit generate` afterwards reports no changes.

```bash
git add drizzle src/lib/db src/lib/audit
git commit -m "feat(audit): multi-delivery events with status roll-up; idempotency table

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Providers send pre-rendered content

**Files:**
- Modify: `src/types/provider.ts`, `src/lib/providers/email/mailer.ts`, `src/lib/providers/email/sendMailCore.ts`, `src/lib/providers/sms/pinnacle.ts`, `src/lib/providers/sms/msg91.ts`, `src/lib/providers/whatsapp/twilio.ts`
- Test: `src/lib/providers/__tests__/send-rendered.test.ts`

**Interfaces:**
- Consumes: `Rendered` (Plan B `src/lib/templates/render.ts`).
- Produces:
  - `interface RenderedSendArgs { to: string; rendered: Rendered; providerTemplateId: string | null; dlt?: { senderId?: string | null; dltEntityId?: string | null; dltHeaderId?: string | null; dltTagId?: string | null }; email?: { cc?: string[]; replyTo?: string; attachments?: Email_attachment[] }; job_id?: string }`
  - `ProviderDefinition.sendRendered?(args: RenderedSendArgs): Promise<ProviderSendResult>` — implemented by all four definitions
  - `EmailAttachmentSchema` exported from `mailer.ts`
  - `sendPinnacleText(to, dltTemplateId, text, overrides, job_id, env?)` — the post-render half of `sendSmsWithPinnacle`, which now calls it

Rules: a `rendered.mode` / channel the provider cannot send (e.g. `provider` mode to email, `ns` mode to MSG91) → `{ ok:false, retryable:false, error:'rendered mode not supported by <vendor>' }`. Email: `from` = `EMAIL_FROM_NAME <EMAIL_FROM_ADDRESS>`; missing address → permanent `email sender not configured`; sends `html` and/or `text` (sendMailCore gains optional `text`; `html` becomes optional, at least one required). Pinnacle: `dlttempid = providerTemplateId`; per-template `senderId`/`dltEntityId`/`dltHeaderId`/`dltTagId` override env when set; text sent **verbatim** (no `renderBody`). MSG91: `sendSmsWithMsg91(to, providerTemplateId, rendered.variables)`. Twilio: `sendWhatsAppMessage(to, providerTemplateId, rendered.variables)`.

- [ ] **Step 1: Write the failing tests**

`src/lib/providers/__tests__/send-rendered.test.ts` (mock `fetch` and nodemailer the way the existing provider tests do; mock `../../metrics` per CLAUDE.md):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../metrics', () => ({ incr: vi.fn(async () => {}), setGauge: vi.fn(async () => {}) }));
const sendMail = vi.hoisted(() => vi.fn(async () => ({ messageId: 'm' })));
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail }) },
  createTransport: () => ({ sendMail }),
}));

process.env.SMTP_HOST = 'smtp.example.com';
process.env.SMTP_USER = 'u';
process.env.SMTP_PASS = 'p';
process.env.PINNACLE_API_KEY = 'k';
process.env.PINNACLE_SENDER_ID = 'ENVSND';
process.env.PINNACLE_DLT_ENTITY_ID = 'ENVENT';

const { emailProvider } = await import('../email/mailer');
const { pinnacleSmsProvider } = await import('../sms/pinnacle');
const { smsProvider: msg91Provider } = await import('../sms/msg91');

beforeEach(() => {
  sendMail.mockClear();
  process.env.EMAIL_FROM_ADDRESS = 'no-reply@blue-dots.org';
  process.env.EMAIL_FROM_NAME = 'Blue Dots';
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'success', code: '200', data: [{ uniqueid: 'u1' }] }), { status: 200 })));
});

describe('sendRendered', () => {
  it('email sends the rendered subject/html/text from the configured sender', async () => {
    const res = await emailProvider.sendRendered!({
      to: 'a@b.c', providerTemplateId: null,
      rendered: { mode: 'ns', channel: 'email', subject: 'Hi', html: '<p>x</p>', text: 'x' },
      email: { cc: ['c@d.e'], replyTo: 'r@b.c' },
    });
    expect(res.ok).toBe(true);
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'a@b.c', subject: 'Hi', html: '<p>x</p>', text: 'x', replyTo: 'r@b.c',
    }));
    expect(JSON.stringify(sendMail.mock.calls[0])).toContain('no-reply@blue-dots.org');
  });

  it('email without a configured sender fails permanently', async () => {
    delete process.env.EMAIL_FROM_ADDRESS;
    const res = await emailProvider.sendRendered!({
      to: 'a@b.c', providerTemplateId: null,
      rendered: { mode: 'ns', channel: 'email', subject: 'Hi', html: '<p>x</p>', text: null },
    });
    expect(res).toMatchObject({ ok: false, retryable: false, error: 'email sender not configured' });
  });

  it('pinnacle sendRendered sends the text verbatim with per-template DLT overrides', async () => {
    const res = await pinnacleSmsProvider.sendRendered!({
      to: '+919999999999', providerTemplateId: '1107',
      rendered: { mode: 'ns', channel: 'sms', text: 'OTP 12{{message}}34', messageType: 'TXT' },
      dlt: { senderId: 'TPLSND' },
    });
    expect(res.ok).toBe(true);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.message[0].text).toBe('OTP 12{{message}}34');
    expect(body.dlttempid).toBe('1107');
    expect(body.sender).toBe('TPLSND');
    expect(body.dltentityid).toBe('ENVENT');
  });

  it('refuses a rendered mode the vendor cannot send', async () => {
    const res = await msg91Provider.sendRendered!({
      to: '+919999999999', providerTemplateId: 'f',
      rendered: { mode: 'ns', channel: 'sms', text: 'x', messageType: 'TXT' },
    });
    expect(res).toMatchObject({ ok: false, retryable: false });
  });

  it('msg91 sends flow id + variables', async () => {
    const res = await msg91Provider.sendRendered!({
      to: '+919999999999', providerTemplateId: 'flow-1',
      rendered: { mode: 'provider', channel: 'sms', providerTemplateId: 'flow-1', variables: { message: '42' } },
    });
    expect(res.ok).toBe(true);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.template_id).toBe('flow-1');
    expect(body.recipients[0]).toMatchObject({ var: '42' });
  });
});
```

(Adjust the MSG91 success response mock to what `msg91.ts` treats as success; check its existing test file.)

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/lib/providers/__tests__/send-rendered.test.ts`
Expected: FAIL — `sendRendered` undefined.

- [ ] **Step 3: Implement**

`src/types/provider.ts`: add `RenderedSendArgs` (import types `Rendered` from `../lib/templates/render` and `Email_attachment` from `../lib/providers/email/sendMailCore` with `import type`) and the optional `sendRendered` member, documented: "Send content NS already rendered and validated (Send API v1). Never re-render."

`sendMailCore.ts`: make `html` optional, add `text?: string`; pass `text` to nodemailer and to SES (`Body.Text`), and throw if neither is present.

`mailer.ts`: export `EmailAttachmentSchema`; add

```ts
  async sendRendered({ to, rendered, email, job_id }) {
    if (rendered.mode !== 'ns' || rendered.channel !== 'email') {
      return { ok: false, retryable: false, error: 'rendered mode not supported by smtp' };
    }
    const fromEmail = process.env.EMAIL_FROM_ADDRESS?.trim();
    if (!fromEmail) return { ok: false, retryable: false, error: 'email sender not configured' };
    return sendMail({
      to,
      fromEmail,
      fromName: process.env.EMAIL_FROM_NAME?.trim() || fromEmail,
      subject: rendered.subject,
      ...(rendered.html ? { html: rendered.html } : {}),
      ...(rendered.text ? { text: rendered.text } : {}),
      ...(email?.replyTo ? { replyTo: email.replyTo } : {}),
      ...(email?.cc?.length ? { cc: email.cc.join(',') } : {}),
      ...(email?.attachments?.length ? { attachments: email.attachments } : {}),
      template_id: 'v1',
      job_id,
    });
  },
```

(match `sendMail`'s real argument/return shapes; it already returns a `ProviderSendResult`-like value — adapt if not.)

`pinnacle.ts`: split `sendSmsWithPinnacle` after the `renderBody` step into `sendPinnacleText(to, dltTemplateId, text, overrides, job_id, env)` (length check, payload, fetch, response handling — moved verbatim), with `overrides` replacing `config.sender`/`dltEntityId`/`dltHeaderId`/`dltTagId` when non-null. `sendSmsWithPinnacle` calls it with no overrides. Add:

```ts
  async sendRendered({ to, rendered, providerTemplateId, dlt, job_id }) {
    if (rendered.mode !== 'ns' || rendered.channel !== 'sms' || !providerTemplateId) {
      return { ok: false, retryable: false, error: 'rendered mode not supported by pinnacle' };
    }
    return sendPinnacleText(to, providerTemplateId, rendered.text, dlt ?? {}, job_id);
  },
```

`msg91.ts`:

```ts
  async sendRendered({ to, rendered, providerTemplateId }) {
    if (rendered.mode !== 'provider' || !providerTemplateId) {
      return { ok: false, retryable: false, error: 'rendered mode not supported by msg91' };
    }
    return sendSmsWithMsg91(to, providerTemplateId, rendered.variables);
  },
```

`twilio.ts`: same shape, `sendWhatsAppMessage(to, providerTemplateId, rendered.variables)`.

- [ ] **Step 4: Run and commit**

Run: `pnpm build && pnpm test`
Expected: PASS (existing provider tests unchanged).

```bash
git add src/types/provider.ts src/lib/providers
git commit -m "feat(providers): send pre-rendered content without re-rendering

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: The v1 request schema

**Files:**
- Create: `src/lib/send/request.ts`, `src/lib/send/__tests__/request.test.ts`

**Interfaces:**
- Consumes: `EmailAttachmentSchema` (Task 2), `attachmentMaxFiles`/`attachmentMaxTotalBytes`/`totalAttachmentBytes` (existing).
- Produces:
  - `V1NotifySchema` (Zod) and `type V1Request = z.infer<typeof V1NotifySchema>`
  - `PRIORITY_MAP: Record<'urgent' | 'normal' | 'bulk', Priority>`
  - `parseDeadline(iso: string | undefined, now?: number): number | undefined` — throws `RangeError('deadline must be in the future')` / `RangeError('deadline must be within 24 hours')`

- [ ] **Step 1: Write the failing test**

`src/lib/send/__tests__/request.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseDeadline, PRIORITY_MAP, V1NotifySchema } from '../request';

const ok = { event_type: 'apply', to: { phone: '+919999999999' }, variables: { name: 'A' } };
const parse = (b: unknown) => V1NotifySchema.safeParse(b);

describe('V1NotifySchema', () => {
  it('accepts a policy-routed send and defaults priority and variables', () => {
    const r = parse({ event_type: 'apply', to: { email: 'a@b.c' } });
    expect(r.success && r.data).toMatchObject({ priority: 'normal', variables: {} });
  });
  it('requires exactly one of event_type / template_key', () => {
    expect(parse({ to: { email: 'a@b.c' } }).success).toBe(false);
    expect(parse({ ...ok, template_key: 'x', channel: 'sms' }).success).toBe(false);
  });
  it('template_key needs channel; event_type forbids it', () => {
    expect(parse({ template_key: 'login_otp', to: { phone: '+919999999999' } }).success).toBe(false);
    expect(parse({ template_key: 'login_otp', channel: 'sms', to: { phone: '+919999999999' } }).success).toBe(true);
    expect(parse({ ...ok, channel: 'sms' }).success).toBe(false);
  });
  it('validates recipients and requires at least one', () => {
    expect(parse({ ...ok, to: {} }).success).toBe(false);
    expect(parse({ ...ok, to: { phone: '9999999999' } }).success).toBe(false);
    expect(parse({ ...ok, to: { email: 'not-an-email' } }).success).toBe(false);
  });
  it('rejects network, bodies, sender identity and unknown keys', () => {
    for (const extra of [{ network: 'x' }, { body: 'hi' }, { fromEmail: 'a@b.c' }, { template_id: 'raw' }]) {
      expect(parse({ ...ok, ...extra }).success).toBe(false);
    }
  });
  it('email extras with template_key need channel email', () => {
    expect(parse({ template_key: 'k', channel: 'sms', to: { phone: '+919999999999' }, cc: ['c@d.e'] }).success).toBe(false);
    expect(parse({ template_key: 'k', channel: 'email', to: { email: 'a@b.c' }, cc: ['c@d.e'], reply_to: 'r@b.c' }).success).toBe(true);
  });
  it('maps public priorities', () => {
    expect(PRIORITY_MAP).toEqual({ urgent: 'realtime', normal: 'other', bulk: 'bulk' });
  });
});

describe('parseDeadline', () => {
  const now = Date.parse('2026-10-04T00:00:00Z');
  it('parses a future deadline within 24h', () => {
    expect(parseDeadline('2026-10-04T00:10:00Z', now)).toBe(now + 600_000);
    expect(parseDeadline(undefined, now)).toBeUndefined();
  });
  it('rejects past and too-distant deadlines', () => {
    expect(() => parseDeadline('2026-10-03T23:59:00Z', now)).toThrow('future');
    expect(() => parseDeadline('2026-10-05T00:00:01Z', now)).toThrow('24 hours');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run src/lib/send/__tests__/request.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/send/request.ts`**

```ts
import { z } from 'zod';
import type { Priority } from 'src/types';
import { EmailAttachmentSchema } from '../providers/email/mailer';
import { attachmentMaxFiles, attachmentMaxTotalBytes, totalAttachmentBytes } from '../providers/email/attachments';

const Slug = (max: number) => z.string().regex(/^[a-z0-9_.-]+$/).max(max);
const E164 = /^\+[1-9]\d{6,14}$/;

export const PRIORITY_MAP: Record<'urgent' | 'normal' | 'bulk', Priority> = {
  urgent: 'realtime',
  normal: 'other',
  bulk: 'bulk',
};

export const V1NotifySchema = z
  .object({
    event_type: Slug(64).optional(),
    template_key: Slug(128).optional(),
    channel: z.string().min(1).max(32).optional(),
    domain: Slug(64).optional(),
    to: z
      .object({ email: z.email().max(254).optional(), phone: z.string().regex(E164).optional() })
      .strict()
      .refine((t) => Boolean(t.email || t.phone), { message: 'at least one contact point is required' }),
    locale: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/).optional(),
    variables: z.record(z.string(), z.unknown()).default({}),
    priority: z.enum(['urgent', 'normal', 'bulk']).default('normal'),
    idempotency_key: z.string().min(1).max(128).optional(),
    deadline: z.iso.datetime({ offset: true }).optional(),
    cc: z.array(z.email()).max(10).optional(),
    reply_to: z.email().optional(),
    attachments: z.array(EmailAttachmentSchema).optional(),
  })
  .strict()
  .refine((b) => Boolean(b.event_type) !== Boolean(b.template_key), {
    message: 'exactly one of event_type or template_key is required',
  })
  .refine((b) => !b.template_key || Boolean(b.channel), { message: 'template_key requires channel', path: ['channel'] })
  .refine((b) => !b.event_type || !b.channel, { message: 'channel is chosen by policy for event_type', path: ['channel'] })
  .refine(
    (b) => !b.template_key || b.channel === 'email' || (!b.cc && !b.reply_to && !b.attachments),
    { message: 'cc, reply_to and attachments apply to email only', path: ['channel'] },
  )
  .refine((b) => (b.attachments ?? []).length <= attachmentMaxFiles(), { path: ['attachments'], error: () => `at most ${attachmentMaxFiles()} attachments are accepted` })
  .refine((b) => totalAttachmentBytes(b.attachments) <= attachmentMaxTotalBytes(), { path: ['attachments'], error: () => `attachments exceed the ${attachmentMaxTotalBytes()} byte total limit` });

export type V1Request = z.infer<typeof V1NotifySchema>;

const MAX_DEADLINE_MS = 24 * 60 * 60 * 1000;

export function parseDeadline(iso: string | undefined, now = Date.now()): number | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  if (at <= now) throw new RangeError('deadline must be in the future');
  if (at - now > MAX_DEADLINE_MS) throw new RangeError('deadline must be within 24 hours');
  return at;
}
```

- [ ] **Step 4: Run and commit**

Run: `pnpm vitest run src/lib/send/__tests__/request.test.ts && pnpm build`
Expected: PASS.

```bash
git add src/lib/send/request.ts src/lib/send/__tests__/request.test.ts
git commit -m "feat(send): v1 request schema

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Planning a send

**Files:**
- Create: `src/lib/send/errors.ts`, `src/lib/send/plan.ts`, `src/lib/send/__tests__/plan.test.ts`

**Interfaces:**
- Consumes: `resolvePolicy`, `planDelivery`, `CHANNEL_CONTACT` (Plan B policies); `resolveTemplate`, `renderTemplate`, `TemplateError`, `sensitiveVariables`, `Rendered`, `TemplateRow`; `PRIORITY_MAP`, `parseDeadline`, `V1Request` (Task 3); `urgentDefaultDeadlineS` (C1).
- Produces:
  - `class SendError extends Error { code: string; kind: 'caller' | 'configuration'; details? }`
  - `classify(code: string): 'caller' | 'configuration'` — caller: `missing_variable|unknown_variable|invalid_variable|no_reachable_channel`; everything else configuration
  - `interface PlannedDelivery { channel: string; to: string; templateKey: string; provider: string; providerTemplateId: string | null; rendered: Rendered; dlt: { senderId: string | null; dltEntityId: string | null; dltHeaderId: string | null; dltTagId: string | null } }`
  - `interface SendPlan { mode: DeliveryMode; deliveries: PlannedDelivery[]; redact: boolean; deadline?: number; variables: Record<string, string> }`
  - `planSend(req: V1Request, now?: number): Promise<SendPlan>` — throws `SendError`; `RangeError` from `parseDeadline` is the route's 400

Algorithm:
1. Candidates: `template_key` → `[{ channel, template_key }]`, mode `single`, and the channel's contact point must be present (`CHANNEL_CONTACT`) else `no_reachable_channel`. `event_type` → `resolvePolicy(domain, event_type)`; `null` → `no_policy`; `planDelivery(policy, to)`; none → `no_reachable_channel`; mode = policy mode.
2. Resolve each candidate's template (`resolveTemplate(channel, key, locale)`). `TemplateError` with a configuration code: for `single` throw it; otherwise skip that candidate and remember the first such error. No candidate left → throw the remembered error.
3. `union` = all declared variable names across resolved templates; any request variable not in `union` → `unknown_variable` (caller).
4. Render each with `renderTemplate(template, renders, pick(variables, its own names))`; caller-kind `TemplateError` → rethrow as caller `SendError` immediately (all modes); configuration-kind → same skip rule as step 2.
5. `redact` = `priority === 'urgent'` or any template has a sensitive variable.
6. `deadline` = `parseDeadline(req.deadline, now)` ?? `now + min(default_deadline_s) * 1000` over planned templates with one set ?? (`urgent` ? `now + urgentDefaultDeadlineS() * 1000` : undefined).
7. `variables` = the normalised union (each rendered template's validated values merged; used for the audit payload of non-redacted sends).

- [ ] **Step 1: Write the failing tests**

`src/lib/send/__tests__/plan.test.ts` mocks `../../policies/repo` (`resolvePolicy`), `../../templates/repo` (`resolveTemplate`) and uses the real `planDelivery`, `renderTemplate` and contract code:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
const policies = vi.hoisted(() => ({ resolvePolicy: vi.fn() }));
const templates = vi.hoisted(() => ({ resolveTemplate: vi.fn() }));
vi.mock('../../policies/repo', () => policies);
vi.mock('../../templates/repo', () => templates);

import { planSend } from '../plan';
import { SendError } from '../errors';
import { TemplateError } from '../../templates/errors';
import { V1NotifySchema } from '../request';

const v = (name: string, extra = {}) => ({ name, required: true, type: 'string', sensitive: false, raw: false, ...extra });
const tpl = (over: Record<string, unknown>) => ({
  id: 'id', network: 'n', channel: 'sms', templateKey: 'k', locale: 'en', version: 1, status: 'active',
  subject: null, bodyHtml: null, bodyText: null, variables: [], provider: 'msg91', providerTemplateId: 'flow',
  senderId: null, dltEntityId: null, dltHeaderId: null, dltTagId: null, approvalRef: null, defaultDeadlineS: null,
  createdBy: 't', publishedBy: null, createdAt: new Date(), updatedAt: new Date(), publishedAt: null, retiredAt: null, ...over,
});
const req = (b: Record<string, unknown>) => V1NotifySchema.parse(b);
async function codeOf(p: Promise<unknown>) { try { await p; return undefined; } catch (e) { return (e as SendError).code ?? (e as Error).message; } }

beforeEach(() => { policies.resolvePolicy.mockReset(); templates.resolveTemplate.mockReset(); });

const smsT = tpl({ channel: 'sms', templateKey: 'apply_sms', variables: [v('name')] });
const emailT = tpl({ channel: 'email', templateKey: 'apply_email', provider: 'smtp', providerTemplateId: null, subject: 'Hi {{name}}', bodyHtml: '<p>{{name}} {{link}}</p>', variables: [v('name'), v('link', { type: 'url' })] });

function policy(mode: 'first_available' | 'all') {
  policies.resolvePolicy.mockResolvedValue({ mode, channels: [{ channel: 'sms', template_key: 'apply_sms' }, { channel: 'email', template_key: 'apply_email' }] });
  templates.resolveTemplate.mockImplementation(async (channel: string) =>
    channel === 'sms' ? { template: smsT, renders: 'provider' } : { template: emailT, renders: 'ns' });
}

describe('planSend', () => {
  it('variables are checked against the union of planned contracts', async () => {
    policy('first_available');
    const plan = await planSend(req({ event_type: 'apply', to: { phone: '+919999999999', email: 'a@b.c' }, variables: { name: 'A', link: 'https://x.org/' } }));
    expect(plan.deliveries.map((d) => d.channel)).toEqual(['sms', 'email']);
    expect(plan.deliveries[0]!.rendered).toMatchObject({ mode: 'provider', variables: { name: 'A' } });
    expect(await codeOf(planSend(req({ event_type: 'apply', to: { phone: '+919999999999' }, variables: { name: 'A', bogus: 'x' } })))).toBe('unknown_variable');
  });

  it('drops channels without a contact point', async () => {
    policy('all');
    const plan = await planSend(req({ event_type: 'apply', to: { phone: '+919999999999' }, variables: { name: 'A' } }));
    expect(plan.deliveries.map((d) => d.channel)).toEqual(['sms']);
    expect(plan.mode).toBe('all');
  });

  it('no policy and no reachable channel are distinct errors', async () => {
    policies.resolvePolicy.mockResolvedValue(null);
    expect(await codeOf(planSend(req({ event_type: 'x', to: { phone: '+919999999999' } })))).toBe('no_policy');
    policy('all');
    templates.resolveTemplate.mockResolvedValue({ template: smsT, renders: 'provider' });
    policies.resolvePolicy.mockResolvedValue({ mode: 'all', channels: [{ channel: 'email', template_key: 'apply_email' }] });
    const e = await planSend(req({ event_type: 'apply', to: { phone: '+919999999999' } })).catch((x) => x);
    expect(e).toMatchObject({ code: 'no_reachable_channel', kind: 'caller' });
  });

  it('first_available skips a candidate whose template is missing', async () => {
    policy('first_available');
    templates.resolveTemplate.mockImplementation(async (channel: string) => {
      if (channel === 'sms') throw new TemplateError('not_found', 'no active sms template');
      return { template: emailT, renders: 'ns' };
    });
    const plan = await planSend(req({ event_type: 'apply', to: { phone: '+919999999999', email: 'a@b.c' }, variables: { name: 'A', link: 'https://x.org/' } }));
    expect(plan.deliveries.map((d) => d.channel)).toEqual(['email']);
  });

  it('single template_key reports a configuration error', async () => {
    templates.resolveTemplate.mockRejectedValue(new TemplateError('vendor_mismatch', 'x'));
    const e = await planSend(req({ template_key: 'login_otp', channel: 'sms', to: { phone: '+919999999999' } })).catch((x) => x);
    expect(e).toMatchObject({ code: 'vendor_mismatch', kind: 'configuration' });
  });

  it('caller variable errors fail the whole request', async () => {
    policy('first_available');
    const e = await planSend(req({ event_type: 'apply', to: { phone: '+919999999999', email: 'a@b.c' }, variables: { name: 'A', link: 'javascript:x' } })).catch((x) => x);
    expect(e).toMatchObject({ code: 'invalid_variable', kind: 'caller' });
  });

  it('redacts urgent sends and sends with sensitive variables', async () => {
    templates.resolveTemplate.mockResolvedValue({ template: tpl({ templateKey: 'login_otp', variables: [v('message', { sensitive: true })] }), renders: 'provider' });
    const normal = await planSend(req({ template_key: 'login_otp', channel: 'sms', to: { phone: '+919999999999' }, variables: { message: '1' } }));
    expect(normal.redact).toBe(true);
  });

  it('deadline: request → template default → urgent default', async () => {
    const now = Date.parse('2026-10-04T00:00:00Z');
    templates.resolveTemplate.mockResolvedValue({ template: tpl({ templateKey: 'k', defaultDeadlineS: 120 }), renders: 'provider' });
    const base = { template_key: 'k', channel: 'sms', to: { phone: '+919999999999' } };
    expect((await planSend(req({ ...base, deadline: '2026-10-04T00:05:00Z' }), now)).deadline).toBe(now + 300_000);
    expect((await planSend(req(base), now)).deadline).toBe(now + 120_000);
    templates.resolveTemplate.mockResolvedValue({ template: tpl({ templateKey: 'k' }), renders: 'provider' });
    expect((await planSend(req({ ...base, priority: 'urgent' }), now)).deadline).toBe(now + 600_000);
    expect((await planSend(req(base), now)).deadline).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/lib/send/__tests__/plan.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `errors.ts` and `plan.ts`**

`src/lib/send/errors.ts`:

```ts
const CALLER = new Set(['missing_variable', 'unknown_variable', 'invalid_variable', 'no_reachable_channel']);

export function classify(code: string): 'caller' | 'configuration' {
  return CALLER.has(code) ? 'caller' : 'configuration';
}

/** Why a send was refused. Messages name variables and keys, never values. */
export class SendError extends Error {
  readonly kind: 'caller' | 'configuration';
  constructor(public readonly code: string, message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'SendError';
    this.kind = classify(code);
  }
}
```

`src/lib/send/plan.ts`:

```ts
import type { DeliveryMode } from '../db/partitioned';
import type { TemplateRow } from '../db/schema';
import { urgentDefaultDeadlineS } from '../deadline';
import { CHANNEL_CONTACT, planDelivery } from '../policies/plan';
import { resolvePolicy } from '../policies/repo';
import { TemplateError } from '../templates/errors';
import { validateVariables } from '../templates/contract';
import { renderTemplate, type Rendered } from '../templates/render';
import { resolveTemplate } from '../templates/repo';
import { classify, SendError } from './errors';
import { parseDeadline, type V1Request } from './request';

export interface PlannedDelivery {
  channel: string;
  to: string;
  templateKey: string;
  provider: string;
  providerTemplateId: string | null;
  rendered: Rendered;
  dlt: { senderId: string | null; dltEntityId: string | null; dltHeaderId: string | null; dltTagId: string | null };
}

export interface SendPlan {
  mode: DeliveryMode;
  deliveries: PlannedDelivery[];
  redact: boolean;
  deadline?: number;
  variables: Record<string, string>;
}

const toSendError = (e: TemplateError) => new SendError(e.code, e.message, e.details);

function pick(input: Record<string, unknown>, names: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(input)) if (names.has(k)) out[k] = input[k];
  return out;
}

/**
 * Turn a v1 request into fully rendered deliveries, before anything is accepted.
 * Caller mistakes fail the request; a misconfigured candidate is skipped when
 * another can carry the message (first_available / all) and fails it otherwise.
 */
export async function planSend(req: V1Request, now = Date.now()): Promise<SendPlan> {
  const deadlineFromRequest = parseDeadline(req.deadline, now);
  const contacts = req.to;

  let mode: DeliveryMode;
  let candidates: { channel: string; template_key: string }[];
  if (req.template_key) {
    const need = CHANNEL_CONTACT[req.channel!];
    if (!need || !contacts[need]) throw new SendError('no_reachable_channel', `no ${need ?? 'contact point'} for ${req.channel}`);
    mode = 'single';
    candidates = [{ channel: req.channel!, template_key: req.template_key }];
  } else {
    const policy = await resolvePolicy(req.domain, req.event_type);
    if (!policy) throw new SendError('no_policy', `no active policy for ${req.event_type}`);
    candidates = planDelivery(policy, contacts).candidates;
    if (candidates.length === 0) throw new SendError('no_reachable_channel', 'no channel in the policy matches the supplied contact points');
    mode = policy.mode;
  }

  let firstConfigError: SendError | undefined;
  const skip = (e: TemplateError) => {
    if (mode === 'single') throw toSendError(e);
    firstConfigError ??= toSendError(e);
  };

  const resolved: { channel: string; key: string; template: TemplateRow; renders: 'ns' | 'provider' }[] = [];
  for (const c of candidates) {
    try {
      const { template, renders } = await resolveTemplate(c.channel, c.template_key, req.locale);
      resolved.push({ channel: c.channel, key: c.template_key, template, renders });
    } catch (e) {
      if (!(e instanceof TemplateError)) throw e;
      if (classify(e.code) === 'caller') throw toSendError(e);
      skip(e);
    }
  }
  if (resolved.length === 0) throw firstConfigError ?? new SendError('no_reachable_channel', 'nothing to send');

  const union = new Set(resolved.flatMap((r) => r.template.variables.map((s) => s.name)));
  const unknown = Object.keys(req.variables).filter((k) => !union.has(k));
  if (unknown.length) throw new SendError('unknown_variable', `unknown variables: ${unknown.join(', ')}`, { variables: unknown });

  const deliveries: PlannedDelivery[] = [];
  const variables: Record<string, string> = {};
  for (const r of resolved) {
    const own = new Set(r.template.variables.map((s) => s.name));
    let rendered: Rendered;
    try {
      rendered = renderTemplate(r.template, r.renders, pick(req.variables, own));
    } catch (e) {
      if (!(e instanceof TemplateError)) throw e;
      if (classify(e.code) === 'caller') throw toSendError(e);
      skip(e);
      continue;
    }
    Object.assign(variables, validateVariables(r.template.variables, pick(req.variables, own)));
    deliveries.push({
      channel: r.channel,
      to: r.channel === 'email' ? contacts.email! : contacts.phone!,
      templateKey: r.key,
      provider: r.template.provider,
      providerTemplateId: r.template.providerTemplateId,
      rendered,
      dlt: {
        senderId: r.template.senderId, dltEntityId: r.template.dltEntityId,
        dltHeaderId: r.template.dltHeaderId, dltTagId: r.template.dltTagId,
      },
    });
  }
  if (deliveries.length === 0) throw firstConfigError ?? new SendError('no_reachable_channel', 'nothing to send');

  const used = resolved.filter((r) => deliveries.some((d) => d.templateKey === r.key && d.channel === r.channel));
  const redact = req.priority === 'urgent' || used.some((r) => r.template.variables.some((s) => s.sensitive));
  const defaults = used.map((r) => r.template.defaultDeadlineS).filter((s): s is number => typeof s === 'number');
  const deadline =
    deadlineFromRequest ??
    (defaults.length ? now + Math.min(...defaults) * 1000 : undefined) ??
    (req.priority === 'urgent' ? now + urgentDefaultDeadlineS() * 1000 : undefined);

  return { mode, deliveries, redact, deadline, variables };
}
```

- [ ] **Step 4: Run and commit**

Run: `pnpm vitest run src/lib/send && pnpm build`
Expected: PASS.

```bash
git add src/lib/send
git commit -m "feat(send): plan v1 sends — policy, capability filter, render, deadline

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Idempotency

**Files:**
- Create: `src/lib/send/idempotency.ts`, `src/lib/send/__tests__/idempotency.integration.test.ts`
- Modify: `src/lib/db/maintenance.ts` (90-day cleanup)

**Interfaces:**
- Consumes: `getDb`, `idempotencyKey` (Task 1), `redis`, `dedupe`/`releaseDedupe` (existing).
- Produces:
  - `type Claim = { status: 'fresh' } | { status: 'replay'; response: Record<string, unknown> } | { status: 'in_progress' }`
  - `claimIdempotency(network: string, key: string, priority: Priority): Promise<Claim>`
  - `completeIdempotency(network, key, priority, response): Promise<void>`
  - `releaseIdempotency(network, key, priority): Promise<void>` (best-effort; never throws)
  - `fallbackKey(req: V1Request): string` — `v1:` + sha256 of canonical JSON `{event_type, template_key, channel, domain, to, locale, variables}` (keys sorted)
  - `pruneIdempotencyKeys(olderThanDays = 90): Promise<number>` — called from each partition-maintenance tick, best-effort

Redis (urgent): key `idem:<network>:<key>`; claim = `SET NX` with value `pending`, `EX 900`; replay = stored JSON; complete = `SET … XX EX 900` with the response JSON; release = `DEL`. Postgres (normal/bulk): claim = `INSERT … ON CONFLICT DO NOTHING RETURNING key`; on conflict `SELECT response` → `null` = in progress, else replay; complete = `UPDATE … SET response`; release = `DELETE WHERE response IS NULL`.

- [ ] **Step 1: Write the failing integration test**

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import redis from '../../redis';
import { closeDb, getPool } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { claimIdempotency, completeIdempotency, fallbackKey, pruneIdempotencyKeys, releaseIdempotency } from '../idempotency';
import { V1NotifySchema } from '../request';

beforeAll(async () => { await runMigrations(); });
afterAll(async () => { await closeDb(); redis.disconnect(); });
beforeEach(async () => {
  await getPool().query(`DELETE FROM idempotency_key`);
  for (const k of await redis.keys('idem:*')) await redis.del(k);
});

describe.each(['realtime', 'other'] as const)('idempotency (%s)', (priority) => {
  it('fresh → in progress → replay', async () => {
    expect(await claimIdempotency('n', 'k1', priority)).toEqual({ status: 'fresh' });
    expect(await claimIdempotency('n', 'k1', priority)).toEqual({ status: 'in_progress' });
    await completeIdempotency('n', 'k1', priority, { notification_event_id: 'e1' });
    expect(await claimIdempotency('n', 'k1', priority)).toEqual({ status: 'replay', response: { notification_event_id: 'e1' } });
  });

  it('release lets a retry claim again', async () => {
    await claimIdempotency('n', 'k2', priority);
    await releaseIdempotency('n', 'k2', priority);
    expect(await claimIdempotency('n', 'k2', priority)).toEqual({ status: 'fresh' });
  });

  it('concurrent claims: exactly one fresh', async () => {
    const claims = await Promise.all(Array.from({ length: 8 }, () => claimIdempotency('n', 'k3', priority)));
    expect(claims.filter((c) => c.status === 'fresh')).toHaveLength(1);
  });

  it('keys are scoped per network', async () => {
    await claimIdempotency('a', 'k4', priority);
    expect(await claimIdempotency('b', 'k4', priority)).toEqual({ status: 'fresh' });
  });
});

describe('fallbackKey and pruning', () => {
  it('is stable regardless of key order and differs by content', () => {
    const a = V1NotifySchema.parse({ event_type: 'x', to: { phone: '+919999999999' }, variables: { a: '1', b: '2' } });
    const b = V1NotifySchema.parse({ variables: { b: '2', a: '1' }, to: { phone: '+919999999999' }, event_type: 'x' });
    const c = V1NotifySchema.parse({ event_type: 'x', to: { phone: '+919999999999' }, variables: { a: '1', b: '3' } });
    expect(fallbackKey(a)).toBe(fallbackKey(b));
    expect(fallbackKey(a)).not.toBe(fallbackKey(c));
  });
  it('prunes rows older than the window', async () => {
    await claimIdempotency('n', 'old', 'other');
    await getPool().query(`UPDATE idempotency_key SET created_at = now() - interval '91 days' WHERE key = 'old'`);
    expect(await pruneIdempotencyKeys(90)).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run the integration command. Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/send/idempotency.ts`**

```ts
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import redis from '../redis';
import { getDb } from '../db/client';
import { describeDbError } from '../db/errors';
import type { Priority } from 'src/types';
import type { V1Request } from './request';

export type Claim =
  | { status: 'fresh' }
  | { status: 'replay'; response: Record<string, unknown> }
  | { status: 'in_progress' };

const URGENT_TTL_S = 15 * 60;
const PENDING = 'pending';
const redisKey = (network: string, key: string) => `idem:${network}:${key}`;

/**
 * Claim an idempotency key. Urgent sends use Redis so an OTP never waits on
 * Postgres; normal and bulk use the idempotency_key table (kept 90 days).
 */
export async function claimIdempotency(network: string, key: string, priority: Priority): Promise<Claim> {
  if (priority === 'realtime') {
    const k = redisKey(network, key);
    if ((await redis.set(k, PENDING, 'EX', URGENT_TTL_S, 'NX')) === 'OK') return { status: 'fresh' };
    const value = await redis.get(k);
    if (value === null) return claimIdempotency(network, key, priority); // expired between the two calls
    return value === PENDING ? { status: 'in_progress' } : { status: 'replay', response: JSON.parse(value) };
  }
  const inserted = await getDb().execute(
    sql`INSERT INTO idempotency_key (network, key) VALUES (${network}, ${key}) ON CONFLICT DO NOTHING RETURNING key`,
  );
  if (inserted.rows.length > 0) return { status: 'fresh' };
  const existing = await getDb().execute(
    sql`SELECT response FROM idempotency_key WHERE network = ${network} AND key = ${key}`,
  );
  const response = existing.rows[0]?.response as Record<string, unknown> | null | undefined;
  return response ? { status: 'replay', response } : { status: 'in_progress' };
}

export async function completeIdempotency(
  network: string, key: string, priority: Priority, response: Record<string, unknown>,
): Promise<void> {
  if (priority === 'realtime') {
    await redis.set(redisKey(network, key), JSON.stringify(response), 'EX', URGENT_TTL_S, 'XX');
    return;
  }
  await getDb().execute(
    sql`UPDATE idempotency_key SET response = ${JSON.stringify(response)}::jsonb WHERE network = ${network} AND key = ${key}`,
  );
}

/** Undo a claim so the caller's retry is accepted. Best-effort: never throws. */
export async function releaseIdempotency(network: string, key: string, priority: Priority): Promise<void> {
  try {
    if (priority === 'realtime') {
      const k = redisKey(network, key);
      if ((await redis.get(k)) === PENDING) await redis.del(k);
      return;
    }
    await getDb().execute(
      sql`DELETE FROM idempotency_key WHERE network = ${network} AND key = ${key} AND response IS NULL`,
    );
  } catch (err) {
    console.error('idempotency release failed:', describeDbError(err));
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Content key for the 5-second duplicate guard used when no idempotency_key is sent. */
export function fallbackKey(req: V1Request): string {
  const { event_type, template_key, channel, domain, to, locale, variables } = req;
  const digest = createHash('sha256')
    .update(JSON.stringify(canonical({ event_type, template_key, channel, domain, to, locale, variables })))
    .digest('hex');
  return `v1:${digest}`;
}

export async function pruneIdempotencyKeys(olderThanDays = 90): Promise<number> {
  const res = await getDb().execute(
    sql`DELETE FROM idempotency_key WHERE created_at < now() - make_interval(days => ${olderThanDays})`,
  );
  return res.rowCount ?? 0;
}
```

In `src/lib/db/maintenance.ts`, inside `runPartitionMaintenance` after the `run_maintenance_proc` call (still holding the try-lock):

```ts
      await pruneIdempotencyKeys().catch((err) =>
        console.error('idempotency key pruning failed:', describeDbError(err)),
      );
```

- [ ] **Step 4: Run and commit**

Run the integration command and `pnpm test`.
Expected: PASS.

```bash
git add src/lib/send/idempotency.ts src/lib/send/__tests__/idempotency.integration.test.ts src/lib/db/maintenance.ts
git commit -m "feat(send): idempotency keys (Redis for urgent, Postgres otherwise) and fallback guard key

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: `POST /v1/notify`

**Files:**
- Create: `src/routes/v1-notify.ts`, `src/routes/__tests__/v1-notify.test.ts`
- Modify: `src/types/index.ts` (`Job.v1`), `src/app.ts`, `src/lib/metrics.ts` (HELP)

**Interfaces:**
- Consumes: Tasks 1, 3, 4, 5; `pushToPriority` (C1); `recordAccepted`, `recordAcceptedMany`, `toAcceptedRecord`; `currentNetwork`, `NetworkNotConfigured`; `dedupe`, `releaseDedupe`; `describeDbError`; `requestAuth`; `notifyBodyLimitBytes`.
- Produces:
  - `Job.v1?: { mode: DeliveryMode; deliveries: PlannedDelivery[]; index: number; email?: { cc?: string[]; replyTo?: string; attachments?: Email_attachment[] } }`
  - `v1NotifyRoutes(app)`

Flow:
1. Parse with `V1NotifySchema` → `400` (Zod format). `currentNetwork()` → `503 network_not_configured`.
2. If `idempotency_key`: `claimIdempotency(network, key, internalPriority)` → `replay` → `200` original body; `in_progress` → `409 {"error":"idempotency_in_progress"}`. Else `dedupe(fallbackKey(req), 5)` → hit → `409 {"error":"duplicate-fallback"}`.
3. `planSend(req)`: `RangeError` → `400 {"error":"invalid_deadline","message"}`; `SendError` → `422 {"error":code,"kind","message","details"?}` + `ns_send_rejected_total{kind,code}`. On any refusal release the claim/guard.
4. Build jobs. Shared: `eventId`, `createdAt`, `correlationId` (`x-correlation-id` trimmed to 128, else `eventId`), `redactValues = plan.redact`, `deliveryMode = plan.mode`, `deadline = plan.deadline`, `priority = PRIORITY_MAP[req.priority]`, email extras when present. `single`/`first_available`: one job, `v1.index = 0`, channel/to/template_id from `deliveries[0]`. `all`: one job per delivery, each with its own `attemptId` and `v1 = { mode: 'all', deliveries: [d], index: 0 }`. `job.variables = plan.redact ? {} : plan.variables`.
5. Audit + enqueue: `realtime` → push every job first, then `recordAcceptedMany(records)` fire-and-forget (logged with `describeDbError`). Otherwise `recordAcceptedMany(records)` first → failure: release claim/guard, `503 {"error":"audit store unavailable"}`; then push; push failure → stamp each `failed` (`enqueue failed`), release, rethrow.
6. Response `202 { notification_event_id, correlation_id, status: 'accepted', mode, deliveries: [{ channel }] }`; `completeIdempotency` with it when a key was claimed (best-effort).

- [ ] **Step 1: Write the failing tests**

`src/routes/__tests__/v1-notify.test.ts` (mock `requestAuth`, `../../lib/send/plan`, `../../lib/send/idempotency`, `../../lib/audit/store`, `../../lib/audit/stamp`, `../../lib/queue`, `../../lib/dedupe`; set `NS_NETWORK`):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../plugins/request-auth', () => ({ requestAuth: async () => {} }));
const plan = vi.hoisted(() => ({ planSend: vi.fn() }));
vi.mock('../../lib/send/plan', () => plan);
const idem = vi.hoisted(() => ({ claimIdempotency: vi.fn(), completeIdempotency: vi.fn(async () => {}), releaseIdempotency: vi.fn(async () => {}), fallbackKey: vi.fn(() => 'fk') }));
vi.mock('../../lib/send/idempotency', () => idem);
const store = vi.hoisted(() => ({ recordAccepted: vi.fn(async () => {}), recordAcceptedMany: vi.fn(async () => {}) }));
vi.mock('../../lib/audit/store', () => store);
vi.mock('../../lib/audit/stamp', () => ({ stamp: vi.fn(async () => {}) }));
const queue = vi.hoisted(() => ({ pushToPriority: vi.fn(async () => {}) }));
vi.mock('../../lib/queue', () => queue);
const dd = vi.hoisted(() => ({ dedupe: vi.fn(async () => true), releaseDedupe: vi.fn(async () => {}) }));
vi.mock('../../lib/dedupe', () => dd);

const Fastify = (await import('fastify')).default;
const { v1NotifyRoutes } = await import('../v1-notify');
const { SendError } = await import('../../lib/send/errors');

const delivery = (channel: string) => ({ channel, to: channel === 'email' ? 'a@b.c' : '+919999999999', templateKey: `k_${channel}`, provider: 'msg91', providerTemplateId: 'f', rendered: { mode: 'provider', channel, providerTemplateId: 'f', variables: { name: 'A' } }, dlt: { senderId: null, dltEntityId: null, dltHeaderId: null, dltTagId: null } });

async function app() { const a = Fastify({ logger: false }); await a.register(v1NotifyRoutes); await a.ready(); return a; }
const post = async (payload: unknown) => (await app()).inject({ method: 'POST', url: '/v1/notify', payload, headers: { 'x-ns-key': 'signals' } });
const body = { event_type: 'apply', to: { phone: '+919999999999', email: 'a@b.c' }, variables: { name: 'A' } };

beforeEach(() => {
  process.env.NS_NETWORK = 'blue_dot';
  for (const m of [...Object.values(plan), ...Object.values(store), ...Object.values(queue)]) (m as ReturnType<typeof vi.fn>).mockReset?.();
  store.recordAcceptedMany.mockResolvedValue(undefined);
  queue.pushToPriority.mockResolvedValue(undefined);
  idem.claimIdempotency.mockResolvedValue({ status: 'fresh' });
  dd.dedupe.mockResolvedValue(true);
  plan.planSend.mockResolvedValue({ mode: 'first_available', deliveries: [delivery('sms'), delivery('email')], redact: false, variables: { name: 'A' } });
});

describe('POST /v1/notify', () => {
  it('accepts, records before queueing, and enqueues one job for first_available', async () => {
    const res = await post(body);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'accepted', mode: 'first_available', deliveries: [{ channel: 'sms' }, { channel: 'email' }] });
    expect(queue.pushToPriority).toHaveBeenCalledTimes(1);
    expect(store.recordAcceptedMany.mock.invocationCallOrder[0]).toBeLessThan(queue.pushToPriority.mock.invocationCallOrder[0]!);
    const job = queue.pushToPriority.mock.calls[0]![0];
    expect(job).toMatchObject({ priority: 'other', channel: 'sms', v1: { mode: 'first_available', index: 0 } });
    expect(job.audit).toMatchObject({ deliveryMode: 'first_available', redactValues: false });
  });

  it('fans out one job per delivery for all, under one event', async () => {
    plan.planSend.mockResolvedValue({ mode: 'all', deliveries: [delivery('sms'), delivery('email')], redact: false, variables: {} });
    await post(body);
    expect(queue.pushToPriority).toHaveBeenCalledTimes(2);
    const [a, b] = queue.pushToPriority.mock.calls.map((c) => c[0]);
    expect(a.audit.eventId).toBe(b.audit.eventId);
    expect(a.audit.attemptId).not.toBe(b.audit.attemptId);
  });

  it('urgent is accepted when the audit store is down', async () => {
    store.recordAcceptedMany.mockRejectedValue(new Error('db down'));
    const res = await post({ ...body, priority: 'urgent' });
    expect(res.statusCode).toBe(202);
    expect(queue.pushToPriority.mock.calls[0]![0].priority).toBe('realtime');
  });

  it('normal sends are refused with 503 when the record fails, and the claim is released', async () => {
    store.recordAcceptedMany.mockRejectedValue(new Error('db down'));
    const res = await post({ ...body, idempotency_key: 'k' });
    expect(res.statusCode).toBe(503);
    expect(queue.pushToPriority).not.toHaveBeenCalled();
    expect(idem.releaseIdempotency).toHaveBeenCalled();
  });

  it('maps planning errors to 422 with their kind', async () => {
    plan.planSend.mockRejectedValue(new SendError('missing_variable', 'missing variable: name', { variable: 'name' }));
    const res = await post(body);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'missing_variable', kind: 'caller' });
    plan.planSend.mockRejectedValue(new SendError('vendor_mismatch', 'x'));
    expect((await post(body)).json()).toMatchObject({ kind: 'configuration' });
  });

  it('replays an idempotent repeat and refuses one in progress', async () => {
    idem.claimIdempotency.mockResolvedValueOnce({ status: 'replay', response: { notification_event_id: 'e1' } });
    const r1 = await post({ ...body, idempotency_key: 'k' });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({ notification_event_id: 'e1' });
    idem.claimIdempotency.mockResolvedValueOnce({ status: 'in_progress' });
    expect((await post({ ...body, idempotency_key: 'k' })).statusCode).toBe(409);
    expect(plan.planSend).not.toHaveBeenCalled();
  });

  it('a content repeat without a key is a 409 duplicate-fallback', async () => {
    dd.dedupe.mockResolvedValueOnce(false);
    const res = await post(body);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'duplicate-fallback' });
  });

  it('503 when NS_NETWORK is unset; 400 for an invalid deadline', async () => {
    delete process.env.NS_NETWORK;
    expect((await post(body)).statusCode).toBe(503);
    process.env.NS_NETWORK = 'blue_dot';
    plan.planSend.mockRejectedValue(new RangeError('deadline must be in the future'));
    expect((await post(body)).json()).toMatchObject({ error: 'invalid_deadline' });
  });

  it('redacted sends carry no variable values on the job', async () => {
    plan.planSend.mockResolvedValue({ mode: 'single', deliveries: [delivery('sms')], redact: true, variables: { message: '123456' } });
    await post({ template_key: 'login_otp', channel: 'sms', to: { phone: '+919999999999' }, variables: { message: '123456' } });
    const job = queue.pushToPriority.mock.calls[0]![0];
    expect(job.variables).toEqual({});
    expect(job.audit.redactValues).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/routes/__tests__/v1-notify.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/types/index.ts` — add to `Job` (type-only imports):

```ts
  /** Send API v1: pre-rendered deliveries, tried in order (first_available) or one per job (all). */
  v1?: {
    mode: import('../lib/db/partitioned').DeliveryMode;
    deliveries: import('../lib/send/plan').PlannedDelivery[];
    index: number;
    email?: { cc?: string[]; replyTo?: string; attachments?: import('../lib/providers/email/sendMailCore').Email_attachment[] };
  };
```

In `src/routes/notify.ts` export `correlationIdFrom` (already exports `MAX_CORRELATION_ID_LENGTH`).

`src/routes/v1-notify.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Job } from 'src/types';
import { recordAcceptedMany } from '../lib/audit/store';
import { toAcceptedRecord } from '../lib/audit/redact';
import { stamp } from '../lib/audit/stamp';
import { describeDbError } from '../lib/db/errors';
import { dedupe, releaseDedupe } from '../lib/dedupe';
import * as metrics from '../lib/metrics';
import { currentNetwork, NetworkNotConfigured } from '../lib/network';
import { notifyBodyLimitBytes } from '../lib/providers/email/attachments';
import { pushToPriority } from '../lib/queue';
import { SendError } from '../lib/send/errors';
import { claimIdempotency, completeIdempotency, fallbackKey, releaseIdempotency } from '../lib/send/idempotency';
import { planSend, type SendPlan } from '../lib/send/plan';
import { PRIORITY_MAP, V1NotifySchema, type V1Request } from '../lib/send/request';
import { requestAuth } from '../plugins/request-auth';
import { correlationIdFrom } from './notify';

const FALLBACK_TTL_S = 5;

function buildJobs(req: V1Request, plan: SendPlan, correlationHeader: unknown): Job[] {
  const eventId = randomUUID();
  const createdAt = new Date().toISOString();
  const priority = PRIORITY_MAP[req.priority];
  const email = req.cc || req.reply_to || req.attachments
    ? { cc: req.cc, replyTo: req.reply_to, attachments: req.attachments }
    : undefined;
  const make = (deliveries: SendPlan['deliveries']): Job => ({
    job_id: randomUUID(),
    channel: deliveries[0]!.channel,
    priority,
    to: deliveries[0]!.to,
    template_id: deliveries[0]!.templateKey,
    variables: plan.redact ? {} : plan.variables,
    ...(plan.deadline !== undefined ? { deadline: plan.deadline } : {}),
    v1: { mode: plan.mode, deliveries, index: 0, ...(email ? { email } : {}) },
    audit: {
      eventId,
      attemptId: randomUUID(),
      createdAt,
      correlationId: correlationIdFrom(correlationHeader, eventId),
      redactValues: plan.redact,
      deliveryMode: plan.mode,
    },
  });
  return plan.mode === 'all' ? plan.deliveries.map((d) => make([d])) : [make(plan.deliveries)];
}

export async function v1NotifyRoutes(app: FastifyInstance) {
  app.route({
    url: '/v1/notify',
    method: 'POST',
    preHandler: requestAuth,
    bodyLimit: notifyBodyLimitBytes(),
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = V1NotifySchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send(z.formatError(parsed.error));
      const body = parsed.data;

      let network: string;
      try {
        network = currentNetwork();
      } catch (e) {
        if (e instanceof NetworkNotConfigured) return reply.code(503).send({ error: 'network_not_configured' });
        throw e;
      }
      const priority = PRIORITY_MAP[body.priority];

      // Claim first, so a repeat never plans or sends twice.
      let release: () => Promise<void>;
      if (body.idempotency_key) {
        const claim = await claimIdempotency(network, body.idempotency_key, priority);
        if (claim.status === 'replay') return reply.code(200).send(claim.response);
        if (claim.status === 'in_progress') return reply.code(409).send({ error: 'idempotency_in_progress' });
        release = () => releaseIdempotency(network, body.idempotency_key!, priority);
      } else {
        const key = fallbackKey(body);
        if (!(await dedupe(key, FALLBACK_TTL_S))) return reply.code(409).send({ error: 'duplicate-fallback' });
        release = () => releaseDedupe(key).catch(() => undefined);
      }

      let plan: SendPlan;
      try {
        plan = await planSend(body);
      } catch (e) {
        await release();
        if (e instanceof RangeError) return reply.code(400).send({ error: 'invalid_deadline', message: e.message });
        if (e instanceof SendError) {
          await metrics.incr('ns_send_rejected_total', { kind: e.kind, code: e.code });
          return reply.code(422).send({ error: e.code, kind: e.kind, message: e.message, ...(e.details ? { details: e.details } : {}) });
        }
        throw e;
      }

      const jobs = buildJobs(body, plan, req.headers['x-correlation-id']);
      const source = String(req.headers['x-ns-key'] ?? 'unknown');
      const records = jobs.map((j) => toAcceptedRecord(j, source));

      if (priority === 'realtime') {
        // Queue first: a slow or unavailable Postgres must never delay an OTP.
        for (const job of jobs) await pushToPriority(job);
        void recordAcceptedMany(records).catch((err) =>
          req.log.error({ err: describeDbError(err), event: jobs[0]!.audit!.eventId }, 'v1 urgent audit insert failed'),
        );
      } else {
        try {
          await recordAcceptedMany(records);
        } catch (err) {
          req.log.error({ err: describeDbError(err) }, 'v1 audit insert failed; refusing send');
          await release();
          return reply.code(503).send({ error: 'audit store unavailable' });
        }
        try {
          for (const job of jobs) await pushToPriority(job);
        } catch (err) {
          for (const job of jobs) await stamp(job, { status: 'failed', attemptNo: 1, error: 'enqueue failed' });
          await release();
          throw err;
        }
      }

      const response = {
        notification_event_id: jobs[0]!.audit!.eventId,
        correlation_id: jobs[0]!.audit!.correlationId,
        status: 'accepted',
        mode: plan.mode,
        deliveries: plan.deliveries.map((d) => ({ channel: d.channel })),
      };
      if (body.idempotency_key) {
        await completeIdempotency(network, body.idempotency_key, priority, response).catch((err) =>
          req.log.error({ err: describeDbError(err) }, 'idempotency completion failed'),
        );
      }
      return reply.code(202).send(response);
    },
  });
}
```

Register in `src/app.ts`: `import { v1NotifyRoutes } from './routes/v1-notify';` and `app.register(v1NotifyRoutes);`. Add `ns_send_rejected_total` to the metrics HELP map.

Note: a pushed `first_available` job's later deliveries are not inserted as attempt rows until the worker falls through to them (Task 7) — the event row records the full plan in its payload.

- [ ] **Step 4: Run and commit**

Run: `pnpm build && pnpm test`
Expected: PASS.

```bash
git add src/routes/v1-notify.ts src/routes/__tests__/v1-notify.test.ts src/routes/notify.ts src/types/index.ts src/app.ts src/lib/metrics.ts
git commit -m "feat(api): POST /v1/notify

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: The worker delivers v1 jobs, with fallthrough

**Files:**
- Modify: `src/lib/worker.ts`, `src/lib/audit/redact.ts`, `src/lib/__tests__/worker.test.ts`

**Interfaces:**
- Consumes: `Job.v1`, `sendRendered` (Task 2), C1's `acquireSendToken`, `expire`, `dropOrDeadLetter`, `isExpired`, `wouldExpire`.
- Produces: in `processJob`, a `v1` branch:
  1. `d = job.v1.deliveries[job.v1.index]`; `provider = providers[d.channel]`.
  2. No provider, no `sendRendered`, or `provider.vendor !== d.provider` (the deployment changed vendor after accept) → permanent failure with `unknown_channel` / `rendered send unsupported` / `vendor changed since accept`.
  3. Rate limit and deadline exactly as C1 (channel `d.channel`, vendor `provider.vendor`).
  4. `res = await provider.sendRendered({ to: d.to, rendered: d.rendered, providerTemplateId: d.providerTemplateId, dlt: d.dlt, email: d.channel === 'email' ? job.v1.email : undefined, job_id: job.job_id })` (throw → retryable, as today).
  5. Success → marker `sent`, stamp `sent` (unchanged).
  6. Retryable failure below `MAX_RETRIES` and before the deadline → retry as today.
  7. Permanent failure or retries exhausted → if `job.v1.mode === 'first_available'` and another delivery remains: stamp current attempt `failed` (+ marker), then advance — `job.v1.index += 1`, `job.audit.attemptId = randomUUID()`, `job.attempt = 0`, `job.channel/to/template_id` from the next delivery — stamp the new attempt `queued` (attemptNo 1; `upsertAttempt` inserts it) and `pushToPriority(job)`, counting `ns_send_fallthrough_total{from,to}`. Otherwise `dropOrDeadLetter`.
- `toAcceptedRecord` uses `job.template_id` (set to the delivery's template key) and copies `job.audit` (incl. `deliveryMode`) — confirm the fall-through attempt row gets the right channel/template.

- [ ] **Step 1: Write the failing tests** (in `worker.test.ts`; providers mock gains a `sendRendered` on sms and email doubles with `vendor`s):

```ts
describe('v1 jobs', () => {
  const d = (channel: string) => ({ channel, to: channel === 'email' ? 'a@b.c' : '+919999999999', templateKey: `k_${channel}`, provider: channel === 'email' ? 'smtp' : 'msg91', providerTemplateId: 'f', rendered: { mode: 'provider', channel, providerTemplateId: 'f', variables: {} }, dlt: { senderId: null, dltEntityId: null, dltHeaderId: null, dltTagId: null } });
  const v1Job = (mode = 'first_available') => ({
    job_id: 'j', channel: 'sms', priority: 'other', to: '+919999999999', template_id: 'k_sms', variables: {},
    v1: { mode, deliveries: [d('sms'), d('email')], index: 0 },
    audit: { eventId: 'e', attemptId: 'a1', createdAt: 'c', correlationId: 'c', deliveryMode: mode },
  });

  it('sends pre-rendered content via sendRendered', async () => {
    await processJob(v1Job() as never);
    expect(smsSendRendered).toHaveBeenCalledWith(expect.objectContaining({ to: '+919999999999', providerTemplateId: 'f' }));
    expect(send).not.toHaveBeenCalled();
  });

  it('first_available falls through on permanent failure', async () => {
    smsSendRendered.mockResolvedValueOnce({ ok: false, retryable: false, error: 'bad' });
    await processJob(v1Job() as never);
    expect(stamp).toHaveBeenCalledWith(expect.objectContaining({ audit: expect.objectContaining({ attemptId: 'a1' }) }), expect.objectContaining({ status: 'failed' }));
    const next = vi.mocked(pushToPriority).mock.calls[0]![0];
    expect(next).toMatchObject({ channel: 'email', to: 'a@b.c', attempt: 0, v1: { index: 1 } });
    expect(next.audit.attemptId).not.toBe('a1');
    expect(pushDLQ).not.toHaveBeenCalled();
  });

  it('the last delivery failing permanently dead-letters (or drops when redacted)', async () => {
    emailSendRendered.mockResolvedValueOnce({ ok: false, retryable: false, error: 'bad' });
    const job = { ...v1Job(), channel: 'email', to: 'a@b.c', v1: { ...v1Job().v1, index: 1 } };
    await processJob(job as never);
    expect(pushToPriority).not.toHaveBeenCalled();
    expect(pushDLQ).toHaveBeenCalled();
  });

  it('a vendor change since accept fails permanently', async () => {
    const job = v1Job();
    job.v1.deliveries[0]!.provider = 'pinnacle';
    await processJob(job as never);
    expect(smsSendRendered).not.toHaveBeenCalled();
  });

  it('all-mode jobs never fall through', async () => {
    smsSendRendered.mockResolvedValueOnce({ ok: false, retryable: false, error: 'bad' });
    await processJob({ ...v1Job('all'), v1: { mode: 'all', deliveries: [d('sms')], index: 0 } } as never);
    expect(pushToPriority).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/lib/__tests__/worker.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the v1 branch**

In `src/lib/worker.ts` (C1 has already added `expire`, `dropOrDeadLetter`, the rate-limit and deadline checks). Restructure `processJob` so the legacy path is unchanged and v1 jobs take a separate function sharing the fate helpers:

```ts
import { randomUUID } from 'node:crypto';
import { pushToPriority } from './queue';

export async function processJob(job: Job) {
  if (job.v1) return processV1Job(job);
  // ... existing legacy body, unchanged ...
}

/** Next delivery for first_available, as a new attempt row; false when none remains. */
async function fallThrough(job: Job): Promise<boolean> {
  const v1 = job.v1!;
  if (v1.mode !== 'first_available' || v1.index + 1 >= v1.deliveries.length) return false;
  const from = v1.deliveries[v1.index]!.channel;
  const next = v1.deliveries[v1.index + 1]!;
  const advanced: Job = {
    ...job,
    channel: next.channel,
    to: next.to,
    template_id: next.templateKey,
    attempt: 0,
    v1: { ...v1, index: v1.index + 1 },
    audit: { ...job.audit!, attemptId: randomUUID() },
  };
  await stamp(advanced, { status: 'queued', attemptNo: 1 });
  await pushToPriority(advanced);
  await metrics.incr('ns_send_fallthrough_total', { from, to: next.channel });
  return true;
}

/** A delivery that cannot succeed: close this attempt, then fall through or give up. */
async function failDelivery(job: Job, reason: string, error?: string) {
  await markAttempt(job, 'failed', job.attempt ?? 1);
  await stamp(job, { status: 'failed', attemptNo: job.attempt ?? 1, error: error ?? reason });
  if (await fallThrough(job)) return;
  if (isRedacted(job)) {
    await metrics.incr('ns_job_dropped_total', { channel: job.channel, reason });
    return;
  }
  await metrics.incr('ns_job_dlq_total', { channel: job.channel, reason });
  return pushDLQ(job);
}

async function processV1Job(job: Job) {
  if (isExpired(job)) return expire(job, (job.attempt ?? 0) + 1);
  const d = job.v1!.deliveries[job.v1!.index]!;
  const provider = providers[d.channel];

  if (provider && !(await acquireSendToken(d.channel, provider.vendor, job.priority))) {
    await metrics.incr('ns_rate_limited_total', { channel: d.channel, priority: job.priority });
    const wait = rateLimitDeferMs();
    if (wouldExpire(job, wait)) return expire(job, (job.attempt ?? 0) + 1);
    return deferJob(job, wait);
  }

  job.attempt = (job.attempt ?? 0) + 1;
  if (!provider) return failDelivery(job, 'unknown_channel');
  if (!provider.sendRendered) return failDelivery(job, 'rendered send unsupported');
  if (provider.vendor !== d.provider) return failDelivery(job, 'vendor changed since accept');

  await stamp(job, { status: 'dispatching', attemptNo: job.attempt });
  let res: ProviderSendResult;
  try {
    res = await provider.sendRendered({
      to: d.to,
      rendered: d.rendered,
      providerTemplateId: d.providerTemplateId,
      dlt: d.dlt,
      email: d.channel === 'email' ? job.v1!.email : undefined,
      job_id: job.job_id,
    });
  } catch (err) {
    console.log(`Provider threw for ${job.job_id}:`, err instanceof Error ? err.message : String(err));
    res = { ok: false, error: 'provider threw', retryable: true };
  }

  if (res.ok) {
    await markAttempt(job, 'sent', job.attempt);
    await stamp(job, { status: 'sent', attemptNo: job.attempt, providerMessageId: res.provider_message_id });
    return;
  }
  if (res.retryable === false) return failDelivery(job, 'permanent_failure', res.error);
  if (job.attempt >= MAX_RETRIES) return failDelivery(job, 'max_retries', res.error);

  const delay = 5 * Math.pow(2, job.attempt - 1);
  if (wouldExpire(job, delay * 1000)) return expire(job, job.attempt);
  await stamp(job, { status: 'queued', attemptNo: job.attempt + 1, error: res.error });
  return scheduleRetryWithMarker(job, delay, attemptMarker(job, 'retry', job.attempt + 1));
}
```

Add `ns_send_fallthrough_total` to the metrics HELP map. Keep the legacy body exactly as it is.

- [ ] **Step 4: Run tests**

Run: `pnpm build && pnpm test` and the integration command.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/worker.ts src/lib/audit/redact.ts src/lib/__tests__/worker.test.ts
git commit -m "feat(worker): deliver v1 jobs with synchronous channel fallthrough

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: Recovery and an end-to-end check

**Files:**
- Modify: `src/lib/queue.ts` (`pushManyToPriority`), `src/lib/audit/recover.ts`
- Test: `src/lib/audit/__tests__/recover.integration.test.ts` (extend), `src/routes/__tests__/v1-notify.integration.test.ts`

**Interfaces:**
- Produces: `pushManyToPriority(jobs: Job[]): Promise<void>` — one `MULTI`, each job LPUSHed to its own priority's queue; recovery uses it instead of `pushOtherMany` (keep `pushOtherMany` only if still referenced).

- [ ] **Step 1: Write the failing tests**

Extend `recover.integration.test.ts`: a recoverable **bulk** v1 job copy is re-queued onto `queue:bulk` (not `queue:other`); a redacted v1 job (no job copy) is never re-queued.

`src/routes/__tests__/v1-notify.integration.test.ts` — real Postgres + Redis, provider registry mocked to an SMS double with `vendor: 'msg91', renders: 'provider'` and `sendRendered` spy, `NS_NETWORK=test_net`, `NS_ADMIN_KEY_IDS` unset:
1. Create + publish a `login_otp` SMS template (via the Plan B repo) with `message` sensitive.
2. `POST /v1/notify { template_key:'login_otp', channel:'sms', to:{phone}, variables:{message:'123456'}, priority:'urgent' }` → 202.
3. Pop `queue:realtime` with `popFrom` and run `processJob` on it → `sendRendered` called with `variables: { message: '123456' }`.
4. The `notification_event` row: `delivery_mode = 'single'`, payload contains `variable_names` and **not** `123456`; `delivery_attempt` row `sent` with `job IS NULL`.
5. Same request with `idempotency_key` twice → second answers `200` with the first body; one job queued.

- [ ] **Step 2: Run to see them fail**, **Step 3: implement** `pushManyToPriority` and switch recovery to it, **Step 4: run** all suites.

- [ ] **Step 5: Commit**

```bash
git add src/lib/queue.ts src/lib/audit/recover.ts src/lib/audit/__tests__ src/routes/__tests__/v1-notify.integration.test.ts
git commit -m "feat(audit): recover v1 jobs to their own priority; end-to-end v1 test

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: OpenAPI and documentation

**Files:**
- Modify: `src/lib/utils/openapi.ts`, `src/lib/utils/__tests__/openapi.test.ts`, `CLAUDE.md`, `README.md`, `example.env`

- [ ] **Step 1: Failing test** — extend `openapi.test.ts`: `/v1/notify` `post` exists with `security: [{ requestSignature: [] }]`, request schema `additionalProperties: false` with `event_type`, `template_key`, `channel`, `to`, `priority` enum `['urgent','normal','bulk']`, and responses `200`, `202`, `400`, `409`, `422`, `503`.
- [ ] **Step 2: Implement** the OpenAPI entry mirroring `V1NotifySchema` and the response shapes (`422` with `kind`).
- [ ] **Step 3: Docs** — `CLAUDE.md`: a *Send API v1* section (request rules, planning, error kinds, redaction rule incl. sensitive templates, deadline order, idempotency split Redis/Postgres and why, fallthrough semantics and that async bounces are out of scope, `all` roll-up, `sendRendered` never re-renders, `EMAIL_FROM_*`, legacy `/notify` kept until the cutover release). Update test counts and the metrics table (`ns_send_rejected_total{kind,code}`, `ns_send_fallthrough_total{from,to}`). `README.md`: a v1 request/response example and the error table. `example.env`: `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME`.
- [ ] **Step 4: Run and commit**

```bash
pnpm build && pnpm test
git add src/lib/utils CLAUDE.md README.md example.env
git commit -m "docs: Send API v1

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Done when

- `pnpm build`, `pnpm test`, `pnpm test:integration` green.
- `POST /v1/notify` accepts policy-routed and template-key sends, rejects caller and configuration problems with `422` and the right `kind`, honours idempotency, and the worker delivers pre-rendered content with `first_available` fallthrough and `all` roll-up.
- An urgent OTP is accepted with Postgres down, is never persisted with its code, never dead-lettered, and expires at its deadline.
- Legacy `/notify` behaviour is unchanged (its removal belongs to the cutover release).
