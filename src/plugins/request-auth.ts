import crypto from 'crypto';
import { FastifyReply, FastifyRequest } from 'fastify';
import { getSecret } from '../lib/auth/secrets';
import redis from '../lib/redis';

const MAX_SKEW_SECONDS = 30;
const NONCE_TTL = 60;

export const requestAuth = async (req: FastifyRequest, reply: FastifyReply) => {
  const keyId = req.headers['x-ns-key'] as string;
  const ts = req.headers['x-ns-timestamp'] as string;
  const nonce = req.headers['x-ns-nonce'] as string;
  const sig = req.headers['x-ns-signature'] as string;

  if (!keyId || !ts || !nonce || !sig) {
    return reply.code(401).send({ error: 'Missing auth headers' });
  }

  const secret = getSecret(keyId);
  if (!secret) {
    return reply.code(401).send({ error: 'Invalid key' });
  }

  const now = Math.floor(Date.now() / 1000);
  const timestamp = Number(ts);

  if (Math.abs(now - timestamp) > MAX_SKEW_SECONDS) {
    return reply.code(401).send({ error: 'Request expired' });
  }

  const path = req.url;

  const baseString = [req.method.toUpperCase(), path, ts, nonce].join('\n');

  const expected = crypto
    .createHmac('sha256', secret)
    .update(baseString)
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const sigBuf = Buffer.from(sig.slice(3), 'hex');

  if (
    expectedBuf.length !== sigBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, sigBuf)
  ) {
    return reply.code(401).send({ error: 'Invalid signature' });
  }

  // Replay protection LAST, deliberately (#52). Claiming the nonce before the
  // signature was checked meant anyone presenting a known key id — which is not a
  // secret, it travels in every request — could burn nonce keys without proving
  // possession of the secret, and a legitimate client that signed incorrectly got
  // 'Invalid signature' once and then 'Replay detected' on every retry with the
  // same nonce, pointing the investigation at the wrong thing.
  //
  // With the order this way round the two failures are orthogonal: 'Invalid
  // signature' means the signature is wrong, and 'Replay detected' means a validly
  // signed request was seen twice — which is the only thing that is actually a replay.
  const nonceKey = `nonce:${keyId}:${nonce}`;
  const ok = await redis.set(nonceKey, '1', 'EX', NONCE_TTL, 'NX');
  if (!ok) {
    return reply.code(401).send({ error: 'Replay detected' });
  }
};
