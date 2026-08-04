import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../redis', async () => {
  const { RedisFake } = await import('./redis-fake');
  return { default: new RedisFake() };
});

const redis = (await import('../redis')).default as unknown as import('./redis-fake').RedisFake;
const { dedupe } = await import('../dedupe');

beforeEach(() => {
  redis.strings.clear();
});

describe('dedupe', () => {
  it('admits the first request for a key', async () => {
    expect(await dedupe('email:a@example.com:welcome')).toBe(true);
  });

  it('rejects a repeat of the same key inside the window', async () => {
    const key = 'email:a@example.com:welcome';

    expect(await dedupe(key)).toBe(true);
    expect(await dedupe(key)).toBe(false);
  });

  it('treats different recipients as different keys', async () => {
    expect(await dedupe('email:a@example.com:welcome')).toBe(true);
    expect(await dedupe('email:b@example.com:welcome')).toBe(true);
  });

  it('admits the key again once the window has expired', async () => {
    const key = 'email:a@example.com:welcome';

    expect(await dedupe(key, 1)).toBe(true);

    // Move past the TTL rather than sleeping.
    vi.setSystemTime(Date.now() + 2_000);
    expect(await dedupe(key, 1)).toBe(true);

    vi.useRealTimers();
  });

  it('namespaces its keys so they cannot collide with other state', async () => {
    await dedupe('sms:+911234567890:otp');

    expect([...redis.strings.keys()]).toEqual(['dedupe:sms:+911234567890:otp']);
  });
});
