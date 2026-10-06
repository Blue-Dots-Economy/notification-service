import crypto from 'node:crypto';

/** Seconds a signed timestamp may differ from this server's clock. */
export const MAX_SKEW_SECONDS = 30;
/** Nonce lifetime; at least twice the skew so a nonce outlives its timestamp window. */
export const NONCE_TTL_SECONDS = 60;

const SIGNATURE = /^v2=([0-9a-f]{64})$/;

/** Lowercase hex SHA-256 of the exact request bytes; the empty string when there is no body. */
export function bodyDigest(body?: Buffer): string {
  return crypto.createHash('sha256').update(body ?? Buffer.alloc(0)).digest('hex');
}

/** HMAC v2: METHOD\npath\ntimestamp\nnonce\nsha256(body), so the body is covered. */
export function canonicalString(method: string, path: string, ts: string, nonce: string, body?: Buffer): string {
  return [method.toUpperCase(), path, ts, nonce, bodyDigest(body)].join('\n');
}

/** The `X-NS-Signature` value: `v2=<64 lowercase hex>`. */
export function signHmac(secret: string, canonical: string): string {
  return `v2=${crypto.createHmac('sha256', secret).update(canonical).digest('hex')}`;
}

/** The MAC of a `v2=<64 lowercase hex>` header; null for any other format. */
export function parseSignature(header: string): { mac: Buffer } | null {
  const m = SIGNATURE.exec(header);
  return m ? { mac: Buffer.from(m[1], 'hex') } : null;
}

export function macMatches(secret: string, canonical: string, mac: Buffer): boolean {
  const expected = crypto.createHmac('sha256', secret).update(canonical).digest();
  return expected.length === mac.length && crypto.timingSafeEqual(expected, mac);
}
