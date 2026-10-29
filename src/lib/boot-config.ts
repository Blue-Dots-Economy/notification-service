import { bearerConfig } from './auth/bearer';
import { contentConfig } from './content/resolver';
import { auditRetentionDays } from './db/retention';
import { recoveryMaxAgeHours } from './audit/recover';
import { urgentDefaultDeadlineS } from './deadline';
import { poolConfig } from './pools';
import { resolveCacheTtlMs } from './send/resolver-cache';
import { validateWorkerConfig } from './worker';

/**
 * Parse every config value the API and its forked worker read, without starting
 * anything. The API calls this before listen, so a bad value (say
 * RATE_SMS_BURST=abc) fails the pod's boot instead of killing only the worker.
 */
export function validateBootConfig(env: NodeJS.ProcessEnv = process.env): void {
  recoveryMaxAgeHours(env);
  urgentDefaultDeadlineS(env);
  poolConfig(env);
  resolveCacheTtlMs(env);
  validateWorkerConfig(env);
  bearerConfig(env);
  contentConfig(env);
  auditRetentionDays(env);
}
