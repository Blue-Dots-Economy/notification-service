import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/redis', async () => {
  const { RedisFake } = await import('../../lib/__tests__/redis-fake');
  return { default: new RedisFake() };
});

const redis = (await import('../../lib/redis'))
  .default as unknown as import('../../lib/__tests__/redis-fake').RedisFake;
const { loadSecrets } = await import('../../lib/auth/secrets');
const { requestAuth } = await import('../request-auth');

const KEY_ID = 'jobstack';
const SECRET = 'ns_jobstack_secret-key';

/** Fastify reply double that records the status code and body it was sent. */
function replyDouble() {
  const reply = {
    statusCode: 0 as number,
    body: undefined as unknown,
    code(status: number) {
      reply.statusCode = status;
      return reply;
    },
    send(payload: unknown) {
      reply.body = payload;
      return reply;
    },
  };
  return reply;
}

function sign(method: string, url: string, ts: string, nonce: string, secret = SECRET) {
  const base = [method.toUpperCase(), url, ts, nonce].join('\n');
  return `v1=${crypto.createHmac('sha256', secret).update(base).digest('hex')}`;
}

function requestDouble(over: Record<string, unknown> = {}) {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = 'nonce-' + Math.floor(Date.now() % 1_000_000) + '-' + (counter += 1);
  const method = 'POST';
  const url = '/notify';
  return {
    method,
    url,
    headers: {
      'x-ns-key': KEY_ID,
      'x-ns-timestamp': ts,
      'x-ns-nonce': nonce,
      'x-ns-signature': sign(method, url, ts, nonce),
    },
    ...over,
  } as never;
}

let counter = 0;

beforeAll(() => {
  const file = path.join(os.tmpdir(), `ns-secrets-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ [KEY_ID]: { secret: SECRET } }));
  process.env.INTERNAL_SECRETS_JSON = file;
  loadSecrets();
});

beforeEach(() => {
  redis.strings.clear();
});

describe('requestAuth', () => {
  it('accepts a correctly signed request', async () => {
    const reply = replyDouble();

    await requestAuth(requestDouble(), reply as never);

    expect(reply.statusCode).toBe(0);
    expect(reply.body).toBeUndefined();
  });

  it.each([
    ['x-ns-key', 'key'],
    ['x-ns-timestamp', 'timestamp'],
    ['x-ns-nonce', 'nonce'],
    ['x-ns-signature', 'signature'],
  ])('rejects a request missing %s', async (header) => {
    const req = requestDouble() as unknown as { headers: Record<string, string> };
    delete req.headers[header];
    const reply = replyDouble();

    await requestAuth(req as never, reply as never);

    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({ error: 'Missing auth headers' });
  });

  it('rejects an unknown key id', async () => {
    const req = requestDouble() as unknown as { headers: Record<string, string> };
    req.headers['x-ns-key'] = 'not-a-client';
    const reply = replyDouble();

    await requestAuth(req as never, reply as never);

    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({ error: 'Invalid key' });
  });

  it('rejects a timestamp outside the skew window, in both directions', async () => {
    for (const offset of [-31, 31]) {
      const ts = String(Math.floor(Date.now() / 1000) + offset);
      const nonce = `skew-${offset}`;
      const reply = replyDouble();

      await requestAuth(
        requestDouble({
          headers: {
            'x-ns-key': KEY_ID,
            'x-ns-timestamp': ts,
            'x-ns-nonce': nonce,
            'x-ns-signature': sign('POST', '/notify', ts, nonce),
          },
        }),
        reply as never,
      );

      expect(reply.statusCode).toBe(401);
      expect(reply.body).toEqual({ error: 'Request expired' });
    }
  });

  it('rejects a replayed nonce', async () => {
    const req = requestDouble();
    const first = replyDouble();
    const second = replyDouble();

    await requestAuth(req, first as never);
    await requestAuth(req, second as never);

    expect(first.statusCode).toBe(0);
    expect(second.statusCode).toBe(401);
    expect(second.body).toEqual({ error: 'Replay detected' });
  });

  it('rejects a signature made with the wrong secret', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = 'wrong-secret';
    const reply = replyDouble();

    await requestAuth(
      requestDouble({
        headers: {
          'x-ns-key': KEY_ID,
          'x-ns-timestamp': ts,
          'x-ns-nonce': nonce,
          'x-ns-signature': sign('POST', '/notify', ts, nonce, 'wrong-secret'),
        },
      }),
      reply as never,
    );

    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({ error: 'Invalid signature' });
  });

  it('rejects a signature valid for a different method or path', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = 'wrong-path';
    const reply = replyDouble();

    await requestAuth(
      requestDouble({
        headers: {
          'x-ns-key': KEY_ID,
          'x-ns-timestamp': ts,
          'x-ns-nonce': nonce,
          // signed for /retry, presented on /notify
          'x-ns-signature': sign('POST', '/retry', ts, nonce),
        },
      }),
      reply as never,
    );

    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({ error: 'Invalid signature' });
  });

  it('rejects a malformed signature without throwing', async () => {
    const req = requestDouble() as unknown as { headers: Record<string, string> };
    req.headers['x-ns-signature'] = 'v1=not-hex';
    const reply = replyDouble();

    await requestAuth(req as never, reply as never);

    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({ error: 'Invalid signature' });
  });
});
