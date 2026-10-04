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
    await expect(
      runPoolIteration({} as never, 'bulk', async () => {
        throw new Error('boom');
      }),
    ).resolves.toBe(true);
  });
});
