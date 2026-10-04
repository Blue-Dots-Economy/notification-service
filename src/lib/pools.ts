import type Redis from 'ioredis';
import redis from './redis';
import { moveDueRetries, popFrom } from './queue';
import type { Job, Priority } from 'src/types';

export interface PoolConfig {
  realtime: number;
  other: number;
  bulk: number;
}

const ENV: Record<Priority, string> = {
  realtime: 'WORKER_URGENT_CONCURRENCY',
  other: 'WORKER_NORMAL_CONCURRENCY',
  bulk: 'WORKER_BULK_CONCURRENCY',
};
const DEFAULTS: PoolConfig = { realtime: 2, other: 2, bulk: 1 };
const SCHEDULER_BATCH = 1000; // moveDueRetries claims at most this many per call

export function poolConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const out = { ...DEFAULTS };
  for (const p of Object.keys(ENV) as Priority[]) {
    const raw = env[ENV[p]];
    if (raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`${ENV[p]} must be a positive integer, got '${raw}'`);
    }
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
    console.error(
      `pool ${priority}: job ${job.job_id} failed outside processJob:`,
      err instanceof Error ? err.message : String(err),
    );
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
  const handle = deps.handle ?? (async (job: Job) =>
      // Lazy require: worker.ts imports this module, so a top-level import would be a load-time cycle.
      (require('./worker') as typeof import('./worker')).processJob(job));
  let running = true;
  const conns: Redis[] = [];
  const loops: Promise<void>[] = [];

  for (const priority of Object.keys(config) as Priority[]) {
    for (let i = 0; i < config[priority]; i++) {
      const conn = connect();
      conns.push(conn);
      loops.push(
        (async () => {
          while (running) {
            try {
              await runPoolIteration(conn, priority, handle);
            } catch (err) {
              if (!running) break;
              console.error(
                `pool ${priority}: pop failed:`,
                err instanceof Error ? err.message : String(err),
              );
              await new Promise((r) => setTimeout(r, 500));
            }
          }
        })(),
      );
    }
  }

  loops.push(
    (async () => {
      while (running) {
        try {
          // A full batch means more may be due: go again before sleeping.
          if ((await moveDueRetries()) >= SCHEDULER_BATCH) continue;
        } catch (err) {
          console.error('retry scheduler failed:', err instanceof Error ? err.message : String(err));
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    })(),
  );

  return {
    async stop() {
      running = false;
      for (const c of conns) c.disconnect();
      await Promise.allSettled(loops);
    },
  };
}
