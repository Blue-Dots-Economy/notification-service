# NS Stage 1 · Plan A — Persistence Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give notification-service a Postgres database on every cluster and a durable, partitioned record of every send (event + attempt with status lifecycle and trace ids), without changing the `/notify` contract callers use today.

**Architecture:** A `notification` database + role on each cluster's shared RDS, created by the existing `postgresBootstrap` job, with `pg_partman` installed into a `partman` schema. NS connects with `pg` + Drizzle, applies migrations on boot under an advisory lock before forking its worker, and keeps Redis as the dispatch queue: normal-priority sends are recorded *before* they are queued, realtime (OTP) sends are queued first and recorded fire-and-forget, and the worker stamps status best-effort. A boot-time sweep re-queues work Redis lost.

**Tech Stack:** TypeScript 7 (CommonJS output, `moduleResolution: Node16`), Fastify 5, `pg` 8, `drizzle-orm` 0.45 / `drizzle-kit` 0.31 (same versions as aggregator-dpg), PostgreSQL 17 + `pg_partman` 5, vitest 4, Helm, OpenTofu/Terragrunt.

**Spec:** `docs/superpowers/specs/2026-06-26-event-platform-design.md` (rev 2026-10-04) — §Architecture "Durability model" and "Schema migrations", §Retention and PII, §Data model, §Security, Stage 1 items 1–2. Issues: Blue-Dots-Economy/bluedots-automation#114, Blue-Dots-Economy/notification-service#56.

**Repos and branches (one branch + one PR per repo, cut from `feature`, squash-merged):**

| Repo | Branch | Tasks |
| --- | --- | --- |
| `bluedots-automation` | `feat/ns-postgres` | 1–3 |
| `notification-service` | `feat/ns-persistence` | 4–12 |
| `bluedots-e2e` | `feat/ns-postgres` | 13 |

**Rollout order (hard):** the automation PR must be merged *and* the common-services release upgraded on a cluster (so the `notification` database exists) before an NS image from `feat/ns-persistence` is deployed there. NS refuses to boot without a database (Task 4). The e2e PR merges together with the NS PR, because the e2e stack runs NS images from `feature`.

## Global Constraints

- Node ≥ 24; pnpm 10 (`packageManager: pnpm@10.24.0`); never npm/yarn.
- NS emits **CommonJS** (`package.json` has no `"type": "module"`; keep `module`/`moduleResolution: Node16`). Relative imports inside `src/` are extensionless, matching existing files (`import redis from './redis'`).
- `drizzle-orm ^0.45.2`, `drizzle-kit ^0.31.10`, `pg ^8.23.0`, `@types/pg` — the versions aggregator-dpg already runs.
- **Never hand-edit a generated migration.** Partitioned DDL cannot be expressed by drizzle-kit, so it lives in **custom** migrations created with `pnpm db:generate --custom` (an empty, journal-registered file you are meant to write). Partitioned tables are therefore **excluded** from `drizzle.config.ts`'s `schema` so `db:generate` never tries to re-create them.
- `pg_partman` lives in schema **`partman`** on every database (RDS, CI, compose, e2e). Migration SQL references `partman.` explicitly.
- Partitioned tables: monthly `RANGE` on `created_at`, `p_premake := 3`. **No retention** is configured here (partition drop is #65).
- **OTP codes are never persisted.** Realtime-priority jobs persist **no variable values** — only variable *names*.
- Audit writes from the worker are **best-effort**: a database failure never fails, delays, or re-routes a send.
- Normal-priority `/notify` is **record-before-queue**: if the record cannot be written, answer `503` and do not queue.
- Redis requires a password; the empty-password default is removed (opt-out only via `REDIS_ALLOW_NO_AUTH=true`, for local/test).
- Repo is **public**: comments, commits and PR text state requirements positively; no vulnerability narratives.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **Realtime job processed before its fire-and-forget audit insert lands** → the final status must still be recorded (monotonic upsert, Task 7; test in Task 7 step 1, `upsertAttempt applied out of order`).
- **Redis flushed / restarted without persistence while normal jobs are queued** → those jobs are re-queued exactly once on next boot, and realtime jobs are not (Task 10; tests `requeues when the epoch is missing`, `does not requeue realtime`).
- **Two replicas booting at once** → migrations applied once, both boot (Task 5; test `serialises concurrent runners`).
- **Postgres down while the API is up** → normal `/notify` returns 503 and nothing is queued; realtime `/notify` still enqueues and returns 200 (Task 8; tests `returns 503 when the record fails`, `realtime still enqueues when the audit insert fails`).
- **A send whose month has no partition yet** (premake exhausted after a long outage) → the insert must not error; pg_partman's default partition catches it and maintenance moves it (Task 6; test `insert far in the future lands in the default partition`).

---

## Part 1 — bluedots-automation (`feat/ns-postgres`, cut from `feature`)

### Task 1: Generate and plumb the `notification` role password

**Files:**
- Modify: `opentofu/aws/modules/random_passwords/main.tf` (next to `keycloak_postgres_password`, ~L59)
- Modify: `opentofu/aws/modules/random_passwords/variables.tf` (next to `keycloak_postgres_password_bytes`, ~L68)
- Modify: `opentofu/aws/modules/random_passwords/outputs.tf` (next to `keycloak_postgres_password`, ~L60)
- Modify: `opentofu/aws/modules/output-file/variables.tf` (~L289), `opentofu/aws/modules/output-file/main.tf` (~L35)
- Modify: `opentofu/aws/_common/output-file.hcl` (mock outputs ~L112, real wiring ~L162)
- Modify: `opentofu/aws/modules/output-file/global-secrets.yaml.tfpl` (~L19 `credentials`, and the `notificationService` secrets block)

**Interfaces:**
- Produces: Helm values `credentials.notificationPassword` (common-services) and `secrets.notificationService.data.DATABASE_PASSWORD` (signals umbrella → NS subchart), **the same value**.

- [ ] **Step 1: Add the random id, variable and output**

`random_passwords/main.tf`, after the `keycloak_postgres_password` resource:

```hcl
# notification-service's own Postgres role. Feeds BOTH
# credentials.notificationPassword (common-services creates/syncs the role) AND
# the NS subchart's DATABASE_PASSWORD (NS logs in) — one value, two consumers.
resource "random_id" "notification_postgres_password" {
  byte_length = var.notification_postgres_password_bytes
}
```

`random_passwords/variables.tf`:

```hcl
variable "notification_postgres_password_bytes" {
  description = "Bytes of entropy for notification-service's Postgres role password (hex-encoded, so URL/YAML safe)."
  type        = number
  default     = 32
}
```

`random_passwords/outputs.tf`:

```hcl
output "notification_postgres_password" {
  description = "notification-service's Postgres role password (credentials.notificationPassword == NS DATABASE_PASSWORD)"
  value       = random_id.notification_postgres_password.hex
  sensitive   = true
}
```

- [ ] **Step 2: Thread it through output-file**

`output-file/variables.tf`:

```hcl
variable "notification_postgres_password" {
  type      = string
  sensitive = true
}
```

`output-file/main.tf`, in the `templatefile(...)` map next to `keycloak_postgres_password`:

```hcl
    notification_postgres_password          = var.notification_postgres_password
```

`_common/output-file.hcl` — in the mock outputs block (next to the `keycloak_postgres_password` mock, ~L112):

```hcl
    notification_postgres_password          = "000000000000000000000000000000000000000000000000000000000000000e"
```

and in the inputs (~L162):

```hcl
  notification_postgres_password          = dependency.random_passwords.outputs.notification_postgres_password
```

- [ ] **Step 3: Emit it into global-secrets**

`global-secrets.yaml.tfpl`, under `credentials:` next to `keycloakPassword`:

```yaml
  notificationPassword: "${notification_postgres_password}"
```

and in the `notificationService` secrets block (the one whose `data:` carries `REDIS_PASSWORD: "${signals_redis_password}"` for notification-service):

```yaml
      DATABASE_PASSWORD: "${notification_postgres_password}"
```

- [ ] **Step 4: Verify the module plans cleanly**

Run: `cd opentofu/aws/modules/random_passwords && tofu init -backend=false && tofu validate`
Expected: `Success! The configuration is valid.`
Run: `cd ../output-file && tofu init -backend=false && tofu validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 5: Commit**

```bash
git add opentofu/aws/modules/random_passwords opentofu/aws/modules/output-file opentofu/aws/_common/output-file.hcl
git commit -m "feat(ns): generate the notification-service Postgres password

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Bootstrap the `notification` database, role and `pg_partman`

**Files:**
- Modify: `helm/common-services/values.yaml` (`postgresBootstrap`, ~L387; `credentials`, ~L345)
- Modify: `helm/common-services/templates/secrets.yaml` (`data-postgres`)
- Modify: `helm/common-services/templates/postgres-bootstrap-job.yaml`

**Interfaces:**
- Consumes: `credentials.notificationPassword` (Task 1).
- Produces: on RDS — role `notification` (LOGIN), database `notification` owned by it, schema `partman` with extension `pg_partman`, and grants letting `notification` call partman and maintain `partman.part_config`.

- [ ] **Step 1: Values**

`helm/common-services/values.yaml`, under `credentials:` next to `keycloakPassword`:

```yaml
  notificationPassword: ""  # NOTIFICATION_PG_PW — generated by random_passwords
```

Under `postgresBootstrap.databases`, append:

```yaml
    # notification-service (Stage 1 persistence). pg_partman is NOT listed under
    # `extensions`: it must live in its own `partman` schema with grants to the
    # app role, which notificationRole below handles.
    - name: notification
      owner: notification
      extensions: []
```

After `signalsExportRole`, add:

```yaml
  # Login role for notification-service, plus pg_partman in schema `partman` on
  # the `notification` database. pg_partman needs the master to create; the app
  # role then needs rights on partman's config tables and functions to register
  # and maintain its partitioned tables (partition maintenance is driven by NS,
  # so no pg_partman background worker / shared_preload_libraries is required).
  notificationRole:
    enabled: true
    name: notification
    database: notification
```

- [ ] **Step 2: Secret key**

`templates/secrets.yaml`, inside `data-postgres` `stringData`, after the keycloak block:

```yaml
  {{- if .Values.credentials.notificationPassword }}
  notification-password: {{ .Values.credentials.notificationPassword | quote }}
  {{- end }}
```

- [ ] **Step 3: Bootstrap job — env, role, partman**

In `postgres-bootstrap-job.yaml`, add to `env:` after `EXPORT_RO_PW`:

```yaml
            - name: NOTIFICATION_PW
              valueFrom:
                secretKeyRef:
                  name: data-postgres
                  key: notification-password
                  optional: true
```

Add `-v notification_pw="${NOTIFICATION_PW:-}"` to the first `psql` invocation's variable list, and after the `signalsExportRole` block (still inside that first heredoc, before the `GRANT {{ .owner }} TO CURRENT_USER` loop):

```yaml
                {{- if .Values.postgresBootstrap.notificationRole.enabled }}
                SELECT 'CREATE ROLE {{ .Values.postgresBootstrap.notificationRole.name }} LOGIN'
                  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='{{ .Values.postgresBootstrap.notificationRole.name }}')\gexec
                ALTER ROLE {{ .Values.postgresBootstrap.notificationRole.name }} WITH PASSWORD :'notification_pw';
                {{- end }}
```

After the per-database extensions loop (end of the script), add:

```yaml
              {{- if .Values.postgresBootstrap.notificationRole.enabled }}
              echo "installing pg_partman on {{ .Values.postgresBootstrap.notificationRole.database }}"
              psql -v ON_ERROR_STOP=1 -d {{ .Values.postgresBootstrap.notificationRole.database }} <<-'EOSQL'
                CREATE SCHEMA IF NOT EXISTS partman;
                CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman;
                GRANT USAGE, CREATE ON SCHEMA partman TO {{ .Values.postgresBootstrap.notificationRole.name }};
                GRANT ALL ON ALL TABLES IN SCHEMA partman TO {{ .Values.postgresBootstrap.notificationRole.name }};
                GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA partman TO {{ .Values.postgresBootstrap.notificationRole.name }};
                GRANT EXECUTE ON ALL PROCEDURES IN SCHEMA partman TO {{ .Values.postgresBootstrap.notificationRole.name }};
                GRANT TEMPORARY ON DATABASE {{ .Values.postgresBootstrap.notificationRole.database }} TO {{ .Values.postgresBootstrap.notificationRole.name }};
              EOSQL
              {{- end }}
```

- [ ] **Step 4: Verify the render**

Run:
```bash
helm template cs helm/common-services \
  --set postgres.host=db.example --set postgresBootstrap.enabled=true \
  --set credentials.postgresAdminPassword=x --set credentials.aggregatorPassword=x \
  --set credentials.dpgPassword=x --set credentials.notificationPassword=x \
  --show-only templates/postgres-bootstrap-job.yaml | grep -nE 'notification|partman'
```
Expected: lines for `NOTIFICATION_PW`, `CREATE ROLE notification`, `CREATE DATABASE notification OWNER notification`, `GRANT notification TO CURRENT_USER`, and the `partman` block.
Run: `helm lint helm/common-services` — Expected: `0 chart(s) failed`.

- [ ] **Step 5: Commit**

```bash
git add helm/common-services
git commit -m "feat(ns): bootstrap the notification database, role and pg_partman

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Point the NS subchart at the database

**Files:**
- Modify: `helm/signals/charts/notification-service/values.yaml`
- Modify: `helm/signals/charts/notification-service/templates/configmap.yaml`
- Modify: `helm/signals/values.yaml` (`notification-service:` block ~L366; `notificationService` secrets anchor ~L155)
- Modify: `opentofu/aws/modules/output-file/global-cloud-values.yaml.tfpl` (signals section, next to `search.postgres.host`)
- Modify: `helm/CLAUDE.md` (the NS env section, ~L142)

**Interfaces:**
- Produces: NS container env `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USER`, `DATABASE_SSL` (ConfigMap) and `DATABASE_PASSWORD` (Secret) — exactly the names Task 4's `loadDbConfig` reads.

- [ ] **Step 1: Subchart values + ConfigMap**

`charts/notification-service/values.yaml`, after the `redis:` block (add one if absent at subchart level, mirroring it):

```yaml
# Shared per-cluster Postgres (RDS). Database + role are created by the
# common-services postgresBootstrap job; the password arrives as the
# DATABASE_PASSWORD secret. NS migrates its own schema on boot.
postgres:
  enabled: true
  host: ""
  port: 5432
  database: notification
  user: notification
  # disable | require. Matches how the other services connect to the shared RDS.
  ssl: disable
```

`templates/configmap.yaml`, after the `redis.enabled` block:

```yaml
  {{- if .Values.postgres.enabled }}
  {{- if not .Values.postgres.host }}
  {{- fail "notification-service: postgres.enabled but postgres.host is empty. Set it (opentofu writes it to global-cloud-values.yaml) or disable postgres." }}
  {{- end }}
  DATABASE_HOST: {{ .Values.postgres.host | quote }}
  DATABASE_PORT: {{ .Values.postgres.port | quote }}
  DATABASE_NAME: {{ .Values.postgres.database | quote }}
  DATABASE_USER: {{ .Values.postgres.user | quote }}
  DATABASE_SSL: {{ .Values.postgres.ssl | quote }}
  {{- end }}
```

- [ ] **Step 2: Umbrella values**

`helm/signals/values.yaml`, in the `notificationService: &notification_service_secrets` `data:` map:

```yaml
      DATABASE_PASSWORD: ""  # == credentials.notificationPassword (common-services)
```

and in the `notification-service:` pass-through block, after `redis:`:

```yaml
  postgres:
    enabled: true
    host: ""   # set by opentofu (global-cloud-values.yaml) to the RDS endpoint
```

- [ ] **Step 3: RDS host from opentofu**

`global-cloud-values.yaml.tfpl`, beside the `search:` postgres block:

```
%{ if postgres_host != "" ~}
# notification-service subchart — managed Postgres (RDS) endpoint.
notification-service:
  postgres:
    host: ${postgres_host}
%{ endif ~}
```

- [ ] **Step 4: Verify**

Run:
```bash
helm dependency build helm/signals >/dev/null
helm template s helm/signals --set notification-service.postgres.host=db.example \
  --show-only charts/notification-service/templates/configmap.yaml | grep DATABASE_
```
Expected: five `DATABASE_*` lines with `db.example`, `5432`, `notification`, `notification`, `disable`.
Run the same without `--set ...host=` — Expected: render fails with `postgres.enabled but postgres.host is empty`.

- [ ] **Step 5: Document and commit**

In `helm/CLAUDE.md`'s notification-service env notes, add one paragraph: NS needs the `notification` database (common-services bootstrap) and `DATABASE_*` env; it migrates on boot; deploy common-services before an NS image that carries persistence; ALIMCO-TCS must move its Ansible-Vault `global-values.yaml` to SOPS before this rolls out there.

```bash
git add helm/signals helm/CLAUDE.md opentofu/aws/modules/output-file/global-cloud-values.yaml.tfpl
git commit -m "feat(ns): wire notification-service to its Postgres database

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Part 2 — notification-service (`feat/ns-persistence`, cut from `feature`)

### Task 4: Local/CI Postgres and the database config loader

**Files:**
- Create: `docker/postgres/Dockerfile`, `docker/postgres/init.sql`
- Modify: `docker-compose.yaml`, `example.env`, `.github/workflows/ci.yaml`, `vitest.integration.config.ts`
- Create: `src/lib/db/config.ts`, `src/lib/db/__tests__/config.test.ts`
- Modify: `package.json` (deps)

**Interfaces:**
- Produces: `loadDbConfig(env?: NodeJS.ProcessEnv): PoolConfig` (from `pg`). Throws `Error` whose message starts `Database not configured:` when a required var is missing.

- [ ] **Step 1: Dependencies**

Run: `pnpm add drizzle-orm@^0.45.2 pg@^8.23.0 && pnpm add -D drizzle-kit@^0.31.10 @types/pg`
Expected: `package.json` and `pnpm-lock.yaml` updated.

- [ ] **Step 2: Write the failing test**

`src/lib/db/__tests__/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadDbConfig } from '../config';

const base = {
  DATABASE_HOST: 'db',
  DATABASE_NAME: 'notification',
  DATABASE_USER: 'notification',
  DATABASE_PASSWORD: 'pw',
};

describe('loadDbConfig', () => {
  it('builds a pool config with defaults', () => {
    const cfg = loadDbConfig(base);
    expect(cfg).toMatchObject({
      host: 'db', port: 5432, database: 'notification',
      user: 'notification', password: 'pw', ssl: false, max: 10,
    });
  });

  it('names every missing variable', () => {
    expect(() => loadDbConfig({ DATABASE_HOST: 'db' })).toThrow(
      'Database not configured: missing DATABASE_NAME, DATABASE_USER, DATABASE_PASSWORD',
    );
  });

  it('enables verified TLS for DATABASE_SSL=require', () => {
    const cfg = loadDbConfig({ ...base, DATABASE_SSL: 'require' });
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('rejects an unknown DATABASE_SSL value instead of guessing', () => {
    expect(() => loadDbConfig({ ...base, DATABASE_SSL: 'prefer' })).toThrow(
      "DATABASE_SSL must be 'disable' or 'require'",
    );
  });

  it('rejects a non-numeric port', () => {
    expect(() => loadDbConfig({ ...base, DATABASE_PORT: 'abc' })).toThrow('DATABASE_PORT');
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm vitest run src/lib/db/__tests__/config.test.ts`
Expected: FAIL — `Cannot find module '../config'`.

- [ ] **Step 4: Implement**

`src/lib/db/config.ts`:

```ts
import type { PoolConfig } from 'pg';

const REQUIRED = ['DATABASE_HOST', 'DATABASE_NAME', 'DATABASE_USER', 'DATABASE_PASSWORD'] as const;

/**
 * Postgres connection settings from the environment.
 *
 * Every connection field is required rather than defaulted: a silent localhost
 * fallback would let a mis-set deployment write its audit trail somewhere else,
 * and NS refuses to start without a database at all — it is the record of what
 * was sent.
 *
 * `DATABASE_SSL` is `disable` (default — how the other services reach the shared
 * RDS today) or `require`, which verifies the server certificate against the
 * Node trust store plus any CA in `NODE_EXTRA_CA_CERTS`.
 */
export function loadDbConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`Database not configured: missing ${missing.join(', ')}`);
  }

  const port = Number(env.DATABASE_PORT ?? 5432);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`DATABASE_PORT must be a positive integer, got '${env.DATABASE_PORT}'`);
  }

  const ssl = (env.DATABASE_SSL ?? 'disable').trim().toLowerCase();
  if (ssl !== 'disable' && ssl !== 'require') {
    throw new Error(`DATABASE_SSL must be 'disable' or 'require', got '${env.DATABASE_SSL}'`);
  }

  return {
    host: env.DATABASE_HOST,
    port,
    database: env.DATABASE_NAME,
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    ssl: ssl === 'require' ? { rejectUnauthorized: true } : false,
    max: Number(env.DATABASE_POOL_MAX ?? 10),
  };
}
```

- [ ] **Step 5: Run it to see it pass**

Run: `pnpm vitest run src/lib/db/__tests__/config.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Dev/CI Postgres image with pg_partman**

`docker/postgres/Dockerfile`:

```dockerfile
# Local/CI Postgres for notification-service: stock Postgres 17 + pg_partman,
# initialised the way the common-services bootstrap provisions RDS (role,
# database, pg_partman in schema `partman`, grants). Not shipped anywhere.
FROM postgres:17-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-17-partman \
 && rm -rf /var/lib/apt/lists/*
COPY init.sql /docker-entrypoint-initdb.d/10-notification.sql
```

`docker/postgres/init.sql`:

```sql
-- Mirrors bluedots-automation helm/common-services postgres-bootstrap-job.yaml
-- (notificationRole). Keep the two in step.
CREATE ROLE notification LOGIN PASSWORD 'notification';
CREATE DATABASE notification OWNER notification;
\connect notification
CREATE SCHEMA IF NOT EXISTS partman;
CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman;
GRANT USAGE, CREATE ON SCHEMA partman TO notification;
GRANT ALL ON ALL TABLES IN SCHEMA partman TO notification;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA partman TO notification;
GRANT EXECUTE ON ALL PROCEDURES IN SCHEMA partman TO notification;
GRANT TEMPORARY ON DATABASE notification TO notification;
```

`docker-compose.yaml` — add a `postgres` service and wire NS to it:

```yaml
  postgres:
    container_name: notification-service-postgres
    build: ./docker/postgres
    environment:
      POSTGRES_PASSWORD: postgres
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U postgres -d notification']
      interval: 5s
      timeout: 3s
      retries: 20
    ports:
      - '5432:5432'
    volumes:
      - notification-service-postgres:/var/lib/postgresql/data
    networks:
      - notification-service-net
```

In the `notification-service` service: add `postgres: { condition: service_healthy }` under `depends_on`, and under `environment`:

```yaml
      DATABASE_HOST: postgres
      DATABASE_PORT: 5432
      DATABASE_NAME: notification
      DATABASE_USER: notification
      DATABASE_PASSWORD: notification
      DATABASE_SSL: disable
```

Add `notification-service-postgres: { name: notification-service-postgres }` under top-level `volumes`.

`example.env`, after the Redis lines:

```
# Postgres — required. NS records every send and refuses to start without it.
DATABASE_HOST=`DATABASE_HOST`
DATABASE_PORT=5432
DATABASE_NAME=notification
DATABASE_USER=notification
DATABASE_PASSWORD=`DATABASE_PASSWORD`
# disable | require
DATABASE_SSL=disable
```

- [ ] **Step 7: CI runs it**

`.github/workflows/ci.yaml`, in the `ci` job, before the integration-test step:

```yaml
      # Service containers cannot be built, and stock Postgres lacks pg_partman,
      # so the integration suite's Postgres is built and started here.
      - name: Start Postgres (pg_partman)
        run: |
          docker build -t ns-postgres docker/postgres
          docker run -d --name ns-postgres -e POSTGRES_PASSWORD=postgres -p 5432:5432 ns-postgres
          for i in $(seq 1 30); do
            docker exec ns-postgres pg_isready -U postgres -d notification && exit 0
            sleep 2
          done
          docker logs ns-postgres; exit 1
```

and add to the integration-test step's `env:`:

```yaml
          DATABASE_HOST: 127.0.0.1
          DATABASE_NAME: notification
          DATABASE_USER: notification
          DATABASE_PASSWORD: notification
          REDIS_ALLOW_NO_AUTH: 'true'
```

`vitest.integration.config.ts`: update the header comment's "Locally:" block to add `docker compose up -d postgres` and the `DATABASE_*` exports (same values as CI).

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml docker docker-compose.yaml example.env .github/workflows/ci.yaml vitest.integration.config.ts src/lib/db
git commit -m "feat(db): database config loader and a pg_partman Postgres for dev and CI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Drizzle client and migrate-on-boot under an advisory lock

**Files:**
- Create: `src/lib/db/client.ts`, `src/lib/db/migrate.ts`, `drizzle.config.ts`, `src/lib/db/schema.ts`
- Create: `src/lib/db/__tests__/migrate.integration.test.ts`
- Modify: `src/server.ts`, `package.json` (scripts), `Dockerfile`

**Interfaces:**
- Consumes: `loadDbConfig` (Task 4).
- Produces:
  - `getPool(): Pool`, `getDb(): NodePgDatabase`, `closeDb(): Promise<void>` (lazy singletons)
  - `migrateWithLock(db: NodePgDatabase, pool: Pool, migrationsFolder: string): Promise<void>`
  - `runMigrations(): Promise<void>` — folder `path.resolve(__dirname, '../../../drizzle')`
  - `MIGRATIONS_FOLDER: string`

- [ ] **Step 1: Client and empty kit schema**

`src/lib/db/client.ts`:

```ts
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { loadDbConfig } from './config';

let pool: Pool | undefined;
let db: NodePgDatabase | undefined;

/** The process-wide pg pool. Created on first use. */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool(loadDbConfig());
    // An idle client erroring (server restart, network blip) emits on the pool;
    // unhandled, that kills the process. Log and let the pool reconnect.
    pool.on('error', (err) => console.error('Postgres pool error:', err.message));
  }
  return pool;
}

/** The process-wide Drizzle client over getPool(). */
export function getDb(): NodePgDatabase {
  if (!db) db = drizzle(getPool());
  return db;
}

/** Close the pool. Idempotent. */
export async function closeDb(): Promise<void> {
  const p = pool;
  pool = undefined;
  db = undefined;
  if (p) await p.end();
}
```

`src/lib/db/schema.ts`:

```ts
/**
 * Tables drizzle-kit manages (db:generate diffs this file).
 *
 * Partitioned tables are deliberately NOT here — drizzle-kit cannot emit
 * PARTITION BY, so their DDL lives in custom migrations and their query-side
 * definitions in ./partitioned.ts, which drizzle.config.ts does not include.
 */
export {};
```

`drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';

const required = ['DATABASE_HOST', 'DATABASE_NAME', 'DATABASE_USER', 'DATABASE_PASSWORD'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  throw new Error(`drizzle-kit needs ${missing.join(', ')}`);
}

export default defineConfig({
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    host: process.env.DATABASE_HOST!,
    port: Number(process.env.DATABASE_PORT ?? 5432),
    database: process.env.DATABASE_NAME!,
    user: process.env.DATABASE_USER!,
    password: process.env.DATABASE_PASSWORD!,
    ssl: process.env.DATABASE_SSL === 'require',
  },
  strict: true,
  verbose: true,
});
```

`package.json` scripts, add:

```json
    "db:generate": "drizzle-kit generate",
    "db:migrate": "node dist/lib/db/migrate.js"
```

- [ ] **Step 2: Write the failing integration test**

`src/lib/db/__tests__/migrate.integration.test.ts`:

```ts
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { loadDbConfig } from '../config';
import { migrateWithLock } from '../migrate';

// A throwaway migration folder: one migration that sleeps, so two concurrent
// runners genuinely overlap, then creates a table. Without the lock the second
// runner reads "nothing applied" before the first commits and fails on
// CREATE TABLE ... already exists.
function fixtureFolder(table: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ns-mig-'));
  mkdirSync(join(dir, 'meta'));
  writeFileSync(
    join(dir, '0000_lock_probe.sql'),
    `SELECT pg_sleep(0.5);--> statement-breakpoint\nCREATE TABLE ${table} (id int);`,
  );
  writeFileSync(
    join(dir, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: [{ idx: 0, version: '7', when: Date.now(), tag: '0000_lock_probe', breakpoints: true }],
    }),
  );
  return dir;
}

const pools: Pool[] = [];
afterAll(async () => {
  // Restore the default so later files migrate into the real ledger.
  delete process.env.NS_MIGRATIONS_TABLE;
  await Promise.all(pools.map((p) => p.end()));
});

describe('migrateWithLock', () => {
  it('serialises concurrent runners so a migration applies once', async () => {
    const table = `lock_probe_${Date.now()}`;
    const folder = fixtureFolder(table);
    const run = () => {
      const pool = new Pool(loadDbConfig());
      pools.push(pool);
      return migrateWithLock(drizzle(pool), pool, folder);
    };

    // Distinct migrations table per test run so reruns start clean.
    process.env.NS_MIGRATIONS_TABLE = `__mig_${Date.now()}`;
    await expect(Promise.all([run(), run()])).resolves.toBeDefined();

    const check = new Pool(loadDbConfig());
    pools.push(check);
    const { rows } = await check.query(`SELECT to_regclass($1) AS t`, [table]);
    expect(rows[0].t).toBe(table);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm test:integration -- src/lib/db/__tests__/migrate.integration.test.ts`
Expected: FAIL — `Cannot find module '../migrate'`.

- [ ] **Step 4: Implement**

`src/lib/db/migrate.ts`:

```ts
import path from 'node:path';
import type { Pool } from 'pg';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { closeDb, getDb, getPool } from './client';

/**
 * Advisory-lock key shared by every migration runner of this service.
 *
 * Replicas boot together. Drizzle reads the applied-migration list BEFORE it
 * opens its transaction, so two unlocked runners can both decide a migration is
 * pending and the second fails (or re-applies). Same pattern as aggregator-dpg's
 * apps/api/src/db/migrate.ts.
 */
const MIGRATION_LOCK_SQL_KEY = "hashtext('notification-service:migrations')";

/** drizzle/ at the repo root — three levels up from both src/lib/db and dist/lib/db. */
export const MIGRATIONS_FOLDER = path.resolve(__dirname, '../../../drizzle');

export async function migrateWithLock(
  db: NodePgDatabase,
  pool: Pool,
  migrationsFolder: string,
): Promise<void> {
  const lockClient = await pool.connect();
  let broken: Error | undefined;
  try {
    await lockClient.query(`SELECT pg_advisory_lock(${MIGRATION_LOCK_SQL_KEY})`);
    try {
      await migrate(db, {
        migrationsFolder,
        migrationsTable: process.env.NS_MIGRATIONS_TABLE ?? '__drizzle_migrations',
      });
    } finally {
      try {
        await lockClient.query(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_SQL_KEY})`);
      } catch (err) {
        // The server drops a session lock with its connection; discard this one
        // rather than return a connection in an unknown state.
        broken = err as Error;
      }
    }
  } finally {
    lockClient.release(broken);
  }
}

/** Apply pending migrations from MIGRATIONS_FOLDER under the lock. */
export async function runMigrations(): Promise<void> {
  console.log('Applying database migrations from', MIGRATIONS_FOLDER);
  await migrateWithLock(getDb(), getPool(), MIGRATIONS_FOLDER);
  console.log('Database migrations applied');
}

if (require.main === module) {
  runMigrations()
    .then(() => closeDb())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error('Migration failed:', err);
      await closeDb().catch(() => undefined);
      process.exit(1);
    });
}
```

- [ ] **Step 5: Run it to see it pass**

Run: `pnpm test:integration -- src/lib/db/__tests__/migrate.integration.test.ts`
Expected: PASS.

- [ ] **Step 6: Boot order — migrate, then listen, then fork the worker**

`src/server.ts`:

```ts
import app from './app.js';
import { loadSecrets } from './lib/auth/secrets.js';
import { spawnWorker } from './lib/worker.js';
import { runMigrations } from './lib/db/migrate.js';

const PORT = process.env.SERVER_PORT || `3000`;

async function main() {
  loadSecrets();
  // Before listen and before the worker: nothing may read or write a table
  // whose migration has not landed. A failure here exits non-zero so the
  // orchestrator keeps the previous pod serving.
  await runMigrations();
  await app.listen({ port: parseInt(PORT) || 3000, host: '0.0.0.0' });
  spawnWorker();
  console.log(`API running on worker ${process.pid}`);
}

main().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
```

`Dockerfile` — in the runtime stage, next to the `COPY` of `dist`, add:

```dockerfile
COPY --from=build /app/drizzle ./drizzle
```

(Use the build stage's actual name and `/app` path as already used by the neighbouring `dist` copy.)

- [ ] **Step 7: Build and commit**

Run: `pnpm build && pnpm test`
Expected: tsc clean; all unit tests pass.

```bash
git add src/lib/db src/server.ts drizzle.config.ts package.json Dockerfile
git commit -m "feat(db): Drizzle client and migrate-on-boot under an advisory lock

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Partitioned `notification_event` / `delivery_attempt` and partition maintenance

**Files:**
- Create (via `pnpm db:generate --custom --name=audit_tables`): `drizzle/0000_audit_tables.sql` (+ `drizzle/meta/*`)
- Create: `src/lib/db/partitioned.ts`, `src/lib/db/maintenance.ts`
- Create: `src/lib/db/__tests__/partitions.integration.test.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Produces:
  - Drizzle tables `notificationEvent`, `deliveryAttempt` (query-side only)
  - `type EventStatus = 'accepted' | 'resolved' | 'dispatching' | 'sent' | 'delivered' | 'partially_delivered' | 'failed' | 'expired'`
  - `type AttemptStatus = 'queued' | 'dispatching' | 'sent' | 'accepted_by_provider' | 'delivered' | 'bounced' | 'failed' | 'expired'`
  - `runPartitionMaintenance(pool?: Pool): Promise<boolean>` — `true` if it ran, `false` if another replica held the lock
  - `startPartitionMaintenance(intervalMs?: number): NodeJS.Timeout`

- [ ] **Step 1: Write the failing integration test**

`src/lib/db/__tests__/partitions.integration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getPool } from '../client';
import { runMigrations } from '../migrate';
import { runPartitionMaintenance } from '../maintenance';

beforeAll(async () => {
  await runMigrations();
});
afterAll(async () => {
  await closeDb();
});

async function childPartitions(parent: string): Promise<string[]> {
  const { rows } = await getPool().query(
    `SELECT c.relname FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = $1 ORDER BY 1`,
    [parent],
  );
  return rows.map((r) => r.relname);
}

describe('audit partitions', () => {
  it.each(['notification_event', 'delivery_attempt'])(
    '%s is partitioned by month with premade future partitions and a default',
    async (table) => {
      const parts = await childPartitions(table);
      const now = new Date();
      const tag = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      expect(parts.some((p) => p.includes(tag(now)))).toBe(true);
      expect(parts.some((p) => p.includes(tag(next)))).toBe(true);
      expect(parts).toContain(`${table}_default`);
    },
  );

  it('insert far in the future lands in the default partition', async () => {
    await getPool().query(
      `INSERT INTO notification_event
         (id, created_at, correlation_id, network, source, priority, status, payload)
       VALUES (gen_random_uuid(), now() + interval '5 years', 'c', 'n', 's', 'other', 'accepted', '{}')`,
    );
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM notification_event_default`,
    );
    expect(rows[0].n).toBeGreaterThan(0);
    await getPool().query(`DELETE FROM notification_event_default`);
  });

  it('maintenance runs, and a concurrent run yields instead of blocking', async () => {
    const holder = await getPool().connect();
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtext('notification-service:partman'))`);
      await expect(runPartitionMaintenance()).resolves.toBe(false);
    } finally {
      await holder.query(`SELECT pg_advisory_unlock(hashtext('notification-service:partman'))`);
      holder.release();
    }
    await expect(runPartitionMaintenance()).resolves.toBe(true);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm test:integration -- src/lib/db/__tests__/partitions.integration.test.ts`
Expected: FAIL — `Cannot find module '../maintenance'`.

- [ ] **Step 3: Create and write the custom migration**

Run: `DATABASE_HOST=127.0.0.1 DATABASE_NAME=notification DATABASE_USER=notification DATABASE_PASSWORD=notification pnpm db:generate --custom --name=audit_tables`
Expected: `drizzle/0000_audit_tables.sql` (empty) and `drizzle/meta/_journal.json` created.

Write `drizzle/0000_audit_tables.sql`:

```sql
-- Tier-1 audit tables (spec §Retention and PII): monthly RANGE partitions on
-- created_at, managed by pg_partman (schema `partman`). Custom migration because
-- drizzle-kit cannot emit PARTITION BY; query-side definitions live in
-- src/lib/db/partitioned.ts. Retention (partition drop at 90 days) is NOT set
-- here — that is #65.
--
-- Partitioned tables cannot carry a primary key or unique constraint that omits
-- the partition key, hence PRIMARY KEY (id, created_at) and no foreign key from
-- delivery_attempt to notification_event (an FK into a partitioned table would
-- need created_at too). notification_event_id is indexed instead.
CREATE TABLE notification_event (
  id              uuid        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  correlation_id  text        NOT NULL,
  trace_id        text,
  idempotency_key text,
  event_type      text,
  template_key    text,
  network         text        NOT NULL,
  domain          text,
  source          text        NOT NULL,
  priority        text        NOT NULL,
  deadline        timestamptz,
  status          text        NOT NULL,
  payload         jsonb       NOT NULL,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
--> statement-breakpoint
CREATE INDEX notification_event_correlation_idx ON notification_event (correlation_id);
--> statement-breakpoint
CREATE TABLE delivery_attempt (
  id                    uuid        NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  notification_event_id uuid        NOT NULL,
  channel               text        NOT NULL,
  provider              text,
  template_id           text        NOT NULL,
  attempt_no            integer     NOT NULL DEFAULT 1,
  status                text        NOT NULL,
  status_rank           smallint    NOT NULL,
  recoverable           boolean     NOT NULL,
  job                   jsonb,
  provider_message_id   text,
  error                 text,
  dispatched_at         timestamptz,
  completed_at          timestamptz,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
--> statement-breakpoint
CREATE INDEX delivery_attempt_event_idx ON delivery_attempt (notification_event_id);
--> statement-breakpoint
CREATE INDEX delivery_attempt_open_idx ON delivery_attempt (status, updated_at)
  WHERE status IN ('queued', 'dispatching');
--> statement-breakpoint
SELECT partman.create_parent(
  p_parent_table := 'public.notification_event',
  p_control      := 'created_at',
  p_interval     := '1 month',
  p_premake      := 3
);
--> statement-breakpoint
SELECT partman.create_parent(
  p_parent_table := 'public.delivery_attempt',
  p_control      := 'created_at',
  p_interval     := '1 month',
  p_premake      := 3
);
```

(`create_parent` also creates the `<table>_default` partition the test expects.)

- [ ] **Step 4: Query-side tables**

`src/lib/db/partitioned.ts`:

```ts
import { boolean, integer, jsonb, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Query-side definitions of the partitioned audit tables. Their DDL is the
 * custom migration drizzle/0000_audit_tables.sql — drizzle.config.ts does not
 * include this file, so `db:generate` never tries to re-create them. Change a
 * column here AND in a new custom migration, together.
 */

export type EventStatus =
  | 'accepted' | 'resolved' | 'dispatching' | 'sent'
  | 'delivered' | 'partially_delivered' | 'failed' | 'expired';

export type AttemptStatus =
  | 'queued' | 'dispatching' | 'sent' | 'accepted_by_provider'
  | 'delivered' | 'bounced' | 'failed' | 'expired';

export const notificationEvent = pgTable('notification_event', {
  id: uuid('id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  correlationId: text('correlation_id').notNull(),
  traceId: text('trace_id'),
  idempotencyKey: text('idempotency_key'),
  eventType: text('event_type'),
  templateKey: text('template_key'),
  network: text('network').notNull(),
  domain: text('domain'),
  source: text('source').notNull(),
  priority: text('priority').notNull(),
  deadline: timestamp('deadline', { withTimezone: true }),
  status: text('status').$type<EventStatus>().notNull(),
  payload: jsonb('payload').notNull(),
});

export const deliveryAttempt = pgTable('delivery_attempt', {
  id: uuid('id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  notificationEventId: uuid('notification_event_id').notNull(),
  channel: text('channel').notNull(),
  provider: text('provider'),
  templateId: text('template_id').notNull(),
  attemptNo: integer('attempt_no').notNull().default(1),
  status: text('status').$type<AttemptStatus>().notNull(),
  statusRank: smallint('status_rank').notNull(),
  recoverable: boolean('recoverable').notNull(),
  job: jsonb('job'),
  providerMessageId: text('provider_message_id'),
  error: text('error'),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});
```

- [ ] **Step 5: Maintenance**

`src/lib/db/maintenance.ts`:

```ts
import type { Pool } from 'pg';
import { getPool } from './client';

/**
 * pg_partman maintenance, driven by NS rather than pg_partman's background
 * worker (which needs shared_preload_libraries — a cluster-wide RDS parameter
 * change for one tenant). Pre-makes future monthly partitions and moves rows
 * out of the default partition. Retention (dropping old partitions) is not
 * configured until #65, so this never drops anything today.
 *
 * Every replica runs the loop; a try-lock makes all but one skip each round.
 */
const PARTMAN_LOCK_SQL_KEY = "hashtext('notification-service:partman')";
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

export async function runPartitionMaintenance(pool: Pool = getPool()): Promise<boolean> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`SELECT pg_try_advisory_lock(${PARTMAN_LOCK_SQL_KEY}) AS got`);
    if (!rows[0].got) return false;
    try {
      await client.query(`CALL partman.run_maintenance_proc()`);
      return true;
    } finally {
      await client.query(`SELECT pg_advisory_unlock(${PARTMAN_LOCK_SQL_KEY})`);
    }
  } finally {
    client.release();
  }
}

/** Run once now, then on an interval. Failures are logged, never thrown. */
export function startPartitionMaintenance(
  intervalMs = Number(process.env.PARTITION_MAINTENANCE_INTERVAL_MS) || DEFAULT_INTERVAL_MS,
): NodeJS.Timeout {
  const tick = () =>
    runPartitionMaintenance().catch((err) =>
      console.error('Partition maintenance failed:', err instanceof Error ? err.message : err),
    );
  void tick();
  return setInterval(tick, intervalMs).unref();
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm test:integration -- src/lib/db/__tests__/partitions.integration.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Start maintenance on boot**

`src/server.ts`, in `main()` after `await runMigrations();`:

```ts
  startPartitionMaintenance();
```

with `import { startPartitionMaintenance } from './lib/db/maintenance.js';`.

- [ ] **Step 8: Commit**

```bash
pnpm build
git add drizzle src/lib/db src/server.ts
git commit -m "feat(db): partitioned audit tables with pg_partman maintenance

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: The audit store — record and monotonic status upserts

**Files:**
- Create: `src/lib/audit/store.ts`, `src/lib/audit/status.ts`
- Create: `src/lib/audit/__tests__/status.test.ts`, `src/lib/audit/__tests__/store.integration.test.ts`

**Interfaces:**
- Consumes: `getDb`, `getPool`, `notificationEvent`, `deliveryAttempt`, status types (Tasks 5–6).
- Produces:
  - `ATTEMPT_RANK: Record<AttemptStatus, number>`; `eventStatusFor(a: AttemptStatus): EventStatus`
  - `interface AuditIds { eventId: string; attemptId: string; createdAt: string /* ISO */; correlationId: string }`
  - `interface AcceptedRecord { ids: AuditIds; network: string; source: string; priority: 'realtime' | 'other'; channel: string; templateId: string; traceId?: string; payload: Record<string, unknown>; job?: Record<string, unknown>; recoverable: boolean }`
  - `recordAccepted(rec: AcceptedRecord): Promise<void>` — inserts event (`accepted`) + attempt (`queued`, attempt 1) in one transaction; `ON CONFLICT DO NOTHING` on both.
  - `upsertAttempt(rec: AcceptedRecord, update: AttemptUpdate): Promise<void>` where `interface AttemptUpdate { status: AttemptStatus; attemptNo: number; providerMessageId?: string; error?: string }` — applies only if `(attemptNo, rank)` is greater than the stored pair; inserts the rows if absent; rolls the event status forward via `eventStatusFor`.

- [ ] **Step 1: Write the failing tests**

`src/lib/audit/__tests__/status.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ATTEMPT_RANK, eventStatusFor } from '../status';

describe('status ranks', () => {
  it('orders queued < dispatching < sent < terminal', () => {
    expect(ATTEMPT_RANK.queued).toBeLessThan(ATTEMPT_RANK.dispatching);
    expect(ATTEMPT_RANK.dispatching).toBeLessThan(ATTEMPT_RANK.sent);
    expect(ATTEMPT_RANK.sent).toBeLessThan(ATTEMPT_RANK.failed);
    expect(ATTEMPT_RANK.failed).toBe(ATTEMPT_RANK.expired);
  });

  it('maps attempt status to event status', () => {
    expect(eventStatusFor('queued')).toBe('accepted');
    expect(eventStatusFor('dispatching')).toBe('dispatching');
    expect(eventStatusFor('sent')).toBe('sent');
    expect(eventStatusFor('failed')).toBe('failed');
    expect(eventStatusFor('expired')).toBe('expired');
  });
});
```

`src/lib/audit/__tests__/store.integration.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getPool } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { recordAccepted, upsertAttempt, type AcceptedRecord } from '../store';

beforeAll(async () => { await runMigrations(); });
afterAll(async () => { await closeDb(); });

function rec(): AcceptedRecord {
  return {
    ids: {
      eventId: randomUUID(), attemptId: randomUUID(),
      createdAt: new Date().toISOString(), correlationId: randomUUID(),
    },
    network: 'blue_dot', source: 'test', priority: 'other',
    channel: 'email', templateId: 'basic_email',
    payload: { to: 'a@b.c' }, job: { job_id: 'j' }, recoverable: true,
  };
}

async function read(r: AcceptedRecord) {
  const pool = getPool();
  const ev = await pool.query(`SELECT status FROM notification_event WHERE id = $1`, [r.ids.eventId]);
  const at = await pool.query(
    `SELECT status, attempt_no, provider_message_id FROM delivery_attempt WHERE id = $1`,
    [r.ids.attemptId],
  );
  return { event: ev.rows[0]?.status, attempt: at.rows[0] };
}

describe('audit store', () => {
  it('records an accepted send as event accepted + attempt queued', async () => {
    const r = rec();
    await recordAccepted(r);
    expect(await read(r)).toMatchObject({
      event: 'accepted', attempt: { status: 'queued', attempt_no: 1 },
    });
  });

  it('is idempotent on replay of the same ids', async () => {
    const r = rec();
    await recordAccepted(r);
    await expect(recordAccepted(r)).resolves.toBeUndefined();
  });

  it('moves forward and never backward within an attempt', async () => {
    const r = rec();
    await recordAccepted(r);
    await upsertAttempt(r, { status: 'sent', attemptNo: 1, providerMessageId: 'pm-1' });
    await upsertAttempt(r, { status: 'dispatching', attemptNo: 1 });
    expect(await read(r)).toMatchObject({
      event: 'sent', attempt: { status: 'sent', provider_message_id: 'pm-1' },
    });
  });

  it('a later attempt number may restart at queued', async () => {
    const r = rec();
    await recordAccepted(r);
    await upsertAttempt(r, { status: 'dispatching', attemptNo: 1 });
    await upsertAttempt(r, { status: 'queued', attemptNo: 2 });
    expect(await read(r)).toMatchObject({ attempt: { status: 'queued', attempt_no: 2 } });
  });

  it('upsertAttempt applied out of order still lands the final status', async () => {
    // Realtime: the worker finished before the fire-and-forget insert arrived.
    const r = { ...rec(), priority: 'realtime' as const, job: undefined, recoverable: false };
    await upsertAttempt(r, { status: 'sent', attemptNo: 1 });
    await recordAccepted(r);
    expect(await read(r)).toMatchObject({ event: 'sent', attempt: { status: 'sent' } });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/lib/audit` then `pnpm test:integration -- src/lib/audit`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement status**

`src/lib/audit/status.ts`:

```ts
import type { AttemptStatus, EventStatus } from '../db/partitioned';

/**
 * Rank within one attempt number. A write is applied only when
 * (attempt_no, rank) is strictly greater than what is stored, so late or
 * replayed writes can never move a record backwards — which is what makes the
 * realtime path's fire-and-forget insert safe to race the worker.
 */
export const ATTEMPT_RANK: Record<AttemptStatus, number> = {
  queued: 0,
  dispatching: 1,
  sent: 2,
  accepted_by_provider: 3,
  delivered: 4,
  bounced: 4,
  failed: 4,
  expired: 4,
};

/** Event status for a single-attempt event (all Plan A events have exactly one). */
export function eventStatusFor(a: AttemptStatus): EventStatus {
  switch (a) {
    case 'queued': return 'accepted';
    case 'dispatching': return 'dispatching';
    case 'sent':
    case 'accepted_by_provider': return 'sent';
    case 'delivered': return 'delivered';
    case 'bounced':
    case 'failed': return 'failed';
    case 'expired': return 'expired';
  }
}
```

- [ ] **Step 4: Implement the store**

`src/lib/audit/store.ts`:

```ts
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import type { AttemptStatus } from '../db/partitioned';
import { ATTEMPT_RANK, eventStatusFor } from './status';

export interface AuditIds {
  eventId: string;
  attemptId: string;
  /** ISO timestamp; part of both primary keys, so it travels with the job. */
  createdAt: string;
  correlationId: string;
}

export interface AcceptedRecord {
  ids: AuditIds;
  network: string;
  source: string;
  priority: 'realtime' | 'other';
  channel: string;
  templateId: string;
  traceId?: string;
  /** Redacted request payload. Realtime: variable NAMES only, never values. */
  payload: Record<string, unknown>;
  /** The queued job, kept only when recoverable (normal priority). */
  job?: Record<string, unknown>;
  recoverable: boolean;
}

export interface AttemptUpdate {
  status: AttemptStatus;
  attemptNo: number;
  providerMessageId?: string;
  error?: string;
}

function insertEvent(rec: AcceptedRecord, status: string) {
  return sql`
    INSERT INTO notification_event
      (id, created_at, correlation_id, trace_id, template_key, network, source, priority, status, payload)
    VALUES
      (${rec.ids.eventId}, ${rec.ids.createdAt}, ${rec.ids.correlationId}, ${rec.traceId ?? null},
       ${rec.templateId}, ${rec.network}, ${rec.source}, ${rec.priority}, ${status},
       ${JSON.stringify(rec.payload)}::jsonb)
    ON CONFLICT (id, created_at) DO NOTHING`;
}

/** Event `accepted` + attempt `queued` (attempt 1), atomically. Replay-safe. */
export async function recordAccepted(rec: AcceptedRecord): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(insertEvent(rec, 'accepted'));
    await tx.execute(sql`
      INSERT INTO delivery_attempt
        (id, created_at, notification_event_id, channel, template_id, attempt_no,
         status, status_rank, recoverable, job)
      VALUES
        (${rec.ids.attemptId}, ${rec.ids.createdAt}, ${rec.ids.eventId}, ${rec.channel},
         ${rec.templateId}, 1, 'queued', ${ATTEMPT_RANK.queued}, ${rec.recoverable},
         ${rec.job ? JSON.stringify(rec.job) : null}::jsonb)
      ON CONFLICT (id, created_at) DO NOTHING`);
  });
}

/**
 * Move an attempt (and its event) forward. Inserts the rows if the accepted
 * record has not landed yet; never moves either backwards.
 */
export async function upsertAttempt(rec: AcceptedRecord, u: AttemptUpdate): Promise<void> {
  const rank = ATTEMPT_RANK[u.status];
  const terminal = rank >= ATTEMPT_RANK.delivered;
  await getDb().transaction(async (tx) => {
    await tx.execute(insertEvent(rec, 'accepted'));
    await tx.execute(sql`
      INSERT INTO delivery_attempt
        (id, created_at, notification_event_id, channel, template_id, attempt_no,
         status, status_rank, recoverable, job, provider_message_id, error,
         dispatched_at, completed_at)
      VALUES
        (${rec.ids.attemptId}, ${rec.ids.createdAt}, ${rec.ids.eventId}, ${rec.channel},
         ${rec.templateId}, ${u.attemptNo}, ${u.status}, ${rank}, ${rec.recoverable},
         ${rec.job ? JSON.stringify(rec.job) : null}::jsonb,
         ${u.providerMessageId ?? null}, ${u.error ?? null},
         ${u.status === 'dispatching' ? sql`now()` : null},
         ${terminal ? sql`now()` : null})
      ON CONFLICT (id, created_at) DO UPDATE SET
        attempt_no          = EXCLUDED.attempt_no,
        status              = EXCLUDED.status,
        status_rank         = EXCLUDED.status_rank,
        provider_message_id = COALESCE(EXCLUDED.provider_message_id, delivery_attempt.provider_message_id),
        error               = EXCLUDED.error,
        dispatched_at       = COALESCE(EXCLUDED.dispatched_at, delivery_attempt.dispatched_at),
        completed_at        = EXCLUDED.completed_at,
        updated_at          = now()
      WHERE (EXCLUDED.attempt_no, EXCLUDED.status_rank)
          > (delivery_attempt.attempt_no, delivery_attempt.status_rank)`);
    await tx.execute(sql`
      UPDATE notification_event e
         SET status = ${eventStatusFor(u.status)}, updated_at = now()
        FROM delivery_attempt a
       WHERE e.id = ${rec.ids.eventId} AND e.created_at = ${rec.ids.createdAt}
         AND a.id = ${rec.ids.attemptId} AND a.created_at = ${rec.ids.createdAt}
         AND a.status = ${u.status} AND a.attempt_no = ${u.attemptNo}`);
  });
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm vitest run src/lib/audit && pnpm test:integration -- src/lib/audit`
Expected: PASS (2 unit, 5 integration).

- [ ] **Step 6: Commit**

```bash
git add src/lib/audit
git commit -m "feat(audit): record sends and stamp status monotonically

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: `/notify` records sends — before the queue for normal, fire-and-forget for realtime

**Files:**
- Create: `src/lib/audit/redact.ts`, `src/lib/audit/__tests__/redact.test.ts`
- Modify: `src/types/index.ts`, `src/routes/notify.ts`, `src/routes/__tests__/notify.test.ts`

**Interfaces:**
- Consumes: `recordAccepted`, `AcceptedRecord`, `AuditIds` (Task 7).
- Produces:
  - `Job.audit?: AuditIds` and `Job.replays?: number` (new optional fields)
  - `toAcceptedRecord(job: Job, source: string): AcceptedRecord` (in `redact.ts`) — the single place deciding what a job persists.
  - `NS_NETWORK` env read in `redact.ts` (`process.env.NS_NETWORK ?? 'unknown'` — `unknown` until #62 makes it required).

- [ ] **Step 1: Write the failing redaction test**

`src/lib/audit/__tests__/redact.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Job } from 'src/types';
import { toAcceptedRecord } from '../redact';

const ids = { eventId: 'e', attemptId: 'a', createdAt: '2026-10-04T00:00:00.000Z', correlationId: 'c' };

describe('toAcceptedRecord', () => {
  it('keeps no variable values or body for a realtime job, and marks it unrecoverable', () => {
    const job: Job = {
      job_id: 'j', channel: 'sms', priority: 'realtime', to: '+919999999999',
      template_id: 'login_otp', variables: { message: '123456' }, audit: ids,
    };
    const rec = toAcceptedRecord(job, 'keycloak');
    expect(JSON.stringify(rec)).not.toContain('123456');
    expect(rec.payload).toEqual({ to: '+919999999999', variable_names: ['message'] });
    expect(rec.job).toBeUndefined();
    expect(rec.recoverable).toBe(false);
  });

  it('keeps the full job for a normal job so it can be recovered', () => {
    const job: Job = {
      job_id: 'j', channel: 'email', priority: 'other', to: 'a@b.c',
      template_id: 'basic_email', variables: { subject: 's' }, audit: ids,
    };
    const rec = toAcceptedRecord(job, 'dpg-api-client');
    expect(rec.recoverable).toBe(true);
    expect(rec.job).toMatchObject({ job_id: 'j', variables: { subject: 's' } });
    expect(rec.source).toBe('dpg-api-client');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run src/lib/audit/__tests__/redact.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/types/index.ts` — add to `Job`:

```ts
  /** Audit identity, assigned at /notify and carried to every status write. */
  audit?: import('../lib/audit/store').AuditIds;
  /** Times this job has been replayed from the DLQ (capped; see queue.ts). */
  replays?: number;
```

`src/lib/audit/redact.ts`:

```ts
import type { Job } from 'src/types';
import type { AcceptedRecord } from './store';

/**
 * What a job persists. The one place this is decided.
 *
 * Realtime jobs carry OTP codes in their variables, and OTP codes are never
 * persisted (spec §Retention and PII): they keep the recipient and the variable
 * NAMES only, and no job copy — so they are also not recoverable after a Redis
 * loss, which is acceptable because the user simply requests a new code.
 */
export function toAcceptedRecord(job: Job, source: string): AcceptedRecord {
  if (!job.audit) throw new Error(`job ${job.job_id} has no audit ids`);
  const realtime = job.priority === 'realtime';
  return {
    ids: job.audit,
    network: process.env.NS_NETWORK ?? 'unknown',
    source,
    priority: job.priority,
    channel: job.channel,
    templateId: job.template_id,
    payload: realtime
      ? { to: job.to, variable_names: Object.keys(job.variables ?? {}) }
      : { to: job.to, variables: job.variables, ...(job.body ? { body: job.body } : {}) },
    job: realtime ? undefined : (job as unknown as Record<string, unknown>),
    recoverable: !realtime,
  };
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `pnpm vitest run src/lib/audit/__tests__/redact.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing route tests**

In `src/routes/__tests__/notify.test.ts`, add a mock for the store at the top (beside the existing mocks):

```ts
const { recordAccepted } = vi.hoisted(() => ({ recordAccepted: vi.fn(async () => {}) }));
vi.mock('../../lib/audit/store', () => ({ recordAccepted }));
```

and these cases (use the file's existing helpers for building a signed request and inspecting queue pushes; `pushOther`/`pushRealtime` are already mocked there):

```ts
describe('/notify audit', () => {
  beforeEach(() => recordAccepted.mockReset().mockResolvedValue(undefined));

  it('records a normal send before queueing it, with audit ids on the job', async () => {
    const res = await signedNotify({ channel: 'email', to: 'a@b.c', template_id: 'basic_email', variables: {} });
    expect(res.statusCode).toBe(200);
    expect(recordAccepted).toHaveBeenCalledTimes(1);
    const queued = vi.mocked(queue.pushOther).mock.calls[0][0];
    expect(queued.audit).toMatchObject({ eventId: expect.any(String), attemptId: expect.any(String) });
    expect(vi.mocked(recordAccepted).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(queue.pushOther).mock.invocationCallOrder[0]);
  });

  it('returns 503 when the record fails, and queues nothing', async () => {
    recordAccepted.mockRejectedValueOnce(new Error('db down'));
    const res = await signedNotify({ channel: 'email', to: 'a@b.c', template_id: 'basic_email', variables: {} });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'audit store unavailable', enqueued: false });
    expect(queue.pushOther).not.toHaveBeenCalled();
  });

  it('realtime still enqueues when the audit insert fails', async () => {
    recordAccepted.mockRejectedValueOnce(new Error('db down'));
    const res = await signedNotify({
      channel: 'sms', to: '+919999999999', template_id: 'login_otp',
      priority: 'realtime', variables: { message: '123456' },
    });
    expect(res.statusCode).toBe(200);
    expect(queue.pushRealtime).toHaveBeenCalledTimes(1);
  });
});
```

If `notify.test.ts` has no `signedNotify` helper, add one at the top of the file using the same signing code its existing cases use (`app.inject` with `X-NS-*` headers).

- [ ] **Step 6: Run them to see them fail**

Run: `pnpm vitest run src/routes/__tests__/notify.test.ts`
Expected: FAIL — `recordAccepted` not called / 503 not returned.

- [ ] **Step 7: Implement in the route**

`src/routes/notify.ts` — add imports:

```ts
import { recordAccepted } from '../lib/audit/store';
import { toAcceptedRecord } from '../lib/audit/redact';
```

Replace the block from `const job = { job_id, ...body, priority };` to the final `reply.send(...)` with:

```ts
      const correlation = req.headers['x-correlation-id'];
      const job = {
        job_id,
        ...body,
        priority,
        audit: {
          eventId: randomUUID(),
          attemptId: randomUUID(),
          createdAt: new Date().toISOString(),
          correlationId: typeof correlation === 'string' && correlation ? correlation : job_id,
        },
      };
      const source = String(req.headers['x-ns-key'] ?? 'unknown');
      const record = toAcceptedRecord(job, source);

      if (priority === 'realtime') {
        // Queue first: a slow or unavailable Postgres must never delay an OTP.
        await queue.pushRealtime(job);
        void recordAccepted(record).catch((err) =>
          req.log.error({ err: err.message, job_id }, 'realtime audit insert failed'),
        );
        return reply.send({ job_id, enqueued: true });
      }

      // Record before queue: a normal send that cannot be recorded is refused,
      // so a Redis loss can always be recovered from the record (spec
      // §Architecture, durability model).
      try {
        await recordAccepted(record);
      } catch (err) {
        req.log.error({ err: (err as Error).message, job_id }, 'audit insert failed; refusing send');
        return reply.code(503).send({ error: 'audit store unavailable', enqueued: false });
      }
      await queue.pushOther(job);
      reply.send({ job_id, enqueued: true });
```

- [ ] **Step 8: Run all unit tests**

Run: `pnpm test`
Expected: PASS, including the three new route cases.

- [ ] **Step 9: Commit**

```bash
git add src/types/index.ts src/lib/audit src/routes
git commit -m "feat(notify): record every send; refuse normal sends that cannot be recorded

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: The worker stamps status, best-effort

**Files:**
- Create: `src/lib/audit/stamp.ts`, `src/lib/audit/__tests__/stamp.test.ts`
- Modify: `src/lib/worker.ts`, `src/lib/__tests__/worker.test.ts`

**Interfaces:**
- Consumes: `upsertAttempt`, `toAcceptedRecord`, `metrics.incr`.
- Produces: `stamp(job: Job, update: AttemptUpdate): Promise<void>` — never throws; on failure increments `ns_audit_write_failures_total{stage}` and logs. No-op for jobs without `audit` (queued before this release).

- [ ] **Step 1: Write the failing tests**

`src/lib/audit/__tests__/stamp.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { upsertAttempt, incr } = vi.hoisted(() => ({
  upsertAttempt: vi.fn(async () => {}),
  incr: vi.fn(async () => {}),
}));
vi.mock('../store', () => ({ upsertAttempt }));
vi.mock('../../metrics', () => ({ incr }));

import { stamp } from '../stamp';

const audit = { eventId: 'e', attemptId: 'a', createdAt: '2026-10-04T00:00:00.000Z', correlationId: 'c' };
const job = { job_id: 'j', channel: 'email', priority: 'other' as const, to: 'x', template_id: 't', variables: {}, audit };

describe('stamp', () => {
  beforeEach(() => { upsertAttempt.mockReset().mockResolvedValue(undefined); incr.mockClear(); });

  it('writes the update', async () => {
    await stamp(job, { status: 'sent', attemptNo: 1 });
    expect(upsertAttempt).toHaveBeenCalledWith(expect.objectContaining({ ids: audit }), { status: 'sent', attemptNo: 1 });
  });

  it('swallows a database failure and counts it', async () => {
    upsertAttempt.mockRejectedValueOnce(new Error('db down'));
    await expect(stamp(job, { status: 'sent', attemptNo: 1 })).resolves.toBeUndefined();
    expect(incr).toHaveBeenCalledWith('ns_audit_write_failures_total', { stage: 'sent' });
  });

  it('skips jobs queued before audit ids existed', async () => {
    await stamp({ ...job, audit: undefined }, { status: 'sent', attemptNo: 1 });
    expect(upsertAttempt).not.toHaveBeenCalled();
  });
});
```

In `src/lib/__tests__/worker.test.ts`, add `vi.mock('../audit/stamp', () => ({ stamp }))` with `const { stamp } = vi.hoisted(() => ({ stamp: vi.fn(async () => {}) }))`, and:

```ts
describe('processJob audit stamping', () => {
  beforeEach(() => stamp.mockClear());

  it('stamps dispatching then sent on success', async () => {
    await processJob({ job_id: 'j', channel: 'email', priority: 'other', to: 'x', template_id: 'welcome', variables: {} });
    expect(stamp.mock.calls.map((c) => c[1])).toEqual([
      { status: 'dispatching', attemptNo: 1 },
      { status: 'sent', attemptNo: 1, providerMessageId: undefined },
    ]);
  });

  it('stamps queued for the next attempt when a retry is scheduled', async () => {
    send.mockResolvedValueOnce({ ok: false, error: 'timeout' });
    await processJob({ job_id: 'j', channel: 'email', priority: 'other', to: 'x', template_id: 'welcome', variables: {} });
    expect(stamp.mock.calls.at(-1)?.[1]).toEqual({ status: 'queued', attemptNo: 2, error: 'timeout' });
  });

  it('stamps failed when dead-lettered', async () => {
    send.mockResolvedValueOnce({ ok: false, error: 'bad template', retryable: false });
    await processJob({ job_id: 'j', channel: 'email', priority: 'other', to: 'x', template_id: 'welcome', variables: {} });
    expect(stamp.mock.calls.at(-1)?.[1]).toEqual({ status: 'failed', attemptNo: 1, error: 'bad template' });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/lib/audit/__tests__/stamp.test.ts src/lib/__tests__/worker.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `stamp`**

`src/lib/audit/stamp.ts`:

```ts
import type { Job } from 'src/types';
import * as metrics from '../metrics';
import { toAcceptedRecord } from './redact';
import { upsertAttempt, type AttemptUpdate } from './store';

/**
 * Best-effort status write from the worker. A database problem must never
 * fail, delay or re-route a send, so this never throws; failures are counted
 * (ns_audit_write_failures_total) so a silent audit gap is still alertable.
 */
export async function stamp(job: Job, update: AttemptUpdate): Promise<void> {
  if (!job.audit) return;
  try {
    await upsertAttempt(toAcceptedRecord(job, 'worker'), update);
  } catch (err) {
    await metrics.incr('ns_audit_write_failures_total', { stage: update.status });
    console.log(`Audit write failed for ${job.job_id} (${update.status}):`, err instanceof Error ? err.message : err);
  }
}
```

Note: `toAcceptedRecord(job, 'worker')` only supplies the row if the accepted insert never landed; `ON CONFLICT` keeps the original `source`.

- [ ] **Step 4: Stamp from `processJob`**

In `src/lib/worker.ts`, `import { stamp } from './audit/stamp';` and:

- Every `return pushDLQ(job);` becomes:

```ts
    await stamp(job, { status: 'failed', attemptNo: job.attempt, error: '<same reason string as the metric>' });
    return pushDLQ(job);
```

  using `unknown_channel`, `template_not_configured`, `unknown_template` for the three pre-send cases, and `res.error ?? 'permanent_failure'` / `res.error ?? 'max_retries'` for the two post-send cases. (Match the test: permanent failure passes `res.error`.)
- Immediately before `res = await provider.send(...)`'s `try`:

```ts
  await stamp(job, { status: 'dispatching', attemptNo: job.attempt });
```

- Before `return scheduleRetry(job, delay);`:

```ts
    await stamp(job, { status: 'queued', attemptNo: job.attempt + 1, error: res.error });
```

- Before `console.log('Delivered:', job.job_id);`:

```ts
  await stamp(job, { status: 'sent', attemptNo: job.attempt, providerMessageId: res.provider_message_id });
```

(`provider_message_id` already exists on `ProviderSendResult`.)

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Document the metric and commit**

Add `ns_audit_write_failures_total | counter | stage` to the metrics table in `CLAUDE.md` §Observability.

```bash
git add src/lib/audit src/lib/worker.ts src/lib/__tests__/worker.test.ts CLAUDE.md
git commit -m "feat(worker): stamp delivery status, best-effort

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: Recover work Redis lost

**Files:**
- Create: `src/lib/audit/recover.ts`, `src/lib/audit/__tests__/recover.integration.test.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `getPool`, `pushOther` (queue), Redis client.
- Produces:
  - `REDIS_EPOCH_KEY = 'ns:epoch'`
  - `recoverLostJobs(opts?: { staleDispatchMs?: number }): Promise<{ epochLost: boolean; requeued: number }>`

Rules (spec §Architecture, durability model):
1. If `ns:epoch` is **absent**, Redis lost its data: re-queue every recoverable attempt in `queued` or `dispatching`, then set the epoch.
2. Always: re-queue recoverable attempts stuck in `dispatching` for longer than `staleDispatchMs` (default 10 min — a worker that died mid-send). This is at-least-once by design: the provider may have sent before the crash.
3. Never re-queue `recoverable = false` (realtime) attempts.
4. Re-queue stamps the attempt `queued` with `attempt_no + 1` *in the same statement that selects it* (`UPDATE … RETURNING job`), so two replicas booting together cannot both re-queue one job.

- [ ] **Step 1: Write the failing integration test**

`src/lib/audit/__tests__/recover.integration.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const pushed: unknown[] = [];
vi.mock('../../queue', () => ({ pushOther: vi.fn(async (j: unknown) => { pushed.push(j); return 1; }) }));

import redis from '../../redis';
import { closeDb, getPool } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { recordAccepted, upsertAttempt, type AcceptedRecord } from '../store';
import { recoverLostJobs, REDIS_EPOCH_KEY } from '../recover';

beforeAll(async () => { await runMigrations(); });
afterAll(async () => { await closeDb(); redis.disconnect(); });
beforeEach(async () => {
  pushed.length = 0;
  await getPool().query(`DELETE FROM delivery_attempt; DELETE FROM notification_event;`);
});

function rec(priority: 'realtime' | 'other'): AcceptedRecord {
  const jobId = randomUUID();
  return {
    ids: { eventId: randomUUID(), attemptId: randomUUID(), createdAt: new Date().toISOString(), correlationId: jobId },
    network: 'n', source: 's', priority, channel: 'email', templateId: 't',
    payload: {}, recoverable: priority === 'other',
    job: priority === 'other' ? { job_id: jobId, channel: 'email', priority, to: 'x', template_id: 't', variables: {} } : undefined,
  };
}

describe('recoverLostJobs', () => {
  it('requeues when the epoch is missing, exactly once', async () => {
    const r = rec('other');
    await recordAccepted(r);
    await redis.del(REDIS_EPOCH_KEY);

    const [a, b] = await Promise.all([recoverLostJobs(), recoverLostJobs()]);
    expect(a.requeued + b.requeued).toBe(1);
    expect(pushed).toHaveLength(1);
    expect(await redis.get(REDIS_EPOCH_KEY)).not.toBeNull();
  });

  it('does nothing when the epoch is present and nothing is stale', async () => {
    await recordAccepted(rec('other'));
    await redis.set(REDIS_EPOCH_KEY, 'x');
    expect(await recoverLostJobs()).toEqual({ epochLost: false, requeued: 0 });
  });

  it('does not requeue realtime', async () => {
    await recordAccepted(rec('realtime'));
    await redis.del(REDIS_EPOCH_KEY);
    expect((await recoverLostJobs()).requeued).toBe(0);
  });

  it('requeues an attempt stuck in dispatching past the threshold', async () => {
    const r = rec('other');
    await recordAccepted(r);
    await upsertAttempt(r, { status: 'dispatching', attemptNo: 1 });
    await getPool().query(`UPDATE delivery_attempt SET updated_at = now() - interval '1 hour' WHERE id = $1`, [r.ids.attemptId]);
    await redis.set(REDIS_EPOCH_KEY, 'x');
    expect((await recoverLostJobs({ staleDispatchMs: 60_000 })).requeued).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm test:integration -- src/lib/audit/__tests__/recover.integration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/lib/audit/recover.ts`:

```ts
import { randomUUID } from 'node:crypto';
import redis from '../redis';
import { pushOther } from '../queue';
import { getPool } from '../db/client';
import type { Job } from 'src/types';

/**
 * Redis is the dispatch queue; Postgres is the record. A Redis that restarts
 * without its data (or is flushed) loses queued work silently. NS detects that
 * with an epoch key it writes once and never expires: absent epoch = lost data.
 */
export const REDIS_EPOCH_KEY = 'ns:epoch';
const DEFAULT_STALE_DISPATCH_MS = 10 * 60 * 1000;

export async function recoverLostJobs(
  opts: { staleDispatchMs?: number } = {},
): Promise<{ epochLost: boolean; requeued: number }> {
  const staleMs = opts.staleDispatchMs ?? DEFAULT_STALE_DISPATCH_MS;

  // Claim the epoch FIRST, with SET NX: of several replicas booting after a
  // Redis loss, exactly one gets 'OK' and owns the full re-queue. Checking
  // EXISTS and setting afterwards would let a second replica that starts in
  // between also see "lost" and re-queue everything again.
  // (If the owner crashes between this SET and the UPDATE below, the full
  // re-queue is skipped; the stale-dispatch half still recovers in-flight work.)
  const epochLost = (await redis.set(REDIS_EPOCH_KEY, randomUUID(), 'NX')) === 'OK';

  // Claim and bump in one statement. For the stale-dispatch half, concurrent
  // replicas serialise on the row lock and the second re-evaluates its WHERE
  // against the bumped row (now 'queued'), so it no longer matches.
  const { rows } = await getPool().query<{ job: Job; attempt_no: number }>(
    `UPDATE delivery_attempt
        SET status = 'queued', status_rank = 0, attempt_no = attempt_no + 1, updated_at = now()
      WHERE recoverable
        AND job IS NOT NULL
        AND (
          ($1 AND status IN ('queued', 'dispatching'))
          OR (status = 'dispatching' AND updated_at < now() - ($2 || ' milliseconds')::interval)
        )
      RETURNING job, attempt_no`,
    [epochLost, String(staleMs)],
  );

  for (const row of rows) {
    await pushOther({ ...row.job, attempt: row.attempt_no - 1 });
  }

  if (rows.length > 0) console.log(`Recovered ${rows.length} job(s) (epochLost=${epochLost})`);
  return { epochLost, requeued: rows.length };
}
```

The first boot of this release on any cluster sees no epoch and re-queues every open recoverable attempt — which is none, since the tables are new. Never delete `ns:epoch` by hand on a running cluster.

- [ ] **Step 4: Run it to see it pass**

Run: `pnpm test:integration -- src/lib/audit/__tests__/recover.integration.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run recovery on boot**

`src/server.ts`, in `main()` after `startPartitionMaintenance();` and before `app.listen`:

```ts
  // Before the worker starts draining, so recovered jobs join the queue in order.
  await recoverLostJobs();
```

with `import { recoverLostJobs } from './lib/audit/recover.js';`. A failure here fails startup (it means Postgres or Redis is unreachable, which the service cannot run without).

Also run the stale-dispatch half periodically: after `spawnWorker();`:

```ts
  setInterval(() => {
    recoverLostJobs().catch((err) => console.error('Recovery sweep failed:', err.message));
  }, 5 * 60 * 1000).unref();
```

- [ ] **Step 6: Commit**

```bash
pnpm build && pnpm test
git add src/lib/audit src/server.ts
git commit -m "feat(audit): recover queued work after a Redis data loss or worker crash

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: DLQ replay keeps its accounting; Redis requires a password

**Files:**
- Modify: `src/lib/queue.ts`, `src/lib/__tests__/queue.test.ts`, `src/lib/redis.ts`
- Create: `src/lib/__tests__/redis-config.test.ts`

**Interfaces:**
- Produces: `MAX_REPLAYS = 3` (exported from `queue.ts`); `retryFailedJobs` result gains `refused: string[]`. `redisOptions(env?: NodeJS.ProcessEnv): RedisOptions` exported from `redis.ts`.

Acceptance criteria from #56 §Security: a job returned from the DLQ keeps its history, so a poisoned job cannot be cycled indefinitely; and the cache has no empty-password default.

- [ ] **Step 1: Write the failing tests**

In `src/lib/__tests__/queue.test.ts`:

```ts
describe('retryFailedJobs replay accounting', () => {
  it('increments replays and refuses past MAX_REPLAYS', async () => {
    await pushDLQ({ job_id: 'p', channel: 'email', priority: 'other', to: 'x', template_id: 't', variables: {}, replays: MAX_REPLAYS });
    const res = await retryFailedJobs({ jobId: 'p' });
    expect(res.refused).toEqual(['p']);
    expect(res.retried).toEqual([]);
    // Still in the DLQ, not lost.
    expect(await fake.lrange('queue:dlq', 0, -1)).toHaveLength(1);
  });

  it('a replayed job carries replays + 1', async () => {
    await pushDLQ({ job_id: 'q', channel: 'email', priority: 'other', to: 'x', template_id: 't', variables: {}, replays: 1 });
    await retryFailedJobs({ jobId: 'q' });
    const [raw] = await fake.lrange('queue:other', 0, -1);
    expect(JSON.parse(raw).replays).toBe(2);
  });
});
```

(Use the file's existing fake-Redis handle name in place of `fake`.)

`src/lib/__tests__/redis-config.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
vi.mock('ioredis', () => ({ default: vi.fn() }));
import { redisOptions } from '../redis';

describe('redisOptions', () => {
  it('requires a password', () => {
    expect(() => redisOptions({})).toThrow('REDIS_PASSWORD is required');
  });
  it('allows no password only when explicitly opted out', () => {
    expect(redisOptions({ REDIS_ALLOW_NO_AUTH: 'true' }).password).toBeUndefined();
  });
  it('passes the password through', () => {
    expect(redisOptions({ REDIS_PASSWORD: 'pw' }).password).toBe('pw');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/lib/__tests__/queue.test.ts src/lib/__tests__/redis-config.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement replay accounting**

In `src/lib/queue.ts`:

```ts
/**
 * DLQ replays allowed per job. Attempts reset on replay (a replay is an
 * operator saying "try again"), but replays themselves are counted and capped
 * so one job cannot be cycled through the providers indefinitely.
 */
export const MAX_REPLAYS = 3;
```

Change `requeueFailedJob` to:

```ts
async function requeueFailedJob(raw: string, priority: 'realtime' | 'other') {
  const job = parseJob(raw);
  if (!job) return null;

  const retryJob: Job = {
    ...job,
    priority,
    attempt: 0,
    next_attempt_at: undefined,
    replays: (job.replays ?? 0) + 1,
  };

  if (priority === 'realtime') await pushRealtime(retryJob);
  else await pushOther(retryJob);

  return retryJob;
}
```

In `retryFailedJobs`, declare `const refused: string[] = [];`, and before each `lrem`/`rpop` removes a job, check the cap:

- jobId path: after finding `raw`, `const parsed = parseJob(raw); if (parsed && (parsed.replays ?? 0) >= MAX_REPLAYS) return { retried, skipped, refused: [jobId], not_found: [] };`
- loop path: replace `rpop` with `lindex(DLQ_QUEUE, -1)`; if that job is at the cap, push its id to `refused` and `break` (leaving it in place); otherwise `rpop` and requeue as before.

Return `refused` in every result object.

- [ ] **Step 4: Implement the Redis password requirement**

`src/lib/redis.ts`:

```ts
import Redis, { type RedisOptions } from 'ioredis';

/**
 * Connection options. A password is required: the cache holds queued jobs, so
 * an unauthenticated Redis would let anything that can reach it inject sends.
 * REDIS_ALLOW_NO_AUTH=true is for local runs and CI only.
 */
export function redisOptions(env: NodeJS.ProcessEnv = process.env): RedisOptions {
  const allowNoAuth = env.REDIS_ALLOW_NO_AUTH === 'true';
  if (!env.REDIS_PASSWORD && !allowNoAuth) {
    throw new Error('REDIS_PASSWORD is required (set REDIS_ALLOW_NO_AUTH=true for local runs only)');
  }
  return {
    host: env.REDIS_HOST || '127.0.0.1',
    port: Number(env.REDIS_PORT) || 6379,
    password: env.REDIS_PASSWORD || undefined,
  };
}

const redis = new Redis(redisOptions());

export default redis;
```

Add `REDIS_ALLOW_NO_AUTH: 'true'` to the `ci.yaml` integration step env (done in Task 4) and set `REDIS_ALLOW_NO_AUTH=true` in `vitest.config.ts`'s `test.env` so unit tests that import the real module path still load (they mock it, but import order can construct it first).

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm test && pnpm test:integration`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/queue.ts src/lib/redis.ts src/lib/__tests__ vitest.config.ts
git commit -m "fix(queue): cap DLQ replays and require a Redis password

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: Documentation

**Files:**
- Modify: `CLAUDE.md`, `README.md`

- [ ] **Step 1: CLAUDE.md**

Update these sections (keep the file's existing voice — load-bearing gotchas, not tutorials):
- **Quick Commands:** `docker compose up -d postgres redis`; `pnpm db:generate --custom --name=<x>` for partitioned DDL.
- **Architecture → High-Level Flow:** boot order *migrate (advisory lock) → partition maintenance → recover lost jobs → listen → fork worker*.
- New **Persistence** section: Postgres is the record, Redis the queue; record-before-queue for normal, queue-first for realtime; realtime persists no variable values and is not recoverable; monotonic `(attempt_no, status_rank)` upserts; the `ns:epoch` key and what deleting it does (triggers a full re-queue of open recoverable attempts — never delete it by hand); partitioned tables are excluded from `drizzle.config.ts` and live in custom migrations + `src/lib/db/partitioned.ts`; `pg_partman` in schema `partman`, maintenance driven by NS (no bgw), no retention until #65.
- **Environment Setup:** `DATABASE_*`, `NS_NETWORK` (optional until #62), `REDIS_ALLOW_NO_AUTH`, `PARTITION_MAINTENANCE_INTERVAL_MS`.
- **Testing Notes:** the integration suite now needs Postgres too (`docker compose up -d postgres`).
- **Deployment Notes:** remove "The server itself is stateless; all state is in Redis"; add "needs the `notification` database (bluedots-automation common-services bootstrap) before this image is deployed".
- **DLQ:** `MAX_REPLAYS` and the `refused` result field.

- [ ] **Step 2: README.md**

Add a short "Persistence" subsection under setup with the `DATABASE_*` table, and note `/failed/retry`'s new `refused` field.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: persistence, boot order and recovery

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Part 3 — bluedots-e2e (`feat/ns-postgres`, cut from `feature`)

### Task 13: Give the e2e stack's notification-service a database

**Files:**
- Modify: `src/env/compose/overlay.ts` (the `notification-service:` service, ~L149)
- Modify: `src/env/compose/stack_env.ts` (constants)
- Test: `src/env/compose/overlay.test.ts` (create if absent, beside `compose_provider.test.ts`)

**Interfaces:**
- Consumes: NS image from `feat/ns-persistence` (requires `DATABASE_*`, `REDIS_PASSWORD`).
- Produces: a `notification-postgres` compose service, and NS env pointing at it.

- [ ] **Step 1: Write the failing test**

`src/env/compose/overlay.test.ts` (add to it if it exists; build `opts` the way existing overlay callers do in `compose_provider.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { renderOverlay } from './overlay.js';

describe('overlay: notification-service persistence', () => {
  const yaml = renderOverlay({
    target: { id: 't' } as never,
    digests: { 'notification-service': 'sha256:abc' },
    timing: {},
  });

  it('defines a pg_partman Postgres for notification-service', () => {
    expect(yaml).toContain('notification-postgres:');
    expect(yaml).toContain('postgresql-17-partman');
  });

  it('points notification-service at it and waits for it', () => {
    expect(yaml).toMatch(/DATABASE_HOST: notification-postgres/);
    expect(yaml).toMatch(/notification-postgres:\s*\n\s*condition: service_healthy/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run src/env/compose/overlay.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `overlay.ts`, before the `notification-service:` block, add (remember: no backticks inside this template literal):

```yaml
  # notification-service's own database. NOT the signals postgres: that image
  # has no pg_partman, and NS's schema must not share a database with signals.
  # Built inline from stock Postgres 17 + pg_partman, initialised like the
  # common-services bootstrap provisions RDS.
  notification-postgres:
    build:
      context: .
      dockerfile_inline: |
        FROM postgres:17-bookworm
        RUN apt-get update && apt-get install -y --no-install-recommends postgresql-17-partman && rm -rf /var/lib/apt/lists/*
    environment:
      POSTGRES_USER: notification
      POSTGRES_PASSWORD: notification
      POSTGRES_DB: notification
    command: ["postgres", "-c", "fsync=off"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U notification -d notification && psql -U notification -d notification -c 'CREATE SCHEMA IF NOT EXISTS partman; CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman;'"]
      interval: 3s
      timeout: 5s
      retries: 30
```

(The healthcheck creates the schema + extension idempotently; `notification` is the database owner and superuser of this throwaway instance, so no grants are needed.)

In the `notification-service:` block, extend `depends_on`:

```yaml
      notification-postgres:
        condition: service_healthy
```

and `environment`:

```yaml
      DATABASE_HOST: notification-postgres
      DATABASE_PORT: "5432"
      DATABASE_NAME: notification
      DATABASE_USER: notification
      DATABASE_PASSWORD: notification
      DATABASE_SSL: disable
```

- [ ] **Step 4: Run it to see it pass**

Run: `pnpm vitest run src/env/compose/overlay.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/env/compose
git commit -m "feat(compose): give notification-service its own pg_partman Postgres

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Done when

- `bluedots-automation`: `helm template` renders the `notification` role/database/partman block and the NS `DATABASE_*` env; `tofu validate` clean.
- `notification-service`: `pnpm build`, `pnpm test`, `pnpm test:integration` green locally and in CI; `docker compose up` boots NS against Postgres; a `POST /notify` produces one `notification_event` + one `delivery_attempt` that reaches `sent` (or `failed` with no transport configured).
- `bluedots-e2e`: the journey stack boots NS with its database.
- The `/notify` request/response contract is unchanged except the new `503 {error:'audit store unavailable'}` for normal sends.
