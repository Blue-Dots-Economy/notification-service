/**
 * Email attachment limits (#551).
 *
 * The relay enforces the two *resource* limits — how many attachments and how
 * many bytes it will accept and hold in Redis — and deliberately not a MIME
 * allowlist: which file types are acceptable is a per-product policy (the
 * support form's allowlist lives in the calling API), whereas queue and message
 * size are the relay's own concern.
 *
 * Env is read per call rather than at module load so the values stay
 * overridable in tests and after `loadSecrets()`.
 */

export const DEFAULT_ATTACHMENT_MAX_TOTAL_BYTES = 5 * 1024 * 1024;
export const DEFAULT_ATTACHMENT_MAX_FILES = 3;

/**
 * Headroom over the base64-inflated attachment budget for the rest of the
 * notify envelope (html body, subject, addresses, JSON syntax).
 */
const BODY_LIMIT_HEADROOM_BYTES = 256 * 1024;

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    console.warn(`${name} is not a positive integer, using default ${fallback}:`, raw);
    return fallback;
  }
  return parsed;
}

/** Total decoded attachment bytes accepted per notify request. */
export function attachmentMaxTotalBytes(): number {
  return positiveIntEnv('NOTIFY_ATTACHMENT_MAX_TOTAL_BYTES', DEFAULT_ATTACHMENT_MAX_TOTAL_BYTES);
}

/** Number of attachments accepted per notify request. */
export function attachmentMaxFiles(): number {
  return positiveIntEnv('NOTIFY_ATTACHMENT_MAX_FILES', DEFAULT_ATTACHMENT_MAX_FILES);
}

/**
 * Decoded byte length of a base64 string, without decoding it — so an
 * oversized payload is rejected before it costs a Buffer allocation.
 * Whitespace (line breaks in wrapped base64) is not counted.
 */
export function decodedBase64Length(data: string): number {
  const compact = data.replace(/\s/g, '');
  if (compact.length === 0) return 0;
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  return Math.floor((compact.length * 3) / 4) - padding;
}

/** Total decoded size of an attachment list. */
export function totalAttachmentBytes(
  attachments: ReadonlyArray<{ data: string }> | undefined
): number {
  return (attachments ?? []).reduce((sum, item) => sum + decodedBase64Length(item.data), 0);
}

/**
 * HTTP body limit for the Fastify instance, derived from the attachment budget:
 * base64 inflates payloads by 4/3, and the envelope adds the html body and the
 * other fields on top. Deriving it means raising the attachment cap can never
 * turn into a silent 413. `NOTIFY_BODY_LIMIT_BYTES` overrides it outright for
 * deployments that need a different ceiling.
 */
export function notifyBodyLimitBytes(): number {
  const derived = Math.ceil((attachmentMaxTotalBytes() * 4) / 3) + BODY_LIMIT_HEADROOM_BYTES;
  return positiveIntEnv('NOTIFY_BODY_LIMIT_BYTES', derived);
}
