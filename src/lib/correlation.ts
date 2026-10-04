/** Persisted on every event; bounded so a caller cannot write arbitrary-size values. */
export const MAX_CORRELATION_ID_LENGTH = 128;

export function correlationIdFrom(header: unknown, fallback: string): string {
  const value = typeof header === 'string' ? header.trim().slice(0, MAX_CORRELATION_ID_LENGTH) : '';
  return value || fallback;
}
