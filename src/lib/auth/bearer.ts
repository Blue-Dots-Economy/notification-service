import type { JWTPayload, JWTVerifyGetKey } from 'jose' with { 'resolution-mode': 'import' };
import { isScope, type Principal, type Scope } from './principal';

export interface BearerConfig {
  issuer: string;
  jwksUri: string;
  audience: string;
  allowedAzp: ReadonlySet<string>;
}

export type BearerResult =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401 | 503; error: string };

/**
 * Bearer auth is on when NS_KEYCLOAK_ISSUER is set. The issuer must equal the
 * token's `iss` exactly (Keycloak: https://<host>/auth/realms/<realm>, no
 * trailing slash). Every service shares the realm, so the audience AND an
 * allowlisted `azp` are both required.
 */
export function bearerConfig(env: NodeJS.ProcessEnv = process.env): BearerConfig | null {
  const issuer = env.NS_KEYCLOAK_ISSUER?.trim();
  if (!issuer) return null;
  const allowedAzp = new Set(
    (env.NS_AUTH_ALLOWED_AZP ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  );
  if (allowedAzp.size === 0) {
    throw new Error('NS_AUTH_ALLOWED_AZP must list at least one client id when NS_KEYCLOAK_ISSUER is set');
  }
  const jwksUri =
    env.NS_KEYCLOAK_JWKS_URI?.trim() || `${issuer.replace(/\/+$/, '')}/protocol/openid-connect/certs`;
  new URL(jwksUri); // throws on an invalid URI, failing the boot
  return { issuer, jwksUri, audience: env.NS_AUTH_AUDIENCE?.trim() || 'notification-service', allowedAzp };
}

// jose 6 is ESM-only; this CommonJS build loads it with a dynamic import, which
// `module: Node16` emits as a real import() rather than require().
type Jose = typeof import('jose', { with: { 'resolution-mode': 'import' } });
let josePromise: Promise<Jose> | undefined;
const loadJose = (): Promise<Jose> => (josePromise ??= import('jose'));

let keyResolver: { uri: string; get: JWTVerifyGetKey } | undefined;
let testResolver: JWTVerifyGetKey | undefined;

/** Test seam: verify against a local key set instead of fetching one. */
export function setKeyResolverForTests(get?: JWTVerifyGetKey): void {
  testResolver = get;
}

function resolverFor(jose: Jose, uri: string): JWTVerifyGetKey {
  if (testResolver) return testResolver;
  // One remote set per URI: jose caches keys and rate-limits refetches on an
  // unknown `kid`, but only when the instance is reused.
  if (!keyResolver || keyResolver.uri !== uri) {
    keyResolver = { uri, get: jose.createRemoteJWKSet(new URL(uri), { cooldownDuration: 30_000, timeoutDuration: 5_000 }) };
  }
  return keyResolver.get;
}

function scopesFrom(payload: JWTPayload, audience: string): Set<Scope> {
  const access = payload.resource_access;
  if (!access || typeof access !== 'object' || !Object.prototype.hasOwnProperty.call(access, audience)) {
    return new Set();
  }
  const roles = (access as Record<string, { roles?: unknown }>)[audience]?.roles;
  return new Set(Array.isArray(roles) ? roles.filter(isScope) : []);
}

/** A key-set fetch that failed (Keycloak down or slow) — not a bad token. */
function keySetUnavailable(jose: Jose, err: unknown): boolean {
  if (err instanceof jose.errors.JWKSTimeout) return true;
  if (!(err instanceof jose.errors.JOSEError)) return true; // fetch/network errors
  // jose reports a non-200 key-set response with the base JOSEError class.
  return Object.getPrototypeOf(err) === jose.errors.JOSEError.prototype;
}

export async function verifyBearer(token: string, cfg: BearerConfig): Promise<BearerResult> {
  const jose = await loadJose();
  let payload: JWTPayload;
  try {
    ({ payload } = await jose.jwtVerify(token, resolverFor(jose, cfg.jwksUri), {
      issuer: cfg.issuer,
      audience: cfg.audience,
      algorithms: ['RS256', 'PS256', 'ES256'],
      clockTolerance: 30,
    }));
  } catch (err) {
    if (err instanceof jose.errors.JWTExpired) return { ok: false, status: 401, error: 'Token expired' };
    if (keySetUnavailable(jose, err)) return { ok: false, status: 503, error: 'Auth service unavailable' };
    return { ok: false, status: 401, error: 'Token invalid' };
  }
  // Access tokens only: Keycloak marks them typ=Bearer.
  if (typeof payload.typ === 'string' && payload.typ !== 'Bearer') {
    return { ok: false, status: 401, error: 'Token invalid' };
  }
  const azp = typeof payload.azp === 'string' ? payload.azp : undefined;
  if (!azp || !cfg.allowedAzp.has(azp)) return { ok: false, status: 401, error: 'Token client not accepted' };
  // Service-account (client_credentials) tokens carry client_id; a person's token
  // is identified by client and subject.
  const id = typeof payload.client_id === 'string' ? azp : `${azp}:${payload.sub ?? 'unknown'}`;
  return { ok: true, principal: { kind: 'bearer', id, scopes: scopesFrom(payload, cfg.audience) } };
}
