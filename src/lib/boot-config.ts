import { bearerConfig } from './auth/bearer';
import { contentConfig } from './content/resolver';
import { recoveryMaxAgeHours } from './audit/recover';
import { urgentDefaultDeadlineS } from './deadline';
import { poolConfig } from './pools';
import { resolveCacheTtlMs } from './send/resolver-cache';
import { validateWorkerConfig } from './worker';

/**
 * Parse every config value the API and its forked worker read, without starting
 * anything. The API calls this before listen: a bad value (say RATE_SMS_BURST=abc)
 * must fail the pod's boot, not kill only the worker while the API stays up and
 * keeps queueing work nothing drains.
 */
export function validateBootConfig(env: NodeJS.ProcessEnv = process.env): void {
  recoveryMaxAgeHours(env);
  urgentDefaultDeadlineS(env);
  poolConfig(env);
  resolveCacheTtlMs(env);
  validateWorkerConfig(env);
  bearerConfig(env);
  contentConfig(env);
}
