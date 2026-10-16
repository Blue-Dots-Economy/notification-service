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

// Token bucket take: refill by elapsed time, take one if available. The stored
// ts only moves forward: with clock skew between worker pods (or EVALs arriving
// out of order) an older `now` must not rewind it, or the next caller would be
// re-credited the same gap again. Fixed script; key and parameters are passed
// as KEYS/ARGV.
const TAKE = `
local function take(key, now, rate, cap)
  local data = redis.call('HMGET', key, 'tokens', 'ts')
  local tokens = tonumber(data[1]) or cap
  local ts = tonumber(data[2]) or now
  tokens = math.min(cap, tokens + (math.max(0, now - ts) / 1000) * rate)
  local ok = 0
  if tokens >= 1 then tokens = tokens - 1; ok = 1 end
  redis.call('HSET', key, 'tokens', tokens, 'ts', math.max(ts, now))
  redis.call('PEXPIRE', key, math.max(60000, math.ceil(cap / rate * 1000)))
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
