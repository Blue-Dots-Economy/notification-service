# NS Stage 1 · Plan C1 — Priority Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it physically impossible for bulk or normal traffic to delay an OTP: separate worker pools per priority, a vendor quota split with a share only urgent sends can use, and a deadline after which an urgent send is dropped as `expired` instead of being retried or dead-lettered.

**Architecture:** Three Redis queues (`queue:realtime` = urgent, `queue:other` = normal, new `queue:bulk`) each drained by its own pool of loops, every loop on its own blocking Redis connection. A scheduler loop moves due retries back into their priority's queue, so retries never jump pools. Before each send the worker takes a token from a per-channel×vendor bucket pair — `shared` (everyone) and `reserved` (urgent only); without a token the job is deferred, not failed. Jobs carry an absolute `deadline`; past it the attempt ends `expired`. Redacted (OTP) jobs never enter the DLQ.

**Tech Stack:** TypeScript 7 (CommonJS), ioredis 6 (Lua via `EVAL`, `duplicate()` for blocking connections), vitest 4, Redis 7.

**Spec:** `docs/superpowers/specs/2026-06-26-event-platform-design.md` (rev 2026-10-04) — §Ingress and isolation, §Retention and PII (OTP never persisted / dead-lettered), §Security ("Activating the rate limiter"). Issue: Blue-Dots-Economy/notification-service#61. Builds on Plans A and B (`feat/ns-templates`, PR #148).

**Branch:** `notification-service` `feat/ns-priority-isolation`, cut from `feat/ns-templates` (stacked; rebase onto `feature` once #147/#148 merge). Plan C2 (Send API v1) builds on this branch.

## Global Constraints

- Plan A and B Global Constraints and rulings still apply (CommonJS, extensionless imports in `src/lib`, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, public-repo wording, `describeDbError` for DB errors, never log variable values).
- **Internal priority names stay `realtime | other` and gain `bulk`.** Redis keys are unchanged for the first two (`queue:realtime`, `queue:other`) so jobs queued before the deploy keep draining; `queue:bulk` is new. The public names `urgent | normal | bulk` arrive with Plan C2 and map `urgent→realtime`, `normal→other`, `bulk→bulk`.
- **One loop = one blocking Redis connection** (`redis.duplicate()`). A `BRPOP` blocks its connection; loops must never share one, or a bulk `BRPOP` would hold up an urgent pop.
- Pool sizes: `WORKER_URGENT_CONCURRENCY` (default 2), `WORKER_NORMAL_CONCURRENCY` (default 2), `WORKER_BULK_CONCURRENCY` (default 1); positive integers, invalid → worker exits at boot.
- **Rate limit applies to every send** (the worker is the only sender, so it covers `/notify`, retries and DLQ replays). Keyed `rl:<channel>:<vendor>:shared` and `rl:<channel>:<vendor>:reserved`.
- Rates: `RATE_<CHANNEL>_PER_SEC` and `RATE_<CHANNEL>_BURST` (channel upper-cased, e.g. `RATE_SMS_PER_SEC`), defaults from `src/lib/config/index.ts` (`sms 100/40`, `email 100/50`, `whatsapp 100/10`); `RATE_URGENT_SHARE` (default `0.2`, `0 < share < 1`). Reserved bucket = `share` of the rate and of the burst; shared = the rest. Bursts are at least 1 token; rates may be fractional (tokens per second).
- **Urgent takes `shared` first, then `reserved`; normal and bulk take `shared` only.**
- A rate-limited job is **deferred** (`RATE_LIMIT_DEFER_MS`, default 250, plus up to 50% jitter) and its attempt is **not** counted.
- **Deadline** is an absolute epoch-ms `Job.deadline`. Legacy `/notify` sets it for `realtime` to `now + URGENT_DEFAULT_DEADLINE_S` (default 600). A job past its deadline is never sent: terminal `expired` (attempt + event), marker `failed`, `ns_job_expired_total{channel}`, no DLQ. A retry or deferral that would land after the deadline expires the job immediately instead.
- **Redacted jobs never enter the DLQ** (`audit.redactValues`, else `priority === 'realtime'`): any path that would dead-letter one instead stamps `failed`, writes marker `failed`, counts `ns_job_dropped_total{channel,reason}`. A DLQ entry would keep a live code at rest.

## Review Focus

- **A burst of 10k bulk jobs queued while an OTP arrives** → the OTP is popped by an urgent loop immediately, never behind a bulk `BRPOP` (Task 2, test `urgent loop pops while a bulk loop is blocked`).
- **Shared bucket empty, reserved bucket full** → urgent sends proceed, normal/bulk are deferred without counting an attempt (Task 3, test `urgent uses the reserve when shared is empty`).
- **An OTP whose provider times out repeatedly** → retried only while the next retry lands before the deadline, then `expired`; never in the DLQ (Task 4, test `retry past the deadline expires instead`).
- **A permanently failing OTP template (blank DLT id)** → `failed`, counted as dropped, no DLQ entry holding the code (Task 4, test `redacted jobs are never dead-lettered`).
- **A retried bulk job comes due** → it re-enters `queue:bulk`, not an urgent or normal loop (Task 1, test `due retries return to their own priority queue`).

---

### Task 1: Priority queues, retry scheduler and deferral

**Files:**
- Modify: `src/types/index.ts`, `src/lib/queue.ts`, `src/lib/audit/store.ts` (`AcceptedRecord.priority: Priority`), `src/lib/__tests__/queue.test.ts`, `src/lib/__tests__/redis-fake.ts` (only if a command is missing)
- Test: `src/lib/__tests__/queue-priority.integration.test.ts`

**Interfaces:**
- Produces:
  - `type Priority = 'realtime' | 'other' | 'bulk'` (exported from `src/types/index.ts`); `Job.priority: Priority`; `Job.deadline?: number` (epoch ms)
  - `QUEUE_KEYS: Record<Priority, string>` = `{ realtime: 'queue:realtime', other: 'queue:other', bulk: 'queue:bulk' }`
  - `pushToPriority(job: Job): Promise<void>` — LPUSH onto `QUEUE_KEYS[job.priority]`
  - `popFrom(conn: Redis, priority: Priority, timeoutSeconds?: number): Promise<Job | null>` — BRPOP on the given connection; returns the parsed job or null
  - `moveDueRetries(now?: number): Promise<number>` — atomically claims every due member of `queue:retry` and LPUSHes each onto its priority's queue (one Lua script); returns how many moved; a member whose JSON fails to parse goes to `queue:dlq` unchanged
  - `deferJob(job: Job, delayMs: number): Promise<void>` — ZADD to `queue:retry` at `Date.now() + delayMs` without touching `attempt`
  - `getQueueMetrics()` gains `bulk`
- Keeps: `pushRealtime`, `pushOther` (now thin wrappers over `pushToPriority`), `popScheduledRetries` (still used by tests/legacy paths until Task 2 removes its worker use).

- [ ] **Step 1: Write the failing integration test**

`src/lib/__tests__/queue-priority.integration.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import redis from '../redis';
import { deferJob, moveDueRetries, popFrom, pushToPriority, QUEUE_KEYS } from '../queue';
import type { Job } from 'src/types';

const job = (id: string, priority: Job['priority']): Job => ({
  job_id: id, channel: 'sms', priority, to: '+919999999999', template_id: 't', variables: {},
});

beforeEach(async () => {
  await redis.del(QUEUE_KEYS.realtime, QUEUE_KEYS.other, QUEUE_KEYS.bulk, 'queue:retry', 'queue:dlq');
});
afterAll(() => redis.disconnect());

describe('priority queues', () => {
  it('pushes and pops per priority on a dedicated connection', async () => {
    const conn = redis.duplicate();
    try {
      await pushToPriority(job('b1', 'bulk'));
      expect(await popFrom(conn, 'realtime', 1)).toBeNull();
      expect((await popFrom(conn, 'bulk', 1))?.job_id).toBe('b1');
    } finally {
      conn.disconnect();
    }
  });

  it('due retries return to their own priority queue', async () => {
    await deferJob(job('r1', 'realtime'), -1);
    await deferJob(job('o1', 'other'), -1);
    await deferJob(job('b1', 'bulk'), -1);
    await deferJob(job('later', 'bulk'), 60_000);
    expect(await moveDueRetries()).toBe(3);
    expect(await redis.lrange(QUEUE_KEYS.realtime, 0, -1)).toHaveLength(1);
    expect(await redis.lrange(QUEUE_KEYS.other, 0, -1)).toHaveLength(1);
    expect(await redis.lrange(QUEUE_KEYS.bulk, 0, -1)).toHaveLength(1);
    expect(await redis.zcard('queue:retry')).toBe(1);
  });

  it('deferJob does not change the attempt count', async () => {
    await deferJob({ ...job('a', 'other'), attempt: 2 }, -1);
    await moveDueRetries();
    const [raw] = await redis.lrange(QUEUE_KEYS.other, 0, -1);
    expect(JSON.parse(raw!).attempt).toBe(2);
  });

  it('concurrent schedulers never move a retry twice', async () => {
    for (let i = 0; i < 50; i++) await deferJob(job(`j${i}`, 'other'), -1);
    const moved = await Promise.all(Array.from({ length: 8 }, () => moveDueRetries()));
    expect(moved.reduce((a, b) => a + b, 0)).toBe(50);
    expect(await redis.llen(QUEUE_KEYS.other)).toBe(50);
  });

  it('an unparseable retry member is dead-lettered, not lost', async () => {
    await redis.zadd('queue:retry', '0', 'not json');
    expect(await moveDueRetries()).toBe(0);
    expect(await redis.lrange('queue:dlq', 0, -1)).toEqual(['not json']);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run (Redis on 56379 as in earlier plans): `REDIS_PORT=56379 REDIS_ALLOW_NO_AUTH=true DATABASE_HOST=127.0.0.1 DATABASE_PORT=55432 DATABASE_NAME=notification DATABASE_USER=notification DATABASE_PASSWORD=notification pnpm test:integration`
Expected: FAIL — `pushToPriority` / `popFrom` / `moveDueRetries` / `deferJob` not exported.

- [ ] **Step 3: Implement**

`src/types/index.ts` — add and use:

```ts
/** Internal priority. Public API names (Plan C2): urgent → realtime, normal → other, bulk → bulk. */
export type Priority = 'realtime' | 'other' | 'bulk';
```

Change `Job.priority` to `Priority` and add:

```ts
  /** Absolute epoch-ms deadline. Past it the job is never sent: terminal `expired`. */
  deadline?: number;
```

(`NotifyRequest.priority` stays `'realtime' | 'other'` — the legacy route never accepts bulk.)

`src/lib/queue.ts` — add (keep the existing exports; reimplement `pushRealtime`/`pushOther` on top):

```ts
import type Redis from 'ioredis';
import type { Job, Priority } from 'src/types';

export const QUEUE_KEYS: Record<Priority, string> = {
  realtime: 'queue:realtime',
  other: 'queue:other',
  bulk: 'queue:bulk',
};

export async function pushToPriority(job: Job): Promise<void> {
  await redis.lpush(QUEUE_KEYS[job.priority] ?? QUEUE_KEYS.other, JSON.stringify(job));
}

/**
 * Blocking pop for one priority on the caller's own connection. BRPOP holds its
 * connection until it returns, so every pool loop owns a dedicated connection —
 * sharing one would let a bulk pop hold up an urgent one.
 */
export async function popFrom(conn: Redis, priority: Priority, timeoutSeconds = 1): Promise<Job | null> {
  const res = await conn.brpop(QUEUE_KEYS[priority], timeoutSeconds);
  return res ? (JSON.parse(res[1]) as Job) : null;
}

/** Schedule a job without counting an attempt (rate-limit deferral). */
export async function deferJob(job: Job, delayMs: number): Promise<void> {
  await redis.zadd(RETRY_ZSET, String(Date.now() + delayMs), JSON.stringify(job));
}

// Claim every due retry and push it onto its own priority's queue in one atomic
// step, so concurrent schedulers never move a member twice and a retry never
// changes pool. A member that is not valid JSON goes to the DLQ untouched rather
// than vanishing. Fixed script; keys and cutoff are passed as KEYS/ARGV.
const MOVE_DUE_RETRIES = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], 0, ARGV[1])
local moved = 0
for _, raw in ipairs(due) do
  redis.call('ZREM', KEYS[1], raw)
  local ok, job = pcall(cjson.decode, raw)
  if ok and type(job) == 'table' then
    local p = job['priority']
    local target = KEYS[3]
    if p == 'realtime' then target = KEYS[2] elseif p == 'bulk' then target = KEYS[4] end
    redis.call('LPUSH', target, raw)
    moved = moved + 1
  else
    redis.call('LPUSH', KEYS[5], raw)
  end
end
return moved
`;

export async function moveDueRetries(now = Date.now()): Promise<number> {
  return (await redis.eval(
    MOVE_DUE_RETRIES,
    5,
    RETRY_ZSET,
    QUEUE_KEYS.realtime,
    QUEUE_KEYS.other,
    QUEUE_KEYS.bulk,
    DLQ_QUEUE,
    String(now),
  )) as number;
}
```

`pushRealtime(job)` → `pushToPriority({ ...job, priority: 'realtime' })`; `pushOther(job)` → `pushToPriority({ ...job, priority: 'other' })`; keep their signatures. Add `.llen(QUEUE_KEYS.bulk)` to `getQueueMetrics` and return `bulk`; add `bulk` to the `ns_queue_depth` gauge rendering in `metrics.ts` if it enumerates queues there.

- [ ] **Step 4: Run tests**

Run the integration command and `pnpm test` (fix `queue.test.ts` / redis-fake only where a new command or field is needed; existing assertions keep passing).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts src/lib/queue.ts src/lib/metrics.ts src/lib/__tests__
git commit -m "feat(queue): bulk queue, per-priority retry scheduling and deferral

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Worker pools

**Files:**
- Create: `src/lib/pools.ts`, `src/lib/__tests__/pools.test.ts`
- Modify: `src/lib/worker.ts`

**Interfaces:**
- Consumes: `popFrom`, `moveDueRetries` (Task 1); `processJob` (existing).
- Produces:
  - `interface PoolConfig { realtime: number; other: number; bulk: number }`
  - `poolConfig(env?): PoolConfig` — reads `WORKER_URGENT_CONCURRENCY`, `WORKER_NORMAL_CONCURRENCY`, `WORKER_BULK_CONCURRENCY` (defaults 2/2/1), throws on non-positive-integer
  - `runPoolIteration(conn, priority, handle: (job: Job) => Promise<unknown>): Promise<boolean>` — one pop + handle; returns whether a job was handled; a throw from `handle` is caught and logged with the job id only, so one bad job never kills its loop
  - `startPools(config: PoolConfig, deps?: { connect?: () => Redis; handle?: (job: Job) => Promise<unknown> }): { stop(): Promise<void> }` — starts `config[p]` loops per priority (each with its own `connect()` connection) plus one scheduler loop calling `moveDueRetries()` every 250 ms; `stop()` ends loops and disconnects

- [ ] **Step 1: Write the failing test**

`src/lib/__tests__/pools.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
vi.mock('../metrics', () => ({ incr: vi.fn(async () => {}), setGauge: vi.fn(async () => {}) }));
vi.mock('../redis', () => ({ default: {} }));
vi.mock('../queue', () => ({
  popFrom: vi.fn(),
  moveDueRetries: vi.fn(async () => 0),
}));

import { poolConfig, runPoolIteration } from '../pools';
import { popFrom } from '../queue';

const job = { job_id: 'j', channel: 'sms', priority: 'bulk', to: 'x', template_id: 't', variables: {} };

describe('poolConfig', () => {
  it('defaults to 2/2/1', () => {
    expect(poolConfig({})).toEqual({ realtime: 2, other: 2, bulk: 1 });
  });
  it('reads overrides and rejects invalid values', () => {
    expect(poolConfig({ WORKER_URGENT_CONCURRENCY: '4' }).realtime).toBe(4);
    expect(() => poolConfig({ WORKER_BULK_CONCURRENCY: '0' })).toThrow('WORKER_BULK_CONCURRENCY');
    expect(() => poolConfig({ WORKER_NORMAL_CONCURRENCY: 'x' })).toThrow('WORKER_NORMAL_CONCURRENCY');
  });
});

describe('runPoolIteration', () => {
  it('pops from its own priority on its own connection and handles the job', async () => {
    const conn = {} as never;
    vi.mocked(popFrom).mockResolvedValueOnce(job as never);
    const handle = vi.fn(async () => {});
    expect(await runPoolIteration(conn, 'bulk', handle)).toBe(true);
    expect(popFrom).toHaveBeenCalledWith(conn, 'bulk', 1);
    expect(handle).toHaveBeenCalledWith(job);
  });

  it('returns false on an empty pop', async () => {
    vi.mocked(popFrom).mockResolvedValueOnce(null);
    expect(await runPoolIteration({} as never, 'realtime', vi.fn())).toBe(false);
  });

  it('survives a throwing handler', async () => {
    vi.mocked(popFrom).mockResolvedValueOnce(job as never);
    await expect(runPoolIteration({} as never, 'bulk', async () => { throw new Error('boom'); })).resolves.toBe(true);
  });
});
```

And an integration test `src/lib/__tests__/pools.integration.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import redis from '../redis';
import { pushToPriority, QUEUE_KEYS } from '../queue';
import { startPools } from '../pools';
import type { Job } from 'src/types';

beforeEach(async () => { await redis.del(QUEUE_KEYS.realtime, QUEUE_KEYS.other, QUEUE_KEYS.bulk, 'queue:retry'); });
afterAll(() => redis.disconnect());

describe('pools', () => {
  it('urgent loop pops while a bulk loop is blocked', async () => {
    const handled: string[] = [];
    let releaseBulk!: () => void;
    const bulkGate = new Promise<void>((r) => { releaseBulk = r; });
    const pools = startPools(
      { realtime: 1, other: 1, bulk: 1 },
      {
        connect: () => redis.duplicate(),
        handle: async (job: Job) => {
          if (job.priority === 'bulk') await bulkGate; // a bulk send that takes forever
          handled.push(job.job_id);
        },
      },
    );
    try {
      await pushToPriority({ job_id: 'b', channel: 'sms', priority: 'bulk', to: 'x', template_id: 't', variables: {} });
      await new Promise((r) => setTimeout(r, 200));
      await pushToPriority({ job_id: 'otp', channel: 'sms', priority: 'realtime', to: 'x', template_id: 't', variables: {} });
      const start = Date.now();
      while (!handled.includes('otp') && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 20));
      expect(handled).toEqual(['otp']);
    } finally {
      releaseBulk();
      await pools.stop();
    }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/lib/__tests__/pools.test.ts` and the integration command.
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/pools.ts`**

```ts
import type Redis from 'ioredis';
import redis from './redis';
import { moveDueRetries, popFrom } from './queue';
import type { Job, Priority } from 'src/types';

export interface PoolConfig { realtime: number; other: number; bulk: number }

const ENV: Record<Priority, string> = {
  realtime: 'WORKER_URGENT_CONCURRENCY',
  other: 'WORKER_NORMAL_CONCURRENCY',
  bulk: 'WORKER_BULK_CONCURRENCY',
};
const DEFAULTS: PoolConfig = { realtime: 2, other: 2, bulk: 1 };

export function poolConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const out = { ...DEFAULTS };
  for (const p of Object.keys(ENV) as Priority[]) {
    const raw = env[ENV[p]];
    if (raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${ENV[p]} must be a positive integer, got '${raw}'`);
    out[p] = n;
  }
  return out;
}

/** One pop + handle. A handler throw is contained: one bad job never ends its loop. */
export async function runPoolIteration(
  conn: Redis,
  priority: Priority,
  handle: (job: Job) => Promise<unknown>,
): Promise<boolean> {
  const job = await popFrom(conn, priority, 1);
  if (!job) return false;
  try {
    await handle(job);
  } catch (err) {
    console.error(`pool ${priority}: job ${job.job_id} failed outside processJob:`, err instanceof Error ? err.message : String(err));
  }
  return true;
}

/**
 * Separate loops per priority, each on its own blocking connection, plus one
 * scheduler that moves due retries back into their own priority's queue. Bulk
 * work can therefore never occupy an urgent loop, and a long bulk send blocks
 * only its own loop.
 */
export function startPools(
  config: PoolConfig,
  deps: { connect?: () => Redis; handle?: (job: Job) => Promise<unknown> } = {},
): { stop(): Promise<void> } {
  const connect = deps.connect ?? (() => redis.duplicate());
  const handle = deps.handle ?? (async (job: Job) => (await import('./worker')).processJob(job));
  let running = true;
  const conns: Redis[] = [];
  const loops: Promise<void>[] = [];

  for (const priority of Object.keys(config) as Priority[]) {
    for (let i = 0; i < config[priority]; i++) {
      const conn = connect();
      conns.push(conn);
      loops.push((async () => {
        while (running) {
          try {
            await runPoolIteration(conn, priority, handle);
          } catch (err) {
            if (!running) break;
            console.error(`pool ${priority}: pop failed:`, err instanceof Error ? err.message : String(err));
            await new Promise((r) => setTimeout(r, 500));
          }
        }
      })());
    }
  }

  loops.push((async () => {
    while (running) {
      try {
        await moveDueRetries();
      } catch (err) {
        console.error('retry scheduler failed:', err instanceof Error ? err.message : String(err));
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  })());

  return {
    async stop() {
      running = false;
      for (const c of conns) c.disconnect();
      await Promise.allSettled(loops);
    },
  };
}
```

- [ ] **Step 4: Replace the worker's main loop**

In `src/lib/worker.ts`, delete `mainLoop` and its use; in the `process.argv.includes('worker')` block replace `mainLoop().catch(...)` with:

```ts
  // Fail fast on bad pool config: a worker that cannot size its pools must not
  // start half-configured.
  startPools(poolConfig());
```

and import `{ poolConfig, startPools } from './pools'`. Remove now-unused imports (`popRealtime`, `popOther`, `popScheduledRetries`). Keep `processJob` exported and unchanged in this task.

- [ ] **Step 5: Run and commit**

Run: `pnpm build && pnpm test` and the integration command.
Expected: PASS.

```bash
git add src/lib/pools.ts src/lib/worker.ts src/lib/__tests__/pools.test.ts src/lib/__tests__/pools.integration.test.ts
git commit -m "feat(worker): separate worker pools per priority

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Split token bucket with a reserved urgent share

**Files:**
- Modify: `src/lib/rate_limit.ts` (replace), `src/lib/worker.ts`, `src/lib/metrics.ts` (HELP entry)
- Test: `src/lib/__tests__/rate-limit.test.ts`, `src/lib/__tests__/rate-limit.integration.test.ts`

**Interfaces:**
- Consumes: `providerConfig` (`src/lib/config/index.ts`), `deferJob` (Task 1).
- Produces:
  - `interface BucketPair { shared: { rate: number; burst: number }; reserved: { rate: number; burst: number } }`
  - `bucketsFor(channel: string, env?): BucketPair`
  - `acquireSendToken(channel: string, vendor: string, priority: Priority, env?): Promise<boolean>`
  - `rateLimitDeferMs(env?): number` (base `RATE_LIMIT_DEFER_MS` default 250, plus up to 50% jitter)

- [ ] **Step 1: Write the failing tests**

`src/lib/__tests__/rate-limit.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
vi.mock('../redis', () => ({ default: {} }));
import { bucketsFor, rateLimitDeferMs } from '../rate_limit';

describe('bucketsFor', () => {
  it('splits the channel defaults by the urgent share', () => {
    expect(bucketsFor('sms', {})).toEqual({
      reserved: { rate: 20, burst: 8 },
      shared: { rate: 80, burst: 32 },
    });
  });
  it('reads per-channel overrides and keeps each burst at least 1', () => {
    const b = bucketsFor('email', { RATE_EMAIL_PER_SEC: '2', RATE_EMAIL_BURST: '1', RATE_URGENT_SHARE: '0.1' });
    expect(b.reserved).toEqual({ rate: 0.2, burst: 1 });
    expect(b.shared).toEqual({ rate: 1.8, burst: 1 });
  });
  it('rejects an out-of-range share', () => {
    expect(() => bucketsFor('sms', { RATE_URGENT_SHARE: '1' })).toThrow('RATE_URGENT_SHARE');
    expect(() => bucketsFor('sms', { RATE_URGENT_SHARE: '0' })).toThrow('RATE_URGENT_SHARE');
  });
});

describe('rateLimitDeferMs', () => {
  it('is the base plus at most 50% jitter', () => {
    for (let i = 0; i < 50; i++) {
      const ms = rateLimitDeferMs({ RATE_LIMIT_DEFER_MS: '200' });
      expect(ms).toBeGreaterThanOrEqual(200);
      expect(ms).toBeLessThanOrEqual(300);
    }
  });
});
```

`src/lib/__tests__/rate-limit.integration.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import redis from '../redis';
import { acquireSendToken } from '../rate_limit';

const env = { RATE_SMS_PER_SEC: '0.001', RATE_SMS_BURST: '10', RATE_URGENT_SHARE: '0.2' }; // reserved burst 2, shared 8, ~no refill

beforeEach(async () => { await redis.del('rl:sms:msg91:shared', 'rl:sms:msg91:reserved'); });
afterAll(() => redis.disconnect());

async function drain(priority: 'realtime' | 'other' | 'bulk', n: number) {
  let ok = 0;
  for (let i = 0; i < n; i++) if (await acquireSendToken('sms', 'msg91', priority, env)) ok++;
  return ok;
}

describe('acquireSendToken', () => {
  it('normal and bulk can only use the shared bucket', async () => {
    expect(await drain('bulk', 20)).toBe(8);
    expect(await drain('other', 5)).toBe(0);
  });

  it('urgent uses the reserve when shared is empty', async () => {
    await drain('bulk', 20);
    expect(await drain('realtime', 5)).toBe(2);
  });

  it('urgent takes shared first, keeping the reserve for later', async () => {
    expect(await drain('realtime', 8)).toBe(8);
    expect(await drain('bulk', 5)).toBe(0);
    expect(await drain('realtime', 5)).toBe(2);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/lib/__tests__/rate-limit.test.ts` and the integration command.
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement `src/lib/rate_limit.ts`**

```ts
import redis from './redis';
import { providerConfig } from './config';
import type { Priority } from 'src/types';

export interface BucketPair {
  shared: { rate: number; burst: number };
  reserved: { rate: number; burst: number };
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a positive number, got '${raw}'`);
  return n;
}

/**
 * Vendor quota for one channel, split so a share is reserved for urgent sends.
 * A 200k broadcast exhausts the vendor account, not just NS's queues — the
 * reserve is what keeps OTPs flowing while it runs.
 */
export function bucketsFor(channel: string, env: NodeJS.ProcessEnv = process.env): BucketPair {
  const defaults = (providerConfig as Record<string, { rate: number; burst: number }>)[channel] ?? { rate: 100, burst: 50 };
  const prefix = `RATE_${channel.toUpperCase()}`;
  const rate = num(env, `${prefix}_PER_SEC`, defaults.rate);
  const burst = num(env, `${prefix}_BURST`, defaults.burst);
  const share = env.RATE_URGENT_SHARE === undefined || env.RATE_URGENT_SHARE === '' ? 0.2 : Number(env.RATE_URGENT_SHARE);
  if (!(share > 0 && share < 1)) throw new Error(`RATE_URGENT_SHARE must be between 0 and 1, got '${env.RATE_URGENT_SHARE}'`);
  const reserved = { rate: rate * share, burst: Math.max(1, Math.round(burst * share)) };
  const shared = { rate: rate - reserved.rate, burst: Math.max(1, burst - reserved.burst) };
  return { shared, reserved };
}

// Token bucket take: refill by elapsed time, take one if available. Fixed
// script; key and parameters are passed as KEYS/ARGV.
const TAKE = `
local function take(key, now, rate, cap)
  local data = redis.call('HMGET', key, 'tokens', 'ts')
  local tokens = tonumber(data[1]) or cap
  local ts = tonumber(data[2]) or now
  tokens = math.min(cap, tokens + ((now - ts) / 1000) * rate)
  local ok = 0
  if tokens >= 1 then tokens = tokens - 1; ok = 1 end
  redis.call('HSET', key, 'tokens', tokens, 'ts', now)
  redis.call('PEXPIRE', key, 60000)
  return ok
end
local now = tonumber(ARGV[1])
if take(KEYS[1], now, tonumber(ARGV[2]), tonumber(ARGV[3])) == 1 then return 1 end
if ARGV[6] == '1' then
  return take(KEYS[2], now, tonumber(ARGV[4]), tonumber(ARGV[5]))
end
return 0
`;

/**
 * Take one send token. Urgent takes the shared bucket first, then the reserve;
 * normal and bulk take the shared bucket only — they can never consume the reserve.
 */
export async function acquireSendToken(
  channel: string,
  vendor: string,
  priority: Priority,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const b = bucketsFor(channel, env);
  const base = `rl:${channel}:${vendor}`;
  const ok = await redis.eval(
    TAKE, 2, `${base}:shared`, `${base}:reserved`,
    String(Date.now()), String(b.shared.rate), String(b.shared.burst),
    String(b.reserved.rate), String(b.reserved.burst), priority === 'realtime' ? '1' : '0',
  );
  return ok === 1;
}

export function rateLimitDeferMs(env: NodeJS.ProcessEnv = process.env): number {
  const base = num(env, 'RATE_LIMIT_DEFER_MS', 250);
  return Math.round(base + Math.random() * base * 0.5);
}
```

- [ ] **Step 4: Use it in the worker**

In `processJob`, **before** `job.attempt` is incremented, after resolving `provider`:

```ts
  if (provider && !(await acquireSendToken(job.channel, provider.vendor, job.priority))) {
    await metrics.incr('ns_rate_limited_total', { channel: job.channel, priority: job.priority });
    return deferJob(job, rateLimitDeferMs());
  }
```

(Task 4 adds the deadline check on this path.) Restructure so `job.attempt = (job.attempt ?? 0) + 1` happens **after** this check. Add `ns_rate_limited_total` to the HELP map in `metrics.ts`. Add worker tests in `src/lib/__tests__/worker.test.ts` (mock `../rate_limit`): a denied token defers without incrementing `attempt`, calls no provider, writes no stamp; an allowed token proceeds as before.

- [ ] **Step 5: Run and commit**

Run: `pnpm build && pnpm test` and the integration command.
Expected: PASS.

```bash
git add src/lib/rate_limit.ts src/lib/worker.ts src/lib/metrics.ts src/lib/__tests__
git commit -m "feat(worker): split vendor quota with a reserved urgent share

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Deadlines, expiry, and no dead letters for redacted jobs

**Files:**
- Create: `src/lib/deadline.ts`, `src/lib/__tests__/deadline.test.ts`
- Modify: `src/lib/worker.ts`, `src/routes/notify.ts`, `src/lib/metrics.ts`, `src/lib/__tests__/worker.test.ts`, `src/routes/__tests__/notify.test.ts`

**Interfaces:**
- Consumes: `stamp`, `markAttempt`, `deferJob`, `pushDLQ`, `scheduleRetryWithMarker`.
- Produces:
  - `urgentDefaultDeadlineS(env?): number` (`URGENT_DEFAULT_DEADLINE_S`, default 600, positive integer)
  - `isExpired(job: Job, now?: number): boolean`
  - `wouldExpire(job: Job, delayMs: number, now?: number): boolean`
  - `isRedacted(job: Job): boolean` — `job.audit?.redactValues ?? job.priority === 'realtime'`
  - worker-internal `expire(job)` and `dropOrDeadLetter(job, reason, error?)` helpers

- [ ] **Step 1: Write the failing tests**

`src/lib/__tests__/deadline.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isExpired, isRedacted, urgentDefaultDeadlineS, wouldExpire } from '../deadline';

const base = { job_id: 'j', channel: 'sms', priority: 'other' as const, to: 'x', template_id: 't', variables: {} };

describe('deadline', () => {
  it('defaults to 600s and validates', () => {
    expect(urgentDefaultDeadlineS({})).toBe(600);
    expect(urgentDefaultDeadlineS({ URGENT_DEFAULT_DEADLINE_S: '120' })).toBe(120);
    expect(() => urgentDefaultDeadlineS({ URGENT_DEFAULT_DEADLINE_S: '0' })).toThrow('URGENT_DEFAULT_DEADLINE_S');
  });
  it('a job without a deadline never expires', () => {
    expect(isExpired(base, 1e15)).toBe(false);
    expect(wouldExpire(base, 1e12, 0)).toBe(false);
  });
  it('compares against the absolute deadline', () => {
    const j = { ...base, deadline: 1000 };
    expect(isExpired(j, 999)).toBe(false);
    expect(isExpired(j, 1001)).toBe(true);
    expect(wouldExpire(j, 500, 600)).toBe(true);
    expect(wouldExpire(j, 300, 600)).toBe(false);
  });
  it('redaction is sticky over priority', () => {
    expect(isRedacted({ ...base, priority: 'realtime' })).toBe(true);
    expect(isRedacted({ ...base, audit: { eventId: 'e', attemptId: 'a', createdAt: 'c', correlationId: 'c', redactValues: true } })).toBe(true);
    expect(isRedacted(base)).toBe(false);
  });
});
```

In `src/lib/__tests__/worker.test.ts` add (using the file's existing mocks; mock `../rate_limit` to allow):

```ts
describe('deadlines and redacted jobs', () => {
  it('an expired job is not sent, ends expired, and is not dead-lettered', async () => {
    await processJob({ ...smsJob, priority: 'realtime', deadline: Date.now() - 1 });
    expect(send).not.toHaveBeenCalled();
    expect(stamp).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ status: 'expired' }));
    expect(markAttempt).toHaveBeenCalledWith(expect.anything(), 'failed', expect.any(Number));
    expect(pushDLQ).not.toHaveBeenCalled();
  });

  it('retry past the deadline expires instead', async () => {
    send.mockResolvedValueOnce({ ok: false, error: 'timeout' });
    await processJob({ ...smsJob, priority: 'realtime', deadline: Date.now() + 1000 }); // first retry delay is 5s
    expect(scheduleRetryWithMarker).not.toHaveBeenCalled();
    expect(stamp).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ status: 'expired' }));
  });

  it('redacted jobs are never dead-lettered', async () => {
    send.mockResolvedValueOnce({ ok: false, error: 'bad template', retryable: false });
    await processJob({ ...smsJob, priority: 'realtime' });
    expect(pushDLQ).not.toHaveBeenCalled();
    expect(stamp).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ status: 'failed' }));
    expect(incr).toHaveBeenCalledWith('ns_job_dropped_total', expect.objectContaining({ reason: 'permanent_failure' }));
  });

  it('non-redacted jobs still dead-letter', async () => {
    send.mockResolvedValueOnce({ ok: false, error: 'bad template', retryable: false });
    await processJob({ ...smsJob, priority: 'other' });
    expect(pushDLQ).toHaveBeenCalled();
  });

  it('a rate-limited job past its deadline expires instead of deferring', async () => {
    vi.mocked(acquireSendToken).mockResolvedValueOnce(false);
    await processJob({ ...smsJob, priority: 'realtime', deadline: Date.now() + 10 });
    expect(deferJob).not.toHaveBeenCalled();
  });
});
```

(`smsJob` = a valid SMS job fixture already used by the file, or define one; `acquireSendToken`, `deferJob`, `markAttempt` come from the file's mocks — add them where absent. Use `rateLimitDeferMs` mocked to return 50 in the last test so `Date.now() + 10` is inside the deferral.)

In `src/routes/__tests__/notify.test.ts` add: a `realtime` request enqueues a job whose `deadline` is about `Date.now() + 600_000` (±5s); an `other` request has no `deadline`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/lib/__tests__/deadline.test.ts src/lib/__tests__/worker.test.ts src/routes/__tests__/notify.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/lib/deadline.ts`**

```ts
import type { Job } from 'src/types';

export function urgentDefaultDeadlineS(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.URGENT_DEFAULT_DEADLINE_S;
  if (raw === undefined || raw === '') return 600;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`URGENT_DEFAULT_DEADLINE_S must be a positive integer, got '${raw}'`);
  return n;
}

export function isExpired(job: Job, now = Date.now()): boolean {
  return job.deadline !== undefined && now > job.deadline;
}

/** True if something scheduled `delayMs` from now would run after the deadline. */
export function wouldExpire(job: Job, delayMs: number, now = Date.now()): boolean {
  return job.deadline !== undefined && now + delayMs > job.deadline;
}

/** OTP-class jobs: never persisted with values, never dead-lettered. Sticky (Plan A R15). */
export function isRedacted(job: Job): boolean {
  return job.audit?.redactValues ?? job.priority === 'realtime';
}
```

- [ ] **Step 4: Wire it into `processJob`**

In `src/lib/worker.ts` add helpers and use them:

```ts
/** Past its deadline: never sent. Terminal, and never dead-lettered. */
async function expire(job: Job, attemptNo: number) {
  await metrics.incr('ns_job_expired_total', { channel: job.channel });
  await markAttempt(job, 'failed', attemptNo);
  await stamp(job, { status: 'expired', attemptNo, error: 'deadline passed' });
}

/**
 * Where a job goes when it cannot be sent. Redacted (OTP) jobs are never put in
 * the DLQ — a dead-letter entry would keep a live code at rest — so they end
 * `failed` and are counted as dropped instead.
 */
async function dropOrDeadLetter(job: Job, reason: string, error?: string) {
  await markAttempt(job, 'failed', job.attempt ?? 1);
  await stamp(job, { status: 'failed', attemptNo: job.attempt ?? 1, error: error ?? reason });
  if (isRedacted(job)) {
    await metrics.incr('ns_job_dropped_total', { channel: job.channel, reason });
    return;
  }
  await metrics.incr('ns_job_dlq_total', { channel: job.channel, reason });
  return pushDLQ(job);
}
```

Then in `processJob`:
1. First statement: `if (isExpired(job)) return expire(job, (job.attempt ?? 0) + 1);`
2. Rate-limit branch (Task 3): before `deferJob`, `const wait = rateLimitDeferMs(); if (wouldExpire(job, wait)) return expire(job, (job.attempt ?? 0) + 1); return deferJob(job, wait);`
3. Replace every `markAttempt(...,'failed') + stamp(failed) + metrics dlq + pushDLQ` block (unknown channel, template not configured, unknown template, permanent failure, max retries) with `return dropOrDeadLetter(job, '<same reason>', <same error>)`, keeping the existing log lines.
4. Before scheduling a retry: `if (wouldExpire(job, delay * 1000)) return expire(job, job.attempt);`

Add `ns_job_expired_total` and `ns_job_dropped_total` to the HELP map.

- [ ] **Step 5: Give legacy realtime sends a deadline**

In `src/routes/notify.ts`, when building `job`, add for `priority === 'realtime'`:

```ts
        ...(priority === 'realtime' ? { deadline: Date.now() + urgentDefaultDeadlineS() * 1000 } : {}),
```

- [ ] **Step 6: Run and commit**

Run: `pnpm build && pnpm test` and the integration command.
Expected: PASS.

```bash
git add src/lib/deadline.ts src/lib/worker.ts src/routes/notify.ts src/lib/metrics.ts src/lib/__tests__ src/routes/__tests__
git commit -m "feat(worker): urgent deadlines; OTP jobs expire and are never dead-lettered

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Documentation

**Files:**
- Modify: `CLAUDE.md`, `README.md`, `example.env`

- [ ] **Step 1: Update docs**

- `CLAUDE.md` *Architecture → Background Worker* and *Redis Queues*: replace the single priority loop with the pool model (three queues incl. `queue:bulk`, per-priority loops each on its own blocking connection, the retry scheduler moving due retries back to their own queue, `WORKER_*_CONCURRENCY`). Remove the "Deliberately not covered yet: mainLoop's priority ordering" bullet (the loop no longer exists; pools are tested).
- New *Priority isolation* section: split bucket (keys, urgent shared-then-reserve, normal/bulk shared only, defer without counting an attempt, env vars), deadlines (`URGENT_DEFAULT_DEADLINE_S`, `expired`, retry/deferral past the deadline expires), redacted jobs never dead-lettered (`ns_job_dropped_total`).
- *Observability* table: `ns_rate_limited_total{channel,priority}`, `ns_job_expired_total{channel}`, `ns_job_dropped_total{channel,reason}`, `ns_queue_depth` gains `bulk`.
- Update the test counts.
- `README.md`: env table rows for the new variables.
- `example.env`: the new variables with one-line comments.

- [ ] **Step 2: Run and commit**

Run: `pnpm build && pnpm test`
Expected: PASS.

```bash
git add CLAUDE.md README.md example.env
git commit -m "docs: worker pools, quota split and urgent deadlines

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Done when

- `pnpm build`, `pnpm test`, `pnpm test:integration` green.
- An urgent job is handled while a bulk job is mid-send; normal/bulk can never consume the reserved share; an OTP is never retried past its deadline and never lands in the DLQ.
- Jobs queued before the deploy (`queue:realtime`, `queue:other`, `queue:retry`) still drain.
