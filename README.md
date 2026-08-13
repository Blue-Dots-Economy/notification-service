# Notification Service

A Fastify notification service for queueing provider-agnostic email, SMS, and
WhatsApp messages. Requests are validated up front, written to Redis, and then
processed asynchronously by a worker.

## What It Does

- Accepts notifications through one `POST /notify` API.
- Supports provider-specific templates and variable schemas.
- Exposes provider metadata with complete request payload examples.
- Uses Redis lists for realtime and lower-priority work.
- Uses a Redis sorted set for delayed retries.
- Deduplicates repeated requests for a short window.
- Sends failed jobs to a dead-letter queue after retry exhaustion.
- Serves Scalar API docs at `/`.

## Project Layout

```text
src/
├─ app.ts                    # Fastify app bootstrap and route registration
├─ server.ts                 # API startup and worker spawn
├─ routes/
│  ├─ docs.ts                # Scalar docs and OpenAPI JSON
│  ├─ metrics.ts             # Queue metrics route
│  ├─ notify.ts              # Notification enqueue route
│  ├─ providers.ts           # Provider discovery routes
│  └─ retry.ts               # Manual failed-job retry route
├─ lib/
│  ├─ queue.ts               # Redis queues, retries, DLQ helpers
│  ├─ worker.ts              # Background job processor
│  ├─ utils/
│  │  ├─ openapi.ts          # OpenAPI document builder
│  │  └─ provider-docs.ts    # Provider payload/schema serialization
│  └─ providers/             # Provider implementations
└─ plugins/
   └─ request-auth.ts        # HMAC request signing guard
```

## Local Requirements

- Node.js 24+
- pnpm
- Redis 6+
- Provider credentials for the providers you enable

## Setup

```bash
pnpm install
cp example.env .env
```

Fill `.env` with the credentials required by the provider implementations.

Start Redis:

```bash
docker compose up redis
```

Start the API and worker:

```bash
pnpm dev
```

The API listens on `SERVER_PORT` or `3000` by default. `src/server.ts` also
spawns one background worker process.

## Testing

```bash
pnpm test              # unit suite (vitest) — no Docker/Redis; Redis is faked in-process
pnpm test:integration  # integration suite — needs a real Redis
                       # e.g. redis-server --port 6399 --daemonize yes; REDIS_PORT=6399 pnpm test:integration
```

CI (`ci.yaml`) runs a frozen install, `pnpm build` (which is `tsc`, so also the
type-check), then `pnpm test` on every PR/push; the GHCR image build + Trivy scan
run on `main`/`feature`/tags. See `CLAUDE.md` for the in-memory fake's contract
and what each suite covers.

## API Docs

Open the Scalar reference:

```text
GET /
```

The OpenAPI document used by Scalar is available at:

```text
GET /openapi.json
```

## Endpoint Summary

Every endpoint below requires signed auth headers.

```text
GET  /                    # Scalar API reference HTML
GET  /openapi.json        # OpenAPI document
POST /notify              # Enqueue a notification
GET  /providers           # List providers and complete payload examples
GET  /providers/:name     # Find one provider by name
GET  /metrics/queue       # Queue depths and retry/DLQ metrics
POST /failed/retry        # Requeue jobs from the DLQ
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

All API routes are protected by request signing. The request must include:

```text
X-NS-Key
X-NS-Timestamp
X-NS-Nonce
X-NS-Signature
```

The signature format is:

```text
v1=<hmac_sha256>
```

The signed base string is:

```text
METHOD
PATH
TIMESTAMP
NONCE
```

`PATH` must match the request URL path exactly as sent to Fastify. Include the
query string if the request has one.

Example secret configuration:

```json
{
  "jobstack": {
    "secret": "ns_jobstack_secret-key"
  }
}
```

## Queue A Notification

```text
POST /notify
```

Request body:

```json
{
  "channel": "email",
  "template_id": "basic_email",
  "to": "user@example.com",
  "priority": "realtime",
  "variables": {
    "fromName": "Notification Service",
    "fromEmail": "no-reply@example.com",
    "subject": "Welcome",
    "html": "<h1>Hello</h1>",
    "replyTo": "support@example.com"
  },
  "dedupe_id": "optional-client-id"
}
```

Fields:

- `channel`: provider name, such as `email`, `sms`, or `whatsapp`.
- `template_id`: public template key from the provider metadata.
- `to`: recipient address or phone number.
- `priority`: optional, either `realtime` or `other`; defaults to `other`.
- `variables`: provider-specific variables validated by that provider schema.
- `dedupe_id`: optional override for dedupe. Without it, the service dedupes by
  `channel:to:template_id`.

Response:

```json
{
  "job_id": "uuid",
  "enqueued": true
}
```

If the request is a duplicate inside the dedupe window:

```json
{
  "job_id": "uuid",
  "enqueued": false
}
```

## Provider Discovery

List all providers:

```text
GET /providers
```

This route requires signed auth headers.

Find one provider by name:

```text
GET /providers/email
GET /providers/sms
GET /providers/whatsapp
```

These routes require signed auth headers.

Provider responses include:

- `name`: provider channel name used in `/notify`.
- `templates`: public template keys mapped to provider template identifiers.
- `template_payloads`: complete `/notify` payload examples per template.
- `variables_schema`: JSON Schema for the `variables` object.
- `notify_payload`: generic complete `/notify` payload shape for the provider.

Example shape:

```json
{
  "name": "sms",
  "templates": {
    "login_otp": "6896c26d6eb66c66340e1242"
  },
  "template_payloads": [
    {
      "template_id": "login_otp",
      "provider_template_id": "6896c26d6eb66c66340e1242",
      "payload": {
        "channel": "sms",
        "template_id": "login_otp",
        "to": "+918888888888",
        "priority": "other",
        "variables": {
          "message": "string"
        }
      }
    }
  ],
  "variables_schema": {
    "type": "object"
  },
  "notify_payload": {
    "channel": "sms",
    "template_id": "<template_id>",
    "to": "+918888888888",
    "priority": "other",
    "variables": {
      "message": "string"
    }
  }
}
```

## Request Examples

Email:

```json
{
  "channel": "email",
  "template_id": "basic_email",
  "to": "user@example.com",
  "priority": "realtime",
  "variables": {
    "fromName": "Notification Service",
    "fromEmail": "no-reply@example.com",
    "subject": "Welcome",
    "html": "<h1>Hello</h1>",
    "replyTo": "support@example.com"
  }
}
```

SMS:

```json
{
  "channel": "sms",
  "template_id": "login_otp",
  "to": "+918888888888",
  "variables": {
    "message": "Your OTP is 987654"
  }
}
```

WhatsApp:

```json
{
  "channel": "whatsapp",
  "template_id": "dialflow",
  "to": "+918888888888",
  "variables": {
    "contentSid": null,
    "contentVariables": {}
  }
}
```

## Queue Metrics

```text
GET /metrics/queue
```

This route requires signed auth headers.

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

This route requires signed auth headers.

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
`skipped`.

Response:

```json
{
  "retried": ["uuid"],
  "retried_count": 1,
  "skipped": 0,
  "not_found": []
}
```

## Signed cURL Example

```bash
KEY_ID="jobstack"
SECRET="ns_jobstack_secret-key"

METHOD="POST"
PATH="/notify"
TIMESTAMP=$(date +%s)
NONCE=$(openssl rand -hex 16)

BASE_STRING="$METHOD
$PATH
$TIMESTAMP
$NONCE"

SIGNATURE="v1=$(printf "%s" "$BASE_STRING" | \
  openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"

curl -X POST http://localhost:3000/notify \
  -H "Content-Type: application/json" \
  -H "X-NS-Key: $KEY_ID" \
  -H "X-NS-Timestamp: $TIMESTAMP" \
  -H "X-NS-Nonce: $NONCE" \
  -H "X-NS-Signature: $SIGNATURE" \
  -d '{
    "channel": "email",
    "to": "test@example.com",
    "template_id": "basic_email",
    "priority": "realtime",
    "variables": {
      "fromName": "Notification Service",
      "fromEmail": "no-reply@example.com",
      "subject": "Hello",
      "html": "<h1>Hello World</h1>"
    }
  }'
```

For signed GET requests, use the same signing process with the target method and
path. Example for provider discovery:

```bash
METHOD="GET"
PATH="/providers"
TIMESTAMP=$(date +%s)
NONCE=$(openssl rand -hex 16)

BASE_STRING="$METHOD
$PATH
$TIMESTAMP
$NONCE"

SIGNATURE="v1=$(printf "%s" "$BASE_STRING" | \
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
import { z } from 'zod';
import { ProviderDefinition } from '../../../types/provider';

export const pushProvider: ProviderDefinition = {
  name: 'push',

  templates: {
    welcome: 'PUSH_TEMPLATE_1',
  },

  schema: z.object({
    title: z.string(),
    message: z.string(),
  }),

  async send({ to, template_id, variables }) {
    console.log(to, template_id, variables);
    return { ok: true };
  },
};
```

Provider folders are auto-loaded by `src/lib/providers/index.ts`. The provider
name becomes the `channel` value for `/notify`.
