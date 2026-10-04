import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import redis from '../lib/redis';
import { bearerConfig, verifyBearer } from '../lib/auth/bearer';
import { canonicalString, macMatches, MAX_SKEW_SECONDS, NONCE_TTL_SECONDS, parseSignature } from '../lib/auth/hmac';
import type { Principal, Scope } from '../lib/auth/principal';
import { getKey } from '../lib/auth/secrets';
import '../types/fastify-auth';

export interface AuthOptions {
  /** Scope the route requires; 'any' accepts every authenticated principal. */
  scope: Scope | 'any';
  /** Accept HMAC v1 (no body digest). Legacy POST /notify only, until the cutover release removes it. */
  legacyHmacV1?: boolean;
}

const HMAC_HEADERS = ['x-ns-key', 'x-ns-timestamp', 'x-ns-nonce', 'x-ns-signature'] as const;
const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]+)$/;

type Outcome = { principal: Principal } | { status: number; error: string };

async function fromBearer(header: string): Promise<Outcome> {
  const m = BEARER.exec(header.trim());
  if (!m) return { status: 401, error: 'Malformed authorization header' };
  const cfg = bearerConfig();
  if (!cfg) return { status: 401, error: 'Bearer auth not enabled' };
  const res = await verifyBearer(m[1], cfg);
  return res.ok ? { principal: res.principal } : { status: res.status, error: res.error };
}

async function fromHmac(req: FastifyRequest, opts: AuthOptions): Promise<Outcome> {
  const [keyId, ts, nonce, sig] = HMAC_HEADERS.map((h) => req.headers[h]);
  if (typeof keyId !== 'string' || typeof ts !== 'string' || typeof nonce !== 'string' || typeof sig !== 'string' || !keyId || !ts || !nonce || !sig) {
    return { status: 401, error: 'Missing auth headers' };
  }
  const key = getKey(keyId);
  if (!key) return { status: 401, error: 'Invalid key' };

  const timestamp = Number(ts);
  if (!Number.isFinite(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > MAX_SKEW_SECONDS) {
    return { status: 401, error: 'Request expired' };
  }

  const parsed = parseSignature(sig);
  if (!parsed) return { status: 401, error: 'Invalid signature' };
  if (parsed.version === 'v1' && !opts.legacyHmacV1) return { status: 401, error: 'Signature version not accepted' };

  const canonical = canonicalString(parsed.version, req.method, req.url, ts, nonce, req.rawBody);
  if (!macMatches(key.secret, canonical, parsed.mac)) return { status: 401, error: 'Invalid signature' };

  // Nonce last: only a correctly signed request may claim one, so 'Replay
  // detected' always means a valid request seen twice.
  const claimed = await redis.set(`nonce:${keyId}:${nonce}`, '1', 'EX', NONCE_TTL_SECONDS, 'NX');
  if (!claimed) return { status: 401, error: 'Replay detected' };

  return { principal: { kind: 'hmac', id: keyId, scopes: key.scopes } };
}

/**
 * The single auth boundary. A request carries EITHER a Keycloak bearer token OR
 * an HMAC signature; both at once is refused. On success `req.principal` is set
 * and the route's scope is enforced.
 */
export function authenticate(opts: AuthOptions): preHandlerAsyncHookHandler {
  return async function auth(req: FastifyRequest, reply: FastifyReply) {
    const authorization = req.headers.authorization;
    const hasHmac = HMAC_HEADERS.some((h) => req.headers[h] !== undefined);
    if (authorization !== undefined && hasHmac) {
      return reply.code(401).send({ error: 'Ambiguous credentials' });
    }
    const outcome = authorization !== undefined ? await fromBearer(authorization) : await fromHmac(req, opts);
    if ('error' in outcome) return reply.code(outcome.status).send({ error: outcome.error });

    if (opts.scope !== 'any' && !outcome.principal.scopes.has(opts.scope)) {
      return reply.code(403).send({ error: 'Insufficient scope', required: opts.scope });
    }
    req.principal = outcome.principal;
  };
}
