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
