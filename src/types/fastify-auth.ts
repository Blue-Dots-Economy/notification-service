import type { Principal } from '../lib/auth/principal';

declare module 'fastify' {
  interface FastifyRequest {
    /** Exact request bytes for application/json bodies (HMAC v2 digests these). */
    rawBody?: Buffer;
    /** Set by `authenticate` once a credential has been verified. */
    principal?: Principal;
  }
}

export {};
