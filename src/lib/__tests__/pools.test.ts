import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../metrics', () => ({ incr: vi.fn(async () => {}), setGauge: vi.fn(async () => {}) }));
vi.mock('../redis', () => ({ default: {} }));
vi.mock('../queue', () => ({
  popFrom: vi.fn(),
  moveDueRetries: vi.fn(async () => 0),
  RETRY_BATCH: 1000,
}));

import { poolConfig, runPoolIteration, startPools } from '../pools';
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
    await expect(
      runPoolIteration({} as never, 'bulk', async () => {
        throw new Error('boom');
      }),
    ).resolves.toBe(true);
  });
});

describe('deferral backoff', () => {
  it('waits out a deferral before returning to pop again', async () => {
    vi.mocked(popFrom).mockResolvedValueOnce(job as never);
    const wait = vi.fn(async () => {});
    await runPoolIteration({} as never, 'bulk', async () => ({ deferredMs: 300 }), wait);
    expect(wait).toHaveBeenCalledWith(300);
  });

  it('does not wait after a send, a throw, or an empty pop', async () => {
    const wait = vi.fn(async () => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(popFrom).mockResolvedValueOnce(job as never);
    await runPoolIteration({} as never, 'bulk', async () => undefined, wait);
    vi.mocked(popFrom).mockResolvedValueOnce(job as never);
    await runPoolIteration({} as never, 'bulk', async () => 1, wait);
    vi.mocked(popFrom).mockResolvedValueOnce(job as never);
    await runPoolIteration({} as never, 'bulk', async () => { throw new Error('x'); }, wait);
    vi.mocked(popFrom).mockResolvedValueOnce(null);
    await runPoolIteration({} as never, 'bulk', async () => ({ deferredMs: 300 }), wait);
    expect(wait).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('a pool loop does not pop again until the deferral has elapsed', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(popFrom).mockReset().mockResolvedValue(job as never);
      const connect = () => Object.assign(new EventEmitter(), { disconnect: vi.fn() }) as never;
      const handle = vi.fn(async () => ({ deferredMs: 300 }));
      const pools = startPools({ realtime: 0, other: 0, bulk: 1 }, { connect, handle });

      await vi.advanceTimersByTimeAsync(0);
      expect(popFrom).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(299);
      expect(popFrom).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(popFrom).toHaveBeenCalledTimes(2);

      const stopped = pools.stop();
      await vi.advanceTimersByTimeAsync(1000);
      await stopped;
    } finally {
      vi.mocked(popFrom).mockReset();
      vi.useRealTimers();
    }
  });
});

describe('startPools redis error listener', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs each distinct message once per minute per connection', async () => {
    vi.mocked(popFrom).mockImplementation(() => new Promise((r) => setTimeout(() => r(null), 5)));
    const conns: EventEmitter[] = [];
    const connect = () => {
      const c = Object.assign(new EventEmitter(), { disconnect: vi.fn() });
      conns.push(c);
      return c as never;
    };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const pools = startPools({ realtime: 1, other: 0, bulk: 0 }, { connect, handle: async () => {} });
    expect(conns).toHaveLength(1);
    const redisErrors = () =>
      errSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('pool realtime redis error'));

    conns[0].emit('error', new Error('ECONNREFUSED'));
    conns[0].emit('error', new Error('ECONNREFUSED'));
    conns[0].emit('error', new Error('other failure'));
    expect(redisErrors()).toEqual([
      'pool realtime redis error: ECONNREFUSED',
      'pool realtime redis error: other failure',
    ]);

    now += 61_000;
    conns[0].emit('error', new Error('ECONNREFUSED'));
    expect(redisErrors()).toHaveLength(3);

    await pools.stop();
    vi.mocked(popFrom).mockReset();
  });
});
