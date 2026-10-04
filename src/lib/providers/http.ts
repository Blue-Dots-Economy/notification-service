const DEFAULT_PROVIDER_TIMEOUT_MS = 10_000;

/**
 * Upper bound on every vendor HTTP call. Without one, a vendor that accepts the
 * connection and never answers holds a worker loop (and its job) indefinitely.
 */
export function providerTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PROVIDER_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_PROVIDER_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`PROVIDER_TIMEOUT_MS must be a positive integer, got '${raw}'`);
  }
  return n;
}

/** True for the error `fetch` raises when `AbortSignal.timeout` fires (or any abort). */
export function isTimeoutError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}
