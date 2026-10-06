import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// End to end over real Postgres + Redis: accept → queue → worker → audit.
// Only the vendor (an SMS double that renders on the provider side, like
// MSG91 Flow) and the HMAC check are stubbed.
vi.mock('../../plugins/auth', () => ({
  authenticate: () => async (req: any) => {
    req.principal = { kind: 'hmac', id: 'test-key', scopes: new Set(['notify:send', 'templates:admin']) };
  },
}));
const sms = vi.hoisted(() => ({
  sendRendered: vi.fn(async (_args: unknown) => ({ ok: true as const, provider_message_id: 'pm-1' })),
}));
vi.mock('../../lib/providers', () => ({
  providers: {
    sms: {
      name: 'sms', vendor: 'msg91', renders: 'provider',
      sendRendered: sms.sendRendered,
    },
  },
}));

process.env.NS_NETWORK = 'test_net';

const Fastify = (await import('fastify')).default;
const redis = (await import('../../lib/redis')).default;
const { closeDb, getPool } = await import('../../lib/db/client');
const { runMigrations } = await import('../../lib/db/migrate');
const { createTemplateDraft, publishTemplate } = await import('../../lib/templates/repo');
const { createPolicyDraft, publishPolicy } = await import('../../lib/policies/repo');
const { clearResolveCache } = await import('../../lib/send/resolver-cache');
const { popFrom, QUEUE_KEYS } = await import('../../lib/queue');
const { processJob } = await import('../../lib/worker');
const { v1NotifyRoutes } = await import('../v1-notify');

const OTP = '123456';
const PHONE = '+919999999999';

async function app() {
  const a = Fastify({ logger: false });
  await a.register(v1NotifyRoutes);
  await a.ready();
  return a;
}

const otpRequest = (extra: Record<string, unknown> = {}) => ({
  template_key: 'login_otp', channel: 'sms', to: { phone: PHONE },
  variables: { message: OTP }, priority: 'urgent', ...extra,
});

beforeAll(async () => { await runMigrations(); });
afterAll(async () => { await closeDb(); redis.disconnect(); });
beforeEach(async () => {
  sms.sendRendered.mockClear();
  await redis.del(...Object.values(QUEUE_KEYS), 'queue:retry', 'queue:dlq');
  await getPool().query(
    `DELETE FROM delivery_attempt; DELETE FROM notification_event; DELETE FROM idempotency_key;
     DELETE FROM notification_policy; DELETE FROM template;`,
  );
  // 1. A published login_otp SMS template whose `message` is sensitive.
  const draft = await createTemplateDraft({
    channel: 'sms', templateKey: 'login_otp', providerTemplateId: 'flow-otp-1',
    variables: [{ name: 'message', required: true, type: 'string', sensitive: true, raw: false }],
  }, 'test');
  await publishTemplate(draft.id, 'test');
});

/** Realtime stamps are fire-and-forget: wait for the row to reach `status`. */
async function attemptsOf(eventId: string, status: string) {
  return vi.waitFor(async () => {
    const { rows } = await getPool().query(
      `SELECT status, job, row_to_json(delivery_attempt)::text AS raw
         FROM delivery_attempt WHERE notification_event_id = $1`, [eventId]);
    expect(rows.map((r) => r.status)).toEqual([status]);
    return rows;
  }, { timeout: 3000, interval: 50 });
}

describe('POST /v1/notify end to end', () => {
  it('sends an urgent OTP and never persists its value', async () => {
    // 2. Accepted.
    const res = await (await app()).inject({ method: 'POST', url: '/v1/notify', payload: otpRequest() });
    expect(res.statusCode).toBe(202);
    const { notification_event_id: eventId } = res.json();
    expect(res.json()).toMatchObject({ status: 'accepted', mode: 'single', deliveries: [{ channel: 'sms' }] });

    // 3. The worker sends it with the real value, rendered by the provider.
    const job = await popFrom(redis, 'realtime', 1);
    expect(job).not.toBeNull();
    await processJob(job!);
    expect(sms.sendRendered).toHaveBeenCalledTimes(1);
    expect(sms.sendRendered).toHaveBeenCalledWith(expect.objectContaining({
      to: PHONE,
      providerTemplateId: 'flow-otp-1',
      rendered: expect.objectContaining({ variables: { message: OTP } }),
    }));

    // 4. The record: names only, no job copy, never the code.
    const [attempt] = await attemptsOf(eventId, 'sent');
    expect(attempt.job).toBeNull();
    expect(attempt.raw).not.toContain(OTP);
    const { rows: [event] } = await getPool().query(
      `SELECT delivery_mode, status, payload, payload::text AS payload_text, event_type, domain, template_key
         FROM notification_event WHERE id = $1`, [eventId]);
    expect(event).toMatchObject({ delivery_mode: 'single', status: 'sent' });
    // A template_key send: the template is the event's identity; no event type, no domain sent.
    expect(event).toMatchObject({ event_type: null, domain: null, template_key: 'login_otp' });
    expect(event.payload).toMatchObject({ to: { phone: PHONE }, variable_names: ['message'] });
    expect(event.payload_text).not.toContain(OTP);
  });

  it('answers a repeated idempotency key with the first response, queueing one job', async () => {
    const key = `otp-${randomUUID()}`;
    const a = await app();
    const first = await a.inject({ method: 'POST', url: '/v1/notify', payload: otpRequest({ idempotency_key: key }) });
    expect(first.statusCode).toBe(202);
    const second = await a.inject({ method: 'POST', url: '/v1/notify', payload: otpRequest({ idempotency_key: key }) });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(await redis.llen(QUEUE_KEYS.realtime)).toBe(1);
    // The stored replay response carries no variable values either.
    const stored = await redis.get(`idem:test_net:${key}`);
    expect(stored ?? '').not.toContain(OTP);
    await redis.del(`idem:test_net:${key}`);
  });
});

describe('POST /v1/notify — event row identity', () => {
  /** A network-wide (domain null) policy, so a recorded domain can only be the one the caller sent. */
  beforeEach(async () => {
    const draft = await createPolicyDraft(
      { domain: null, eventType: 'login', mode: 'all', channels: [{ channel: 'sms', template_key: 'login_otp' }] }, 'test');
    await publishPolicy(draft.id, 'test');
    clearResolveCache();
  });

  const eventRequest = (extra: Record<string, unknown> = {}) => ({
    event_type: 'login', to: { phone: PHONE }, variables: { message: OTP }, ...extra,
  });

  async function eventRow(eventId: string) {
    return vi.waitFor(async () => {
      const { rows } = await getPool().query(
        `SELECT event_type, domain, template_key FROM notification_event WHERE id = $1`, [eventId]);
      expect(rows).toHaveLength(1);
      return rows[0];
    }, { timeout: 3000, interval: 50 });
  }

  it('a normal event send records the event type and the domain as sent, not the matched policy domain', async () => {
    const res = await (await app()).inject({
      method: 'POST', url: '/v1/notify', payload: eventRequest({ domain: 'seeker', priority: 'normal' }),
    });
    expect(res.statusCode).toBe(202);
    const { notification_event_id: eventId } = res.json();
    expect(await eventRow(eventId)).toEqual({ event_type: 'login', domain: 'seeker', template_key: null });

    // The worker's status writes keep it; the delivered template lives on the attempt.
    await processJob((await popFrom(redis, 'other', 1))!);
    await attemptsOf(eventId, 'sent');
    expect(await eventRow(eventId)).toEqual({ event_type: 'login', domain: 'seeker', template_key: null });
    const { rows: [attempt] } = await getPool().query(
      `SELECT template_id FROM delivery_attempt WHERE notification_event_id = $1`, [eventId]);
    expect(attempt.template_id).toBe('login_otp');
  });

  it('an urgent event send without a domain records domain null (fire-and-forget insert)', async () => {
    const res = await (await app()).inject({ method: 'POST', url: '/v1/notify', payload: eventRequest({ priority: 'urgent' }) });
    expect(res.statusCode).toBe(202);
    const { notification_event_id: eventId } = res.json();
    expect(await eventRow(eventId)).toEqual({ event_type: 'login', domain: null, template_key: null });
  });

  it('the worker writes the identity when its status lands before the accepted insert', async () => {
    // Realtime: the worker's upsert can be the first writer of the event row.
    // Own variables: the 5 s content guard would answer the first test's twin 409.
    const res = await (await app()).inject({
      method: 'POST', url: '/v1/notify', payload: eventRequest({ domain: 'seeker', priority: 'urgent', variables: { message: '654321' } }),
    });
    expect(res.statusCode).toBe(202);
    const { notification_event_id: eventId } = res.json();
    await eventRow(eventId);
    await getPool().query(`DELETE FROM notification_event WHERE id = $1`, [eventId]);
    await processJob((await popFrom(redis, 'realtime', 1))!);
    expect(await eventRow(eventId)).toEqual({ event_type: 'login', domain: 'seeker', template_key: null });
  });
});
