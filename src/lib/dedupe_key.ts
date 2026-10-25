import { createHash } from 'node:crypto';

/** An explicit `dedupe_id` is a caller promise of "send this once", so it gets a
 *  window wide enough to cover a real retry storm. */
const EXPLICIT_TTL_SECONDS = 3600;
/** The fallback only swallows a byte-identical resend, so its window is short. */
const FALLBACK_TTL_SECONDS = 5;

type DedupeInput = {
  channel: string;
  to: string;
  template_id: string;
  variables: Record<string, unknown>;
  dedupe_id?: string;
};

export type BuiltDedupeKey = {
  key: string;
  ttlSeconds: number;
  /** true = the caller supplied `dedupe_id`, so suppression is what it asked for. */
  explicit: boolean;
};

/**
 * Keys are sorted recursively so the digest depends on content, not on the
 * caller's key order (which would silently disable dedupe). Arrays keep their
 * order: it is content.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Derive the dedupe key for a /notify request.
 *
 * Without `dedupe_id` the key includes a hash of the whole payload, because
 * `template_id` alone does not identify a message: Signals sends every email as
 * `basic_email` with the subject and body in `variables`.
 */
export function buildDedupeKey(body: DedupeInput): BuiltDedupeKey {
  if (body.dedupe_id)
    return { key: body.dedupe_id, ttlSeconds: EXPLICIT_TTL_SECONDS, explicit: true };

  const digest = createHash('sha256')
    .update(
      canonical({
        channel: body.channel,
        to: body.to,
        template_id: body.template_id,
        variables: body.variables,
      }),
    )
    .digest('hex')
    .slice(0, 32);

  return {
    // channel:to:template_id stays in the clear so the key remains greppable in
    // Redis; the digest is the part that carries message identity.
    key: `${body.channel}:${body.to}:${body.template_id}:${digest}`,
    ttlSeconds: FALLBACK_TTL_SECONDS,
    explicit: false,
  };
}
