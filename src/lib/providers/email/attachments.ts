/**
 * Email attachment limits.
 *
 * NS enforces the resource limits (attachment count and bytes held in Redis),
 * not a MIME allowlist: acceptable file types are a per-product policy owned by
 * the calling API.
 *
 * Env is read per call rather than at module load, so tests can override it.
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
 * HTTP body limit for the Fastify instance, derived from the attachment budget
 * (base64 inflates by 4/3, plus headroom for the rest of the envelope), so
 * raising the attachment cap never causes a 413. `NOTIFY_BODY_LIMIT_BYTES`
 * overrides it.
 */
export function notifyBodyLimitBytes(): number {
  const derived = Math.ceil((attachmentMaxTotalBytes() * 4) / 3) + BODY_LIMIT_HEADROOM_BYTES;
  return positiveIntEnv('NOTIFY_BODY_LIMIT_BYTES', derived);
}
