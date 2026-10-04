import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('clock skew and expiry', () => {
  it('a now earlier than the stored ts does not reduce tokens', async () => {
    expect(await drain('bulk', 1)).toBe(1); // stores ts = real now, 7 tokens left
    const real = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(real - 3_600_000);
    try {
      expect(await drain('bulk', 20)).toBe(7);
    } finally {
      spy.mockRestore();
    }
  });

  it('two callers with skewed clocks cannot re-credit the same gap', async () => {
    // 10/s, burst 10 (shared 8/s burst 8, reserve 2/s burst 2). Two pods whose
    // clocks differ by 20ms alternate for 1s of simulated time: a rewinding ts
    // would credit each 20ms gap twice.
    const fast = { RATE_SMS_PER_SEC: '10', RATE_SMS_BURST: '10', RATE_URGENT_SHARE: '0.2' };
    const base = Date.now();
    let t = base;
    const spy = vi.spyOn(Date, 'now');
    let granted = 0;
    try {
      for (let i = 0; i < 200; i++) {
        t = base + i * 5; // 200 steps x 5ms = 1s
        const skew = i % 2 === 0 ? 0 : -20;
        spy.mockReturnValue(t + skew);
        if (await acquireSendToken('sms', 'msg91', 'realtime', fast)) granted++;
      }
    } finally {
      spy.mockRestore();
    }
    const elapsedS = (t - base) / 1000;
    expect(granted).toBeLessThanOrEqual(Math.floor(10 * elapsedS + 10));
  });

  it('keeps a slow bucket past the 60s floor', async () => {
    await drain('bulk', 1);
    const ttl = await redis.pttl('rl:sms:msg91:shared');
    expect(ttl).toBeGreaterThan(60_000); // cap 8 / rate 0.0008 per s = 10,000,000 ms
  });
});
