export const SCOPES = ['notify:send', 'templates:admin'] as const;
export type Scope = (typeof SCOPES)[number];

export function isScope(value: unknown): value is Scope {
  return typeof value === 'string' && (SCOPES as readonly string[]).includes(value);
}

/**
 * Who is calling, as decided by `authenticate`. `id` is the HMAC key id, or for
 * a bearer token the client (`azp`) — plus the subject for a person's token.
 */
export interface Principal {
  kind: 'bearer' | 'hmac';
  id: string;
  scopes: ReadonlySet<Scope>;
}

/** Stable label for audit rows and admin `created_by`/`published_by`. */
export function principalLabel(p: Principal | undefined): string {
  return p ? `${p.kind}:${p.id}` : 'unknown';
}
