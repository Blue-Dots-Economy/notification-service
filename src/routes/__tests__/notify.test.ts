import { beforeEach, describe, expect, it, vi } from 'vitest';

// Auth, dedupe and Redis each have their own tests; this file is about what the
// /notify route accepts and — crucially — what it refuses to enqueue.
vi.mock('../../plugins/request-auth', () => ({ requestAuth: async () => {} }));
// Only the Redis SET NX is doubled. `buildDedupeKey` lives in its own
// dependency-free module and is used for real, so these tests exercise the key
// the route actually derives.
const dedupe = vi.fn(async (_key: string, _ttl?: number) => true);
const releaseDedupe = vi.fn(async (_key: string) => {});
vi.mock('../../lib/dedupe', () => ({
  dedupe: (key: string, ttl?: number) => dedupe(key, ttl),
  releaseDedupe: (key: string) => releaseDedupe(key),
}));

const { recordAccepted } = vi.hoisted(() => ({ recordAccepted: vi.fn(async (_rec: unknown) => {}) }));
vi.mock('../../lib/audit/store', () => ({ recordAccepted }));
const { stamp } = vi.hoisted(() => ({ stamp: vi.fn(async (_job: unknown, _u: unknown) => {}) }));
vi.mock('../../lib/audit/stamp', () => ({ stamp }));

const pushRealtime = vi.fn(async () => {});
const pushOther = vi.fn(async () => {});
vi.mock('../../lib/queue', () => ({ pushRealtime, pushOther }));

// The provider registry discovers providers by `require`-ing compiled index.js
// files, which only exist after a build — so the registry is stubbed with the
// real email provider. Its schema (the attachment limits under test here) is
// therefore the genuine one, not a double.
vi.mock('../../lib/providers', async () => {
  const { emailProvider } = await import('../../lib/providers/email/mailer');
  return { providers: { email: emailProvider } };
});

process.env.SMTP_HOST = 'smtp.example.com';
process.env.SMTP_USER = 'relay@example.com';
process.env.SMTP_PASS = 'secret';
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail: async () => ({ messageId: 'm' }) }) },
  createTransport: () => ({ sendMail: async () => ({ messageId: 'm' }) }),
}));

const Fastify = (await import('fastify')).default;
const { notifyRoutes } = await import('../notify');
const { attachmentMaxTotalBytes } = await import('../../lib/providers/email/attachments');

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(notifyRoutes);
  await app.ready();
  return app;
}

const attachment = (bytes: number, over: Record<string, unknown> = {}) => ({
  filename: 'evidence.png',
  contentType: 'image/png',
  data: Buffer.alloc(bytes, 7).toString('base64'),
  ...over,
});

const body = (variables: Record<string, unknown> = {}) => ({
  channel: 'email',
  to: 'support@example.com',
  template_id: 'basic_email',
  variables: {
    fromName: 'Signals Support',
    fromEmail: 'hello@example.com',
    subject: 'Complaint from Asha',
    html: '<p>details</p>',
    ...variables,
  },
});

const post = async (payload: unknown, headers: Record<string, string> = {}) => {
  const app = await buildApp();
  try {
    return await app.inject({ method: 'POST', url: '/notify', payload: payload as object, headers });
  } finally {
    await app.close();
  }
};

beforeEach(() => {
  pushRealtime.mockClear();
  pushOther.mockClear();
  dedupe.mockClear();
  releaseDedupe.mockReset().mockResolvedValue(undefined);
  dedupe.mockImplementation(async () => true);
});

describe('POST /notify — attachment limits', () => {
  it('enqueues a request carrying a max-legal attachment', async () => {
    // The whole point of the derived body limit: 5 MB of bytes is ~6.7 MB of
    // base64, which Fastify's 1 MB default would have rejected outright.
    const res = await post(body({ attachments: [attachment(attachmentMaxTotalBytes())] }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enqueued: true });
    expect(pushOther).toHaveBeenCalledTimes(1);
  });

  it('rejects a body past the derived limit with a 413, and enqueues nothing', async () => {
    // A 413 from Fastify's content-type parser short-circuits before the
    // handler, so the assertion that matters is that no job was queued: an
    // oversized payload must not reach Redis at all.
    const res = await post(body({ attachments: [attachment(attachmentMaxTotalBytes() * 2)] }));
    expect(res.statusCode).toBe(413);
    expect(pushRealtime).not.toHaveBeenCalled();
    expect(pushOther).not.toHaveBeenCalled();
  });

  it('rejects an attachment that is not base64, and enqueues nothing', async () => {
    const res = await post(
      body({
        attachments: [
          { filename: 'a.png', contentType: 'image/png', data: 'data:image/png;base64,aGVsbG8=' },
        ],
      })
    );
    expect(res.statusCode).toBe(400);
    expect(pushOther).not.toHaveBeenCalled();
  });

  it('rejects more attachments than the limit, and enqueues nothing', async () => {
    const res = await post({
      ...body({ attachments: [attachment(16), attachment(16), attachment(16), attachment(16)] }),
    });
    expect(res.statusCode).toBe(400);
    expect(pushOther).not.toHaveBeenCalled();
  });

  it('still accepts a request with no attachments at all', async () => {
    const res = await post(body());
    expect(res.statusCode).toBe(200);
    expect(pushOther).toHaveBeenCalledTimes(1);
  });
});

describe('POST /notify — duplicate suppression (#88)', () => {
  it('keys the fallback on the rendered payload, not just the template', async () => {
    await post(body());

    const [key, ttl] = dedupe.mock.calls[0]!;
    expect(key).toMatch(/^email:support@example\.com:basic_email:[0-9a-f]{32}$/);
    expect(ttl).toBe(5);
  });

  it('honours an explicit dedupe_id with the long window', async () => {
    await post({ ...body(), dedupe_id: 'item_lifecycle:profile.create:u1:item-9' });

    expect(dedupe).toHaveBeenCalledWith('item_lifecycle:profile.create:u1:item-9', 3600);
  });

  // An explicit dedupe_id means the caller asked for suppression, so a hit is
  // not an error — but it must still be distinguishable from a delivery.
  it('reports a suppressed explicit send as 200 with a reason', async () => {
    dedupe.mockImplementation(async () => false);

    const res = await post({ ...body(), dedupe_id: 'retire_cancel:a-1:u1' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enqueued: false, reason: 'duplicate' });
    expect(pushOther).not.toHaveBeenCalled();
  });

  // The fallback path is the accidental case: nobody opted in, so a hit is a
  // dropped message and must not read as success to a caller checking res.ok.
  it('reports a suppressed fallback send as 409', async () => {
    dedupe.mockImplementation(async () => false);

    const res = await post(body());

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ enqueued: false, reason: 'duplicate-fallback' });
    expect(pushOther).not.toHaveBeenCalled();
  });
});

// Request auth is mocked above, so a "signed" notify is a plain inject.
const signedNotify = (payload: unknown) => post(payload);

describe('/notify audit', () => {
  beforeEach(() => recordAccepted.mockReset().mockResolvedValue(undefined));

  it('records a normal send before queueing it, with audit ids on the job', async () => {
    const res = await signedNotify(body());
    expect(res.statusCode).toBe(200);
    expect(recordAccepted).toHaveBeenCalledTimes(1);
    const queued = (pushOther.mock.calls[0] as unknown as [{ audit: unknown }])[0];
    expect(queued.audit).toMatchObject({ eventId: expect.any(String), attemptId: expect.any(String) });
    expect(recordAccepted.mock.invocationCallOrder[0]).toBeLessThan(
      pushOther.mock.invocationCallOrder[0]!,
    );
  });

  it('returns 503 when the record fails, and queues nothing', async () => {
    recordAccepted.mockRejectedValueOnce(new Error('db down'));
    const res = await signedNotify(body());
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'audit store unavailable', enqueued: false });
    expect(pushOther).not.toHaveBeenCalled();
  });

  it('marks realtime jobs redactValues=true and normal jobs false, on the queued job', async () => {
    await signedNotify({ ...body(), priority: 'realtime' });
    await signedNotify(body({ subject: 'other one' }));
    const rt = (pushRealtime.mock.calls[0] as unknown as [{ audit: { redactValues: boolean } }])[0];
    const ot = (pushOther.mock.calls[0] as unknown as [{ audit: { redactValues: boolean } }])[0];
    expect(rt.audit.redactValues).toBe(true);
    expect(ot.audit.redactValues).toBe(false);
  });

  it('realtime still enqueues when the audit insert fails', async () => {
    recordAccepted.mockRejectedValueOnce(new Error('db down'));
    const res = await signedNotify({ ...body(), priority: 'realtime' });
    expect(res.statusCode).toBe(200);
    expect(pushRealtime).toHaveBeenCalledTimes(1);
  });

  it('releases the dedupe claim on 503, so the same request is accepted on retry', async () => {
    const claimed = new Set<string>();
    dedupe.mockImplementation(async (k: string) => !claimed.has(k) && !!claimed.add(k));
    releaseDedupe.mockImplementation(async (k: string) => void claimed.delete(k));
    const payload = { ...body(), dedupe_id: 'x-1' };

    recordAccepted.mockRejectedValueOnce(new Error('db down'));
    expect((await signedNotify(payload)).statusCode).toBe(503);
    expect(releaseDedupe).toHaveBeenCalledWith('x-1');

    const retry = await signedNotify(payload);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ enqueued: true });
    expect(recordAccepted).toHaveBeenCalledTimes(2);
    expect(pushOther).toHaveBeenCalledTimes(1);
  });

  it('marks the recorded attempt failed when the enqueue fails, and still fails the request', async () => {
    stamp.mockClear();
    pushOther.mockRejectedValueOnce(new Error('redis down'));
    const res = await signedNotify(body());
    expect(res.statusCode).toBe(500);
    expect(recordAccepted).toHaveBeenCalledTimes(1);
    expect(stamp).toHaveBeenCalledTimes(1);
    const [job, update] = stamp.mock.calls[0]!;
    expect(update).toEqual({ status: 'failed', attemptNo: 1, error: 'enqueue failed' });
    expect((job as { audit: { attemptId: string } }).audit.attemptId).toEqual(expect.any(String));
  });

  it('caps x-correlation-id at 128 chars and falls back to job_id when blank', async () => {
    await post(body(), { 'x-correlation-id': 'c'.repeat(500) });
    await post(body({ subject: 'two' }), { 'x-correlation-id': '   ' });
    await post(body({ subject: 'three' }), { 'x-correlation-id': ' corr-7 ' });
    const audits = pushOther.mock.calls.map((c) => (c as unknown as [{ job_id: string; audit: { correlationId: string } }])[0]);
    expect(audits[0]!.audit.correlationId).toBe('c'.repeat(128));
    expect(audits[1]!.audit.correlationId).toBe(audits[1]!.job_id);
    expect(audits[2]!.audit.correlationId).toBe('corr-7');
  });

  it('releases the dedupe claim when the enqueue fails, so the same dedupe_id is accepted again', async () => {
    const claimed = new Set<string>();
    dedupe.mockImplementation(async (k: string) => !claimed.has(k) && !!claimed.add(k));
    releaseDedupe.mockImplementation(async (k: string) => void claimed.delete(k));
    const payload = { ...body(), dedupe_id: 'enq-1' };

    pushOther.mockRejectedValueOnce(new Error('redis down'));
    expect((await signedNotify(payload)).statusCode).toBe(500);
    expect(releaseDedupe).toHaveBeenCalledWith('enq-1');

    const retry = await signedNotify(payload);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ enqueued: true });
  });

  it('still fails the request when the enqueue fails and releasing the claim fails too', async () => {
    pushOther.mockRejectedValueOnce(new Error('redis down'));
    releaseDedupe.mockRejectedValueOnce(new Error('redis down'));
    expect((await signedNotify(body())).statusCode).toBe(500);
  });

  it('still answers 503 when releasing the claim fails', async () => {
    recordAccepted.mockRejectedValueOnce(new Error('db down'));
    releaseDedupe.mockRejectedValueOnce(new Error('redis down'));
    const res = await signedNotify(body());
    expect(res.statusCode).toBe(503);
  });
});
