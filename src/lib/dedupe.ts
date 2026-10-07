import redis from './redis.js';

export async function dedupe(key: string, ttlSeconds = 60): Promise<boolean> {
  const res = await redis.set(`dedupe:${key}`, '1', 'EX', ttlSeconds, 'NX');
  return res === 'OK';
}

/** Releases a claim made by `dedupe`, so a refused send can be retried. */
export async function releaseDedupe(key: string): Promise<void> {
  await redis.del(`dedupe:${key}`);
}
