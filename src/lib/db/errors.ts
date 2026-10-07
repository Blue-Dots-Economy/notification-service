/**
 * A log-safe one-line summary of a database error.
 *
 * Drizzle wraps driver errors in `DrizzleQueryError`, whose `message` embeds the
 * full query AND every bound parameter — recipients, variables, the job copy.
 * That message must never reach a log. This keeps only the Postgres error code
 * and the driver's own message (from `cause` when wrapped), bounded in length.
 */
const MAX_LENGTH = 200;

type MaybePgError = { code?: unknown; message?: unknown; cause?: unknown };

function isWrapped(err: MaybePgError & { name?: unknown; query?: unknown; params?: unknown }): boolean {
  return err.name === 'DrizzleQueryError' || ('query' in err && 'params' in err);
}

export function describeDbError(err: unknown): string {
  if (err === null || typeof err !== 'object') return truncate(String(err));
  const outer = err as MaybePgError & { name?: unknown; query?: unknown; params?: unknown };
  let inner: MaybePgError | undefined;
  if (isWrapped(outer)) {
    // Never fall back to the wrapper's own message.
    inner = outer.cause && typeof outer.cause === 'object' ? (outer.cause as MaybePgError) : undefined;
    if (!inner) return 'database query failed';
  } else {
    inner = outer;
  }
  const code = typeof inner.code === 'string' ? inner.code : undefined;
  const message = typeof inner.message === 'string' ? inner.message : 'unknown database error';
  return truncate(code ? `[${code}] ${message}` : message);
}

function truncate(s: string): string {
  return s.length > MAX_LENGTH ? `${s.slice(0, MAX_LENGTH)}…` : s;
}
