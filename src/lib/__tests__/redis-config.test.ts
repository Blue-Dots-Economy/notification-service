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
