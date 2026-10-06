# Notification Service

A Fastify notification service for email, SMS and WhatsApp. Callers send through
the Send API v1 (`POST /v1/notify`); the service renders and validates the message
from a stored template before it accepts the request, records the send in Postgres,
queues it in Redis, and a worker delivers it asynchronously.

## What It Does

- Accepts sends through one API, `POST /v1/notify`: by `event_type` (a published
  policy picks the channels) or by `template_key` plus `channel`.
- Stores versioned templates and policies per network, managed through the admin API
  and seeded from a catalogue file.
- Renders and validates content at accept time, against each template's variable contract.
- Uses one Redis queue per priority (urgent, normal, bulk) and a sorted set for retries.
- Makes sends safe to retry with `idempotency_key`.
- Sends failed jobs to a dead-letter queue after retry exhaustion.
- Reports the configured vendor per channel at `GET /providers`.
- Serves Scalar API docs at `/` when `NS_DOCS_ENABLED=true`.

## Project Layout

```text
src/
├─ app.ts                    # Fastify app bootstrap and route registration
├─ server.ts                 # API startup and worker spawn
├─ routes/
│  ├─ docs.ts                # Scalar docs and OpenAPI JSON
│  ├─ metrics.ts             # Queue metrics route
│  ├─ v1-notify.ts           # Send API v1
│  ├─ admin-*.ts             # Template, policy and catalogue-export admin API
│  ├─ providers.ts           # Provider discovery routes
│  └─ retry.ts               # Manual failed-job retry route
├─ lib/
│  ├─ queue.ts               # Redis queues, retries, DLQ helpers
│  ├─ worker.ts              # Background job processor
│  ├─ utils/
│  │  ├─ openapi.ts          # OpenAPI document builder
│  │  └─ provider-docs.ts    # Provider metadata ({name, vendor, renders})
│  └─ providers/             # Provider implementations
└─ plugins/
   ├─ auth.ts                # Bearer token / HMAC v2 guard and route scopes
   └─ raw-body.ts            # JSON-only body parser that keeps the signed bytes
```

## Local Requirements

- Node.js 24+
- pnpm
- Redis 6+ (password set, `noeviction`)
- PostgreSQL 17 with `pg_partman` (the compose image in `docker/postgres` has it)
- Provider credentials for the providers you enable

## Setup

```bash
pnpm install
cp example.env .env
```

Fill `.env` with the credentials required by the provider implementations.

Start Postgres and Redis:

```bash
docker compose up -d postgres redis
```

The compose Postgres publishes host port 5432 (it collides with a local
Postgres). `docker/postgres/init.sql` runs only on the first boot of the
volume; run `docker volume rm notification-service-postgres` to re-init.

Start the API and worker:

```bash
pnpm dev
```

The API listens on `SERVER_PORT` or `3000` by default. `src/server.ts` also
spawns one background worker process.

### Persistence

Postgres is the record of every send; Redis is only the queue. Migrations run
on boot, and NS will not start without a reachable database. The `notification`
database must exist first. Set `REDIS_PASSWORD` too (`REDIS_ALLOW_NO_AUTH=true`
is for local runs only).

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_HOST` | required | |
| `DATABASE_NAME` | required | `notification` |
| `DATABASE_USER` | required | |
| `DATABASE_PASSWORD` | required | |
| `DATABASE_PORT` | `5432` | |
| `DATABASE_POOL_MAX` | `10` | Integer, at least 2 |
| `DATABASE_CONNECT_TIMEOUT_MS` | `2000` | Connect wait |
| `DATABASE_QUERY_TIMEOUT_MS` | `5000` | Client and server-side query timeout |
| `DATABASE_SSL` | `disable` | `disable` or `require`; `require` verifies the certificate, so supply the CA via `NODE_EXTRA_CA_CERTS` |
| `NS_NETWORK` | `unknown` | Network recorded on each event |
| `NS_SEED_FILE` | unset | Catalogue of templates and policies to create when absent, at boot only; see Catalogue below |
| `NS_CONTENT_FILE` | unset | Content file for `content_ref` template variables; unset, they are unavailable. Deployments use `/app/content/content.json` |
| `NS_CONTENT_PROVIDER` | `configmap` | Content source; `configmap` is the only value |
| `NS_CONTENT_RELOAD_MS` | `30000` | How often the content file is re-read, 1 to 3600000 |
| `INTERNAL_SECRETS_JSON` | required | Path to the HMAC signing keys file (see [Authentication](#authentication)) |
| `NS_KEYCLOAK_ISSUER` | unset | Turns bearer-token auth on. Must equal the token `iss` exactly, an http(s) URL with no trailing slash |
| `NS_KEYCLOAK_JWKS_URI` | `<issuer>/protocol/openid-connect/certs` | Key set location |
| `NS_AUTH_AUDIENCE` | `notification-service` | Required token `aud` |
| `NS_AUTH_ALLOWED_AZP` | required with the issuer | Comma-separated client ids whose tokens are accepted |
| `NS_DOCS_ENABLED` | unset | `true` serves `GET /` and `GET /openapi.json`; leave unset in deployed environments |
| `PARTITION_MAINTENANCE_INTERVAL_MS` | 6 hours | Partition pre-creation interval |
| `RECOVERY_MAX_AGE_HOURS` | `24` | Open sends older than this are marked failed by recovery, not re-sent |
| `WORKER_URGENT_CONCURRENCY` | `2` | Urgent loops, each on its own Redis connection; must be a positive integer |
| `WORKER_NORMAL_CONCURRENCY` | `2` | Normal loops |
| `WORKER_BULK_CONCURRENCY` | `1` | Bulk loops |
| `RATE_<CHANNEL>_PER_SEC` | `sms` 100, `email` 100, `whatsapp` 100 | Vendor rate for `SMS`, `EMAIL`, `WHATSAPP`; may be fractional |
| `RATE_<CHANNEL>_BURST` | `sms` 40, `email` 50, `whatsapp` 10 | Bucket size |
| `RATE_URGENT_SHARE` | `0.2` | Share of the quota only urgent sends can use; `0 < share < 1` |
| `RATE_LIMIT_DEFER_MS` | `250` | Wait before a rate-limited job is retried (plus up to 50% jitter); the attempt is not counted |
| `PROVIDER_TIMEOUT_MS` | `10000` | Cap on every vendor call; a timeout is a retryable failure |
| `URGENT_DEFAULT_DEADLINE_S` | `600` | An urgent job older than this is expired unsent, never dead-lettered |
| `EMAIL_FROM_ADDRESS` | — | Sender address for `/v1/notify` email; unset, every v1 email delivery fails permanently with `email sender not configured` |
| `EMAIL_FROM_NAME` | `EMAIL_FROM_ADDRESS` | Sender display name for `/v1/notify` email |
| `NS_RESOLVE_CACHE_TTL_MS` | `60000` | Age after which a cached template/policy is refreshed in the background; positive integer |

An invalid value in any of these exits the worker at boot rather than dropping jobs later. Urgent
sends take the shared quota first, then the reserved share; normal and bulk use the shared quota only.

A normal or bulk send that cannot be recorded returns
`503 {"error": "audit store unavailable"}` and its idempotency claim is released,
so retrying the same request is accepted. Urgent sends are queued first and
recorded best-effort (recipients and variable names only).
If Redis loses its data, NS re-queues recoverable open sends from Postgres at
boot; this needs `INFO` allowed on Redis.

## Mail Transport

`channel=email` picks its transport from the environment, in this order. The
first match wins and nothing else is consulted:

| Set this | Transport |
| --- | --- |
| `SMTP_AWS_SES=true` | AWS SESv2 API (`AWS_REGION` + `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`) |
| `SMTP_HOST=<host>` | That SMTP server — Gmail, Zoho, Mailgun, a self-hosted relay, an SES SMTP endpoint |

Nothing set is a startup-time misconfiguration that only surfaces on the first
send, so the error names all three.

SMTP connection variables:

| Variable | Default | Notes |
| --- | --- | --- |
| `SMTP_HOST` | — | Selects the SMTP transport. |
| `SMTP_PORT` | `587` | |
| `SMTP_SECURE` | `true` on port 465, else `false` | Implicit TLS from the first byte. On 587 the session opens plaintext and nodemailer upgrades it with STARTTLS, so `false` there is correct, not insecure. |
| `SMTP_USER` | — | |
| `SMTP_PASS` | — | `auth` is omitted entirely when either half is missing, for an unauthenticated relay. |
| `SMTP_FROM` | — | Fixed envelope sender; see below. |

**Which address mail is sent from.** Normally `EMAIL_FROM_ADDRESS`, with
`EMAIL_FROM_NAME` as the display name. Two exceptions:

- `SMTP_FROM`, when set, replaces it for every message. Use this with a relay
  that only accepts one sender identity.
- Gmail replaces it with the authenticated account, because Gmail rewrites or
  rejects a `From` that is not the mailbox that authenticated. Other providers
  do not have that constraint, and their SMTP username is frequently not a
  mailbox at all (`postmaster@mg.example`, an SES `AKIA…` key id) — putting it
  in the `From` header would be wrong, so they keep `EMAIL_FROM_ADDRESS`.

**Gmail is not a special case.** Point `SMTP_HOST` at `smtp.gmail.com` with
`SMTP_PORT=465`, `SMTP_SECURE=true` and an App Password in `SMTP_PASS`. The
`SMTP_GMAIL`, `GMAIL_USER` and `GMAIL_PASS` variables this service used to read
were removed along with the hardcoded endpoint they selected (#112); they are
ignored if a stale values file still sets them.

## Testing

```bash
pnpm test              # unit suite (vitest) — no Docker/Redis; Redis is faked in-process
pnpm test:integration  # integration suite — needs a real Redis and Postgres
                       # the local env is in the header of vitest.integration.config.ts
```

CI (`ci.yaml`) runs a frozen install, `pnpm build` (which is `tsc`, so also the
type-check), then `pnpm test` on every PR/push; the GHCR image build + Trivy scan
run on `main`/`feature`/tags. See `CLAUDE.md` for the in-memory fake's contract
and what each suite covers.

## API Docs

With `NS_DOCS_ENABLED=true` (set in `example.env` for local development; off by
default), open the Scalar reference:

```text
GET /
```

The OpenAPI document used by Scalar is available at:

```text
GET /openapi.json
```

## Endpoint Summary

Every endpoint below except `GET /metrics`, `GET /` and `GET /openapi.json` requires
authentication (a bearer token or HMAC v2 headers; see [Authentication](#authentication)).

```text
GET  /                    # Scalar API reference HTML
GET  /openapi.json        # OpenAPI document
POST /v1/notify           # Send API v1: policy-routed or template-key send
GET  /providers           # Configured provider per channel: name, vendor, renders
GET  /providers/:name     # One channel's provider
GET  /metrics/queue       # Queue depths and retry/DLQ metrics
POST /failed/retry        # Requeue jobs from the DLQ
```

The admin API under `/v1/admin/` is listed in [Admin API](#admin-api).

## Admin API

Templates and routing policies are managed over HTTP. Every route needs the
`templates:admin` scope, held by an HMAC key whose `scopes` entry lists it or by a bearer
token carrying that role (otherwise `403 Insufficient scope`).
`NS_NETWORK` must be set (otherwise `503 network_not_configured`). A database failure answers
`503 database_unavailable`; the query and its parameters are never logged or returned. Request bodies are strict:
unknown keys return `400`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/admin/templates` | List (`channel`, `template_key`, `status` filters) |
| POST | `/v1/admin/templates` | Create a draft (`201`) |
| GET | `/v1/admin/templates/:id` | Fetch one |
| PATCH | `/v1/admin/templates/:id` | Edit a draft |
| POST | `/v1/admin/templates/:id/publish` | Validate, activate, retire the previous active version |
| POST | `/v1/admin/templates/:id/retire` | Retire (`409 template_in_use` while an active policy needs it) |
| POST | `/v1/admin/templates/:id/preview` | Render with `{ "variables": {...} }`; any status, sends nothing |
| GET | `/v1/admin/policies` | List (`domain`, `event_type`, `status` filters) |
| POST | `/v1/admin/policies` | Create a draft (`201`) |
| GET | `/v1/admin/policies/:id` | Fetch one |
| PATCH | `/v1/admin/policies/:id` | Edit a draft |
| POST | `/v1/admin/policies/:id/publish` | Activate (every channel must resolve to an active template for the current vendor, default locale) |
| POST | `/v1/admin/policies/:id/retire` | Retire |

Errors: `404 not_found`, `409 invalid_state` (active and retired rows are immutable; create a new
draft), `409 template_in_use` (retiring a template an active policy still resolves to; publish a
replacement or retire the policy first), `422` for any other rule violation (`error` holds the code, `message` names variables and
never their values).

Create, preview and publish an email template:

```bash
KEY_ID="admin-key"        # its internal-secrets.json entry lists "templates:admin"
SECRET="ns_admin_secret"
BASE=http://localhost:3000

# Signs v2: METHOD, PATH, timestamp, nonce and the SHA-256 of the body, as in "Signed cURL Example".
# The signed path is the full request URL as sent, including any query string
# (matters for list endpoints, e.g. /v1/admin/templates?status=active).
# The body is the last argument; bodyless POSTs (publish, retire) send '{}'.
ns_curl() {
  local METHOD="$1" REQ_PATH="$2" BODY="${3:-}"
  local TS=$(date +%s) NONCE=$(openssl rand -hex 16)
  local DIGEST=$(printf "%s" "$BODY" | openssl dgst -sha256 | sed 's/^.* //')
  local SIG="v2=$(printf "%s\n%s\n%s\n%s\n%s" "$METHOD" "$REQ_PATH" "$TS" "$NONCE" "$DIGEST" | \
    openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"
  curl -sS -X "$METHOD" "$BASE$REQ_PATH" -H "Content-Type: application/json" \
    -H "X-NS-Key: $KEY_ID" -H "X-NS-Timestamp: $TS" -H "X-NS-Nonce: $NONCE" \
    -H "X-NS-Signature: $SIG" ${BODY:+--data-binary "$BODY"}
}

ID=$(ns_curl POST /v1/admin/templates '{
  "channel": "email",
  "template_key": "welcome",
  "subject": "Welcome, {{name}}",
  "body_html": "<p>Hello {{name}}, <a href=\"{{link}}\">get started</a></p>",
  "variables": [
    { "name": "name" },
    { "name": "link", "type": "url", "urlHosts": ["example.com"] }
  ]
}' | jq -r .id)

ns_curl POST "/v1/admin/templates/$ID/preview" \
  '{"variables": {"name": "Asha <b>", "link": "https://app.example.com/start"}}'

ns_curl POST "/v1/admin/templates/$ID/publish" '{}'
```

Email variables are HTML-escaped unless declared `raw: true`. Variable `type` is `string`,
`number` or `url`; a `url` must be `http(s)` and, with `urlHosts`, on an allowed host
(subdomains match). A variable used inside an `href` or `src` attribute must be `type: "url"`,
and publish rejects malformed tokens such as `{{ name }}`.

### Shared content (`content_ref`)

A variable can take its value from a shared content file, such as the current terms link, instead of
from the caller. Declare `source: "content_ref"` and a `contentKey`:

```json
{ "name": "tnc_url", "type": "url", "source": "content_ref", "contentKey": "tnc.in_force.url", "urlHosts": ["example.com"] }
```

The file named by `NS_CONTENT_FILE`:

```json
{
  "version": "2026-10-01",
  "entries": {
    "tnc.in_force.url": { "en": "https://example.com/terms/v3", "hi": "https://example.com/hi/terms/v3" }
  }
}
```

A body of `Read the terms: {{tnc_url}}` for an `hi-IN` template renders
`Read the terms: https://example.com/hi/terms/v3` (the locale chain is `hi-IN`, `hi`, then
`NS_DEFAULT_LOCALE`). Content resolves when the send is accepted, and the event records each channel's
`content_refs` (`key`, `version`, `locale`, and `fingerprint`: the first 12 hex of the sha256 of the
value, so a ref pins the exact text even if the file was edited without a version bump). A `content_ref` variable is always required, cannot be
`sensitive`, and cannot be supplied by the caller (`422 unknown_variable`). A missing key or locale, an
invalid value, or no loaded content refuses the send with a configuration `422`
(`content_unavailable`, `unknown_content_key`, `content_unresolved`, `invalid_content`). The file is
re-read every `NS_CONTENT_RELOAD_MS`; a bad file keeps the last good version and increments
`ns_content_load_failures_total`, and `ns_content_loaded{version,fingerprint}` holds the time of the
latest successful load.


### Catalogue

`NS_SEED_FILE` names a JSON file of templates and policies. At boot, each entry whose key has no
row of any status is created and published; existing rows are never changed, so admin edits survive
restarts. Entries use the admin create bodies plus `provider` on a template. SMS and WhatsApp entries
must name their `provider`; only email entries may omit it, and those seed for the deployment's email
vendor. An entry for a vendor this deployment does not use is skipped. An entry that fails publish
validation stays a draft and is logged by code; publish it through the admin API. A template with a
`content_ref` variable publishes only if content is loaded at its first boot; otherwise it, and any
policy that lists it, stays a draft, so publish them through the admin API once content loads.
Seeding never blocks the boot, and the file is read only at boot.

```json
{
  "version": "2026-10-06",
  "templates": [
    { "channel": "email", "template_key": "item.paused", "subject": "Paused",
      "body_html": "<p>Hi {{name}}</p>", "variables": [{ "name": "name" }] }
  ],
  "policies": [
    { "domain": "seeker", "event_type": "item.paused", "mode": "first_available",
      "channels": [{ "channel": "email", "template_key": "item.paused" }] }
  ]
}
```

`GET /v1/admin/export` returns the active templates and policies of the network in this format,
without ids or timestamps, so it can seed another environment. Output is sorted, so two exports of
one store are identical apart from `version`, the export timestamp. A store that does not fit the
format (for example more than 500 active templates) answers `422 export_invalid`, naming paths only:

```bash
curl -s -H "Authorization: Bearer $TOKEN" https://ns.example.com/v1/admin/export > catalogue.json
```

## Queue Model

The service uses four Redis structures:

```text
queue:realtime  # high-priority jobs
queue:other     # normal/lower-priority jobs
queue:retry     # delayed retry sorted set
queue:dlq       # dead-letter queue
```

Workers check `queue:realtime` first, but only block for a short window. That
prevents `queue:other` and due retries from being starved when no realtime jobs
are arriving.

Processing order inside the worker loop:

1. Try one realtime job.
2. Process any due retry jobs.
3. Try one normal `other` job.
4. Sleep briefly when no work is available.

Failed sends are retried with exponential backoff. After the maximum retry
count, the job is written to `queue:dlq`.

## Authentication

A request carries **one** of two credential types. An `Authorization` header together
with any of the four HMAC headers is `401 Ambiguous credentials`.

### HMAC v2 signing

Headers: `X-NS-Key` (key id), `X-NS-Timestamp` (unix seconds, within 30 s of the
server), `X-NS-Nonce` (unique per request) and `X-NS-Signature: v2=<64 lowercase hex>`.

The signature is HMAC-SHA256 with the key's secret over:

```text
METHOD\npath\ntimestamp\nnonce\nsha256(body)
```

- `path` is the request URL exactly as sent, including the query string.
- `sha256(body)` is lowercase hex over the exact body bytes, or over the empty string when
  there is no body.
- JSON (`application/json`) is the only accepted body type; any other content type is `415`.
  Every accepted body is covered by the signature.
- A nonce is accepted once; a correctly signed repeat is `401 Replay detected`.
- A bodyless POST (publish, retire, `POST /failed/retry`) sends no `Content-Type` header, or
  sends the body `{}` with `Content-Type: application/json`. An empty body declared as JSON is `400`.

Node example (a JSON body; `fetch` sends the same bytes that were signed, and no
`Content-Type` when there is no payload):

```js
import crypto from 'node:crypto';

const BASE = 'http://localhost:3000';
const KEY_ID = 'jobstack';
const SECRET = process.env.NS_SECRET;

async function signedRequest(method, path, payload) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  const canonical = [method, path, ts, nonce, digest].join('\n');
  const mac = crypto.createHmac('sha256', SECRET).update(canonical).digest('hex');
  return fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      'X-NS-Key': KEY_ID,
      'X-NS-Timestamp': ts,
      'X-NS-Nonce': nonce,
      'X-NS-Signature': `v2=${mac}`,
    },
    body: body || undefined,
  });
}
```

Every route requires `v2=` signatures with the body digest.

### Keys and scopes

`INTERNAL_SECRETS_JSON` names a JSON file of signing keys:

```json
{
  "jobstack": { "secret": "ns_jobstack_secret-key" },
  "ops": { "secret": "ns_ops_secret-key", "scopes": ["notify:send", "templates:admin"] }
}
```

`scopes` is optional and defaults to `["notify:send"]`. An entry whose `secret` is the empty
string is skipped with a boot warning naming its key id; any other malformed entry fails the boot.

| Scope | Routes |
|---|---|
| `notify:send` | `POST /v1/notify` |
| `templates:admin` | `/v1/admin/templates*`, `/v1/admin/policies*`, `GET /v1/admin/export`, `POST /failed/retry` |
| any authenticated | `GET /providers`, `GET /providers/:name`, `GET /metrics/queue` |

A missing scope is `403 {"error":"Insufficient scope","required":"<scope>"}`. `GET /metrics`
needs no credentials.

### Bearer tokens

Set `NS_KEYCLOAK_ISSUER` (exactly the token `iss`, no trailing slash) and
`NS_AUTH_ALLOWED_AZP` to accept Keycloak access tokens. The token must carry
`aud` = `NS_AUTH_AUDIENCE` (default `notification-service`) and an `azp` on the allowlist.
Grant the `notification-service` client roles `notify:send` and `templates:admin` to the
caller; the role grant adds the audience, so no client definition changes. A bad token is
`401`; a Keycloak key set that cannot be reached is `503`.

### Upgrade notes

- `POST /failed/retry` now needs `templates:admin`. A key with only `notify:send` gets `403`;
  add `"templates:admin"` to the operator key's `scopes`.
- The admin key-id environment list is removed. Grant admin access through `scopes` in the secrets file instead.
- Audit `source` and admin `created_by`/`published_by` are now `hmac:<keyId>` or
  `bearer:<id>`. Rows written earlier keep the bare key id.
- Every route requires `v2=` signatures with the body digest.
- Send through `POST /v1/notify`, by `event_type` or `template_key`. `GET /providers`
  returns `{name, vendor, renders}` per channel.

## Send API v1

```text
POST /v1/notify
```

Send by `event_type` (a published policy picks the channels) or by `template_key` plus `channel`.
Content is rendered and validated before the request is accepted. The network and the email sender
(`EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME`) are server configuration, never request fields; unknown
keys return `400`.

```json
{
  "event_type": "login_otp",
  "to": { "phone": "+918888888888" },
  "variables": { "message": "987654" },
  "priority": "urgent",
  "idempotency_key": "login-8f3a"
}
```

```json
{
  "notification_event_id": "7b0e5c1e-...",
  "correlation_id": "7b0e5c1e-...",
  "status": "accepted",
  "mode": "first_available",
  "deliveries": [{ "channel": "sms" }]
}
```

| Field | Rule |
|---|---|
| `event_type` / `template_key` | Exactly one. `template_key` needs `channel`; `event_type` forbids it |
| `to` | `email` and/or E.164 `phone`; at least one |
| `variables` | Checked against the planned templates' contracts |
| `priority` | `urgent`, `normal` (default) or `bulk` |
| `idempotency_key` | 1-128 chars. A repeat returns `200` with the original response |
| `deadline` | ISO-8601 with offset, in the future, at most 24 h ahead |
| `cc`, `reply_to`, `attachments` | Email only. `attachments` items are `{filename, contentType, data}` (base64); see [Email attachments](#email-attachments) |
| `correlation_id` | Optional, trimmed, at most 128 chars. Wins over the `x-correlation-id` header; blank falls back to the header, then the event id |

| Status | Meaning |
|---|---|
| `200` | Repeat of an `idempotency_key`: the original response |
| `202` | Accepted; delivery is asynchronous |
| `400` | Invalid request or `invalid_deadline` |
| `401` | Missing, malformed or invalid credentials |
| `403` | The credential lacks `notify:send` |
| `409` | `idempotency_in_progress`; `idempotency_key_priority_mismatch` (the key was used at another priority in the last 15 minutes); or `duplicate-fallback` (same content within 5 s and no key) |
| `422` | `{ error, kind, message, details? }`; `kind` is `caller` or `configuration` |
| `503` | `network_not_configured`; `template store unavailable` (a template or policy not yet cached could not be read); `audit store unavailable` (normal/bulk); `idempotency_store_unavailable` (the idempotency claim or the duplicate guard could not be checked; nothing was sent); or the Keycloak key set could not be reached for a bearer token |

`422` codes. `caller`: `missing_variable`, `unknown_variable`, `invalid_variable`,
`no_reachable_channel`. `configuration`: `not_found`, `vendor_mismatch`, `incomplete_template`,
`body_too_long`, `unknown_channel`, `no_policy`, `content_unavailable`, `unknown_content_key`,
`content_unresolved`, `invalid_content`. Messages name variables, never their values.

Urgent sends and sends using a template with a `sensitive` variable are redacted: only variable names
are stored, and they are never dead-lettered. See `CLAUDE.md` (Send API v1) for planning, fallthrough,
deadline and idempotency rules.

### Email attachments

Email deliveries accept an optional top-level `attachments` array:

```json
{
  "template_key": "complaint_received",
  "channel": "email",
  "to": { "email": "support@example.com" },
  "variables": { "name": "Asha" },
  "attachments": [
    { "filename": "evidence.png", "contentType": "image/png", "data": "<base64>" }
  ]
}
```

`data` is base64 with no `data:` prefix. Two limits apply, both env-configurable:
`NOTIFY_ATTACHMENT_MAX_FILES` (default 3) and `NOTIFY_ATTACHMENT_MAX_TOTAL_BYTES`
(default 5 MB, decoded). A request within both limits is accepted; one over either
is answered `400` and nothing is queued. The HTTP `bodyLimit` on `/v1/notify` (every
other route keeps Fastify's 1 MB default) is derived from the byte budget (base64
inflates payloads by 4/3, plus envelope headroom), so raising the cap needs no
second config change; `NOTIFY_BODY_LIMIT_BYTES` overrides it if you need to.

Operational notes:

- The service enforces count and size, which are its own resource limits. Content-type
  policy belongs to the calling product.
- A credential with `notify:send` can attach files to mail sent from the organisation's
  sending identity. Grant `notify:send` accordingly, and keep attachment scanning enabled
  on recipient mailboxes.
- An attachment-bearing job is JSON-serialised into the Redis queue like any other, so a
  5 MB attachment occupies roughly 6.7 MB of Redis (base64) until delivery, including
  time spent in the retry set or DLQ. Size Redis for the attachment traffic you expect.
- `MAIL_LOG=true` logs attachment filenames, content types and encoded sizes, never the
  content itself.
- Transport ceilings apply on top of these limits: SES caps a message at 10 MB **after**
  base64 inflation, so about 7 MB of original file is the practical maximum.

### Idempotency and duplicates

Send an `idempotency_key` to make a send safe to retry. The first request is processed;
a repeat returns `200` with the original response, and a repeat while the first is still
in flight is `409 {"error":"idempotency_in_progress"}`. Urgent keys are held for
15 minutes; normal and bulk keys for 90 days.

Without a key, a byte-identical request repeated within 5 seconds is answered
`409 {"error":"duplicate-fallback"}` and nothing is sent. Use an `idempotency_key` for
deliberate retries.

## Provider Discovery

```text
GET /providers
GET /providers/:name     # email, sms or whatsapp
```

Both routes require authentication (any scope). Each entry names the channel, the vendor
configured for it in this deployment, and who renders the message text:

```json
[
  { "name": "email", "vendor": "smtp", "renders": "ns" },
  { "name": "sms", "vendor": "msg91", "renders": "provider" },
  { "name": "whatsapp", "vendor": "twilio", "renders": "provider" }
]
```

- `renders: "ns"` — the service renders the stored template body (email, Pinnacle SMS).
- `renders: "provider"` — the service sends the template's `provider_template_id` with the
  validated variables, and the vendor renders its registered template (MSG91 Flow, Twilio
  Content).

`GET /providers/sms` returns the single `sms` entry; an unknown name is `404`.

## Request Examples

Email, by template:

```json
{
  "template_key": "welcome",
  "channel": "email",
  "to": { "email": "user@example.com" },
  "variables": { "name": "Asha" },
  "reply_to": "support@example.com"
}
```

SMS OTP, by event (the published policy picks the channel):

```json
{
  "event_type": "login_otp",
  "to": { "phone": "+918888888888" },
  "variables": { "message": "987654" },
  "priority": "urgent"
}
```

WhatsApp, by template:

```json
{
  "template_key": "application_update",
  "channel": "whatsapp",
  "to": { "phone": "+918888888888" },
  "variables": { "name": "Asha" }
}
```

Every template is a catalogue or admin-API template for the deployment's network; see
[Admin API](#admin-api) and [Catalogue](#catalogue).

### SMS vendors

**One SMS vendor per deployment, selected by `SMS_PROVIDER`**: `msg91` (default) or
`pinnacle`. An unknown name fails the boot. Both register as channel `sms`, so callers
are identical either way. Each SMS template names its vendor in `provider`, and a
template is sent only by the vendor it names.

| | MSG91 Flow | Pinnacle JSON |
| --- | --- | --- |
| `renders` | `provider` | `ns` |
| What is sent | the template's flow id (`provider_template_id`) + named variables | the rendered template body |
| Who renders the body | MSG91, from the DLT template | this service, from the stored body |
| DLT metadata | held in the flow | the template's DLT ids (`sender_id`, `dlt_entity_id`, …), falling back to `PINNACLE_*` env |
| Errors | HTTP status | HTTP 200 with `code: EC1xxx` in the body |

- **MSG91.** Each variable is sent as an MSG91 recipient variable. A template whose only
  variable is `message` sends it as MSG91's `##var##` placeholder. A variable named
  `mobiles` never overrides the recipient phone.
- **Pinnacle.** The stored body must be **byte-identical** to the DLT-approved text,
  because the operator matches on it. `PINNACLE_API_KEY`, `PINNACLE_SENDER_ID` and
  `PINNACLE_DLT_ENTITY_ID` are required when `SMS_PROVIDER=pinnacle`; see `example.env`.

**`login_otp` seeding.** At boot the SMS `login_otp` template is created for the current
vendor from explicit configuration, unless one already exists for that vendor:

- msg91: `SMS_LOGIN_OTP_TEMPLATE_ID` (the flow id).
- pinnacle: `PINNACLE_LOGIN_OTP_TEMPLATE_ID` (the DLT template id) with the body
  `SMS_LOGIN_OTP_BODY`. Without a body the template is created as a draft.

With no id configured, nothing is seeded. Set the id before the first boot with a
catalogue (`NS_SEED_FILE`), so the catalogue's OTP policies can publish.

## Queue Metrics

```text
GET /metrics/queue
```

This route requires authentication (any scope).

Example response:

```json
{
  "status": "ok",
  "timestamp": 1765363200000,
  "queues": {
    "realtime": 0,
    "other": 0,
    "retry_count": 0,
    "retry_oldest": null,
    "retry_eta_seconds": null,
    "dlq": 0
  }
}
```

## Manually Retry Failed Jobs

Failed jobs in `queue:dlq` can be requeued manually:

```text
POST /failed/retry
```

This route requires the `templates:admin` scope, because replaying the dead-letter queue
re-sends other callers' messages. A sending-only credential gets `403`.

Retry one failed job by `job_id`:

```json
{
  "job_id": "uuid",
  "priority": "other"
}
```

Retry a batch of failed jobs:

```json
{
  "limit": 10,
  "priority": "realtime"
}
```

Fields:

- `job_id`: optional. When present, only that DLQ job is retried.
- `limit`: optional batch size when `job_id` is omitted. Defaults to `1`, max
  `100`.
- `priority`: optional destination queue, either `realtime` or `other`. Defaults
  to `other`.

Manual retry resets the job attempt count to `0` and moves the job from
`queue:dlq` back into the selected queue.

When `job_id` is provided and the job is not present in `queue:dlq`, the API
returns `404`. When retrying a batch, malformed DLQ entries are counted as
`skipped`. Each replay is counted on the job, and a job that has already been
replayed 3 times is left in the DLQ and listed in `refused`; the rest of the
batch still proceeds.

Response:

```json
{
  "retried": ["uuid"],
  "retried_count": 1,
  "skipped": 0,
  "refused": [],
  "not_found": []
}
```

## Signed cURL Example

```bash
KEY_ID="jobstack"
SECRET="ns_jobstack_secret-key"

METHOD="POST"
REQ_PATH="/v1/notify"
TIMESTAMP=$(date +%s)
NONCE=$(openssl rand -hex 16)
BODY='{"template_key":"welcome","channel":"email","to":{"email":"test@example.com"},"variables":{"name":"Asha"}}'

DIGEST=$(printf "%s" "$BODY" | openssl dgst -sha256 | sed 's/^.* //')
SIGNATURE="v2=$(printf "%s\n%s\n%s\n%s\n%s" "$METHOD" "$REQ_PATH" "$TIMESTAMP" "$NONCE" "$DIGEST" | \
  openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"

curl -X POST "http://localhost:3000$REQ_PATH" \
  -H "Content-Type: application/json" \
  -H "X-NS-Key: $KEY_ID" \
  -H "X-NS-Timestamp: $TIMESTAMP" \
  -H "X-NS-Nonce: $NONCE" \
  -H "X-NS-Signature: $SIGNATURE" \
  --data-binary "$BODY"
```

For a request without a body (a `GET`), sign the digest of the empty string and send
no body. Example for provider discovery:

```bash
METHOD="GET"
REQ_PATH="/providers"
TIMESTAMP=$(date +%s)
NONCE=$(openssl rand -hex 16)

DIGEST=$(printf "" | openssl dgst -sha256 | sed 's/^.* //')
SIGNATURE="v2=$(printf "%s\n%s\n%s\n%s\n%s" "$METHOD" "$REQ_PATH" "$TIMESTAMP" "$NONCE" "$DIGEST" | \
  openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"

curl http://localhost:3000/providers \
  -H "X-NS-Key: $KEY_ID" \
  -H "X-NS-Timestamp: $TIMESTAMP" \
  -H "X-NS-Nonce: $NONCE" \
  -H "X-NS-Signature: $SIGNATURE"
```

## Adding A Provider

Create a provider folder:

```text
src/lib/providers/push/
```

Add an index file:

```ts
export { pushProvider } from './push';
```

Implement the provider:

```ts
import { ProviderDefinition } from '../../../types/provider';

export const pushProvider: ProviderDefinition = {
  name: 'push',          // the channel name callers use

  // The vendor behind this channel, and who renders templates: 'ns' renders the
  // stored body here, 'provider' sends a template id plus variables.
  vendor: 'fcm',
  renders: 'provider',

  // Sends content the service already rendered and validated at accept time.
  // With renders: 'provider', `providerTemplateId` names the vendor's template.
  async sendRendered({ to, rendered, providerTemplateId }) {
    console.log(to, rendered, providerTemplateId);
    return { ok: true };
  },
};
```

Provider folders are auto-loaded by `src/lib/providers/index.ts`. The provider
`name` becomes a `channel` value for `/v1/notify`, and templates for the channel
name `vendor` in their `provider` field. Return `retryable: false` for a failure
that a retry cannot fix (an unknown template id, for example), so the job is
dead-lettered on its first attempt.
