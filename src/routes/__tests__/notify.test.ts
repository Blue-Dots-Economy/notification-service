import { beforeEach, describe, expect, it, vi } from 'vitest';

// Auth, dedupe and Redis each have their own tests; this file is about what the
// /notify route accepts and — crucially — what it refuses to enqueue.
vi.mock('../../plugins/request-auth', () => ({ requestAuth: async () => {} }));
// Only the Redis SET NX is doubled. `buildDedupeKey` lives in its own
// dependency-free module and is used for real, so these tests exercise the key
// the route actually derives.
const dedupe = vi.fn(async (_key: string, _ttl?: number) => true);
vi.mock('../../lib/dedupe', () => ({ dedupe: (key: string, ttl?: number) => dedupe(key, ttl) }));

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

process.env.SMTP_GMAIL = 'true';
process.env.GMAIL_USER = 'relay@example.com';
process.env.GMAIL_PASS = 'secret';
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

const post = async (payload: unknown) => {
  const app = await buildApp();
  try {
    return await app.inject({ method: 'POST', url: '/notify', payload: payload as object });
  } finally {
    await app.close();
  }
};

beforeEach(() => {
  pushRealtime.mockClear();
  pushOther.mockClear();
  dedupe.mockClear();
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
