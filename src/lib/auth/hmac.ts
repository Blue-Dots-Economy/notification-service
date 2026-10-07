import crypto from 'node:crypto';

export type HmacVersion = 'v1' | 'v2';

/** Seconds a signed timestamp may differ from this server's clock. */
export const MAX_SKEW_SECONDS = 30;
/** Nonce lifetime; at least twice the skew so a nonce outlives its timestamp window. */
export const NONCE_TTL_SECONDS = 60;

const SIGNATURE = /^(v1|v2)=([0-9a-f]{64})$/;

/** Lowercase hex SHA-256 of the exact request bytes; the empty string when there is no body. */
export function bodyDigest(body?: Buffer): string {
  return crypto.createHash('sha256').update(body ?? Buffer.alloc(0)).digest('hex');
}

/**
 * v2: METHOD\npath\ntimestamp\nnonce\nsha256(body) — the body is covered.
 * v1: METHOD\npath\ntimestamp\nnonce — accepted only on legacy /notify.
 */
export function canonicalString(
  version: HmacVersion,
  method: string,
  path: string,
  ts: string,
  nonce: string,
  body?: Buffer,
): string {
  const parts = [method.toUpperCase(), path, ts, nonce];
  if (version === 'v2') parts.push(bodyDigest(body));
  return parts.join('\n');
}

export function signHmac(version: HmacVersion, secret: string, canonical: string): string {
  return `${version}=${crypto.createHmac('sha256', secret).update(canonical).digest('hex')}`;
}

export function parseSignature(header: string): { version: HmacVersion; mac: Buffer } | null {
  const m = SIGNATURE.exec(header);
  return m ? { version: m[1] as HmacVersion, mac: Buffer.from(m[2], 'hex') } : null;
}

export function macMatches(secret: string, canonical: string, mac: Buffer): boolean {
  const expected = crypto.createHmac('sha256', secret).update(canonical).digest();
  return expected.length === mac.length && crypto.timingSafeEqual(expected, mac);
}
