import { FastifyReply, FastifyRequest } from 'fastify';

/**
 * HMAC key ids allowed to administer templates and policies. Separate from the
 * ability to send: editing a DLT-registered template has a compliance blast
 * radius a sending credential must not carry. Interim until Keycloak admin
 * roles (#62) replace it.
 */
export function adminKeyIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.NS_ADMIN_KEY_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Run AFTER requestAuth: the key id is only trustworthy once the signature checked out. */
export const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
  const keyId = req.headers['x-ns-key'];
  if (typeof keyId !== 'string' || !adminKeyIds().has(keyId)) {
    return reply.code(403).send({ error: 'admin scope required' });
  }
};
