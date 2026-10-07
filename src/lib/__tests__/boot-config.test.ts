import { describe, expect, it, vi } from 'vitest';

// `../metrics` and `../redis` open connections on import; `../providers` only
// loads from compiled output. None of them is exercised by validation.
vi.mock('../metrics', () => ({ incr: vi.fn(async () => {}), setGauge: vi.fn(async () => {}) }));
vi.mock('../redis', () => ({ default: {} }));
vi.mock('../providers', () => ({
  providers: { sms: { name: 'sms', vendor: 'msg91' }, email: { name: 'email', vendor: 'smtp' } },
}));

const { validateBootConfig } = await import('../boot-config');

describe('validateBootConfig (API boot, before listen)', () => {
  it('accepts defaults', () => {
    expect(() => validateBootConfig({})).not.toThrow();
  });

  it.each([
    ['RATE_SMS_BURST', 'abc'],
    ['RATE_URGENT_SHARE', '0'],
    ['RATE_LIMIT_DEFER_MS', '-5'],
    ['PROVIDER_TIMEOUT_MS', 'x'],
    ['WORKER_URGENT_CONCURRENCY', '0'],
    ['WORKER_BULK_CONCURRENCY', '1.5'],
    ['URGENT_DEFAULT_DEADLINE_S', 'soon'],
    ['RECOVERY_MAX_AGE_HOURS', '-1'],
    ['NS_RESOLVE_CACHE_TTL_MS', 'soon'],
  ])('throws naming %s on a bad value', (key, value) => {
    expect(() => validateBootConfig({ [key]: value })).toThrow(key);
  });
});
