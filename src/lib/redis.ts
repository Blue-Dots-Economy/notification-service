import Redis, { type RedisOptions } from 'ioredis';

/**
 * Connection options. A password is required: the cache holds queued jobs, so
 * an unauthenticated Redis would let anything that can reach it inject sends.
 * REDIS_ALLOW_NO_AUTH=true is for local runs and CI only.
 */
export function redisOptions(env: NodeJS.ProcessEnv = process.env): RedisOptions {
  const allowNoAuth = env.REDIS_ALLOW_NO_AUTH === 'true';
  if (!env.REDIS_PASSWORD && !allowNoAuth) {
    throw new Error('REDIS_PASSWORD is required (set REDIS_ALLOW_NO_AUTH=true for local runs only)');
  }
  return {
    host: env.REDIS_HOST || '127.0.0.1',
    port: Number(env.REDIS_PORT) || 6379,
    password: env.REDIS_PASSWORD || undefined,
  };
}

const redis = new Redis(redisOptions());

export default redis;
