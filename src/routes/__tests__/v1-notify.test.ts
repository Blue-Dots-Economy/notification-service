import { beforeEach, describe, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({
  authenticate: vi.fn((_opts: unknown) => async (req: any) => {
    req.principal = { kind: 'hmac', id: 'test-key', scopes: new Set(['notify:send', 'templates:admin']) };
  }),
}));
vi.mock('../../plugins/auth', () => auth);
const plan = vi.hoisted(() => ({ planSend: vi.fn() }));
vi.mock('../../lib/send/plan', () => plan);
const idem = vi.hoisted(() => ({ claimIdempotency: vi.fn(), completeIdempotency: vi.fn(async () => {}), releaseIdempotency: vi.fn(async () => {}), fallbackKey: vi.fn(() => 'fk') }));
vi.mock('../../lib/send/idempotency', () => idem);
const store = vi.hoisted(() => ({ recordAccepted: vi.fn(async () => {}), recordAcceptedMany: vi.fn(async () => {}) }));
vi.mock('../../lib/audit/store', () => store);
const st = vi.hoisted(() => ({ stamp: vi.fn(async () => {}) }));
vi.mock('../../lib/audit/stamp', () => st);
const queue = vi.hoisted(() => ({ pushManyToPriority: vi.fn(async () => {}) }));
vi.mock('../../lib/queue', () => queue);
const met = vi.hoisted(() => ({ incr: vi.fn(async () => {}) }));
vi.mock('../../lib/metrics', () => met);
const dd = vi.hoisted(() => ({ dedupe: vi.fn(async () => true), releaseDedupe: vi.fn(async () => {}) }));
vi.mock('../../lib/dedupe', () => dd);

const Fastify = (await import('fastify')).default;
const { v1NotifyRoutes } = await import('../v1-notify');
const { SendError, StoreUnavailable } = await import('../../lib/send/errors');

const delivery = (channel: string, contentRefs: unknown[] = []) => ({ channel, contentRefs, to: channel === 'email' ? 'a@b.co' : '+919999999999', templateKey: `k_${channel}`, provider: 'msg91', providerTemplateId: 'f', rendered: { mode: 'provider', channel, providerTemplateId: 'f', variables: { name: 'A' } }, dlt: { senderId: null, dltEntityId: null, dltHeaderId: null, dltTagId: null } });

async function app() { const a = Fastify({ logger: false }); await a.register(v1NotifyRoutes); await a.ready(); return a; }
const post = async (payload: unknown) => (await app()).inject({ method: 'POST', url: '/v1/notify', payload, headers: { 'x-ns-key': 'signals' } });
const body = { event_type: 'apply', to: { phone: '+919999999999', email: 'a@b.co' }, variables: { name: 'A' } };

beforeEach(() => {
  process.env.NS_NETWORK = 'blue_dot';
  for (const m of [...Object.values(plan), ...Object.values(store), ...Object.values(queue)]) (m as ReturnType<typeof vi.fn>).mockReset?.();
  idem.releaseIdempotency.mockClear();
  idem.completeIdempotency.mockClear();
  met.incr.mockClear();
  st.stamp.mockClear();
  dd.releaseDedupe.mockClear();
  store.recordAcceptedMany.mockResolvedValue(undefined);
  queue.pushManyToPriority.mockResolvedValue(undefined);
  idem.claimIdempotency.mockResolvedValue({ status: 'fresh' });
  dd.dedupe.mockResolvedValue(true);
  plan.planSend.mockResolvedValue({ mode: 'first_available', deliveries: [delivery('sms'), delivery('email')], redact: false, variables: { name: 'A' } });
});

describe('POST /v1/notify', () => {
  it('accepts, records before queueing, and enqueues one job for first_available', async () => {
    const res = await post(body);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'accepted', mode: 'first_available', deliveries: [{ channel: 'sms' }, { channel: 'email' }] });
    expect(queue.pushManyToPriority).toHaveBeenCalledTimes(1);
    expect(store.recordAcceptedMany.mock.invocationCallOrder[0]).toBeLessThan(queue.pushManyToPriority.mock.invocationCallOrder[0]!);
    const job = queue.pushManyToPriority.mock.calls[0]![0][0];
    expect(job).toMatchObject({ priority: 'other', channel: 'sms', v1: { mode: 'first_available', index: 0 } });
    expect(job.audit).toMatchObject({ deliveryMode: 'first_available', redactValues: false });
  });

  it('fans out one job per delivery for all, under one event', async () => {
    plan.planSend.mockResolvedValue({ mode: 'all', deliveries: [delivery('sms'), delivery('email')], redact: false, variables: {} });
    await post(body);
    expect(queue.pushManyToPriority).toHaveBeenCalledTimes(1);
    const [a, b] = queue.pushManyToPriority.mock.calls[0]![0];
    expect(queue.pushManyToPriority.mock.calls[0]![0]).toHaveLength(2);
    expect(a.audit.eventId).toBe(b.audit.eventId);
    expect(a.audit.attemptId).not.toBe(b.audit.attemptId);
  });

  it('urgent is accepted when the audit store is down', async () => {
    store.recordAcceptedMany.mockRejectedValue(new Error('db down'));
    const res = await post({ ...body, priority: 'urgent' });
    expect(res.statusCode).toBe(202);
    expect(queue.pushManyToPriority.mock.calls[0]![0][0].priority).toBe('realtime');
    expect(queue.pushManyToPriority.mock.invocationCallOrder[0]).toBeLessThan(store.recordAcceptedMany.mock.invocationCallOrder[0]!);
  });

  it('normal sends are refused with 503 when the record fails, and the claim is released', async () => {
    store.recordAcceptedMany.mockRejectedValue(new Error('db down'));
    const res = await post({ ...body, idempotency_key: 'k' });
    expect(res.statusCode).toBe(503);
    expect(queue.pushManyToPriority).not.toHaveBeenCalled();
    expect(idem.releaseIdempotency).toHaveBeenCalled();
  });

  it('maps planning errors to 422 with their kind', async () => {
    plan.planSend.mockRejectedValue(new SendError('missing_variable', 'missing variable: name', { variable: 'name' }));
    const res = await post(body);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'missing_variable', kind: 'caller' });
    expect(met.incr).toHaveBeenCalledWith('ns_send_rejected_total', { kind: 'caller', code: 'missing_variable' });
    plan.planSend.mockRejectedValue(new SendError('vendor_mismatch', 'x'));
    expect((await post(body)).json()).toMatchObject({ kind: 'configuration' });
  });

  it('replays an idempotent repeat and refuses one in progress', async () => {
    idem.claimIdempotency.mockResolvedValueOnce({ status: 'replay', response: { notification_event_id: 'e1' } });
    const r1 = await post({ ...body, idempotency_key: 'k' });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({ notification_event_id: 'e1' });
    idem.claimIdempotency.mockResolvedValueOnce({ status: 'in_progress' });
    expect((await post({ ...body, idempotency_key: 'k' })).statusCode).toBe(409);
    expect(plan.planSend).not.toHaveBeenCalled();
  });

  it('a key reused with a different priority is a 409 and plans nothing', async () => {
    idem.claimIdempotency.mockResolvedValueOnce({ status: 'priority_mismatch' });
    const res = await post({ ...body, priority: 'urgent', idempotency_key: 'k' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'idempotency_key_priority_mismatch' });
    expect(plan.planSend).not.toHaveBeenCalled();
    expect(idem.releaseIdempotency).not.toHaveBeenCalled();
  });

  it('an idempotency store outage is a stable 503 that leaks no connection detail', async () => {
    const raw = 'connect ECONNREFUSED postgres://ns:secret@db:5432/notification';
    idem.claimIdempotency.mockRejectedValueOnce(new Error(raw));
    const res = await post({ ...body, idempotency_key: 'k' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'idempotency_store_unavailable' });
    expect(res.body).not.toContain('secret');
    expect(plan.planSend).not.toHaveBeenCalled();
    expect(idem.releaseIdempotency).not.toHaveBeenCalled();
  });

  it('a duplicate-guard outage (no key) is a stable 503 that leaks no connection detail', async () => {
    dd.dedupe.mockRejectedValueOnce(new Error('connect ECONNREFUSED redis://:secret@redis:6379'));
    const res = await post(body);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'idempotency_store_unavailable' });
    expect(res.body).not.toContain('secret');
    expect(plan.planSend).not.toHaveBeenCalled();
    expect(dd.releaseDedupe).not.toHaveBeenCalled();
  });

  it('a content repeat without a key is a 409 duplicate-fallback', async () => {
    dd.dedupe.mockResolvedValueOnce(false);
    const res = await post(body);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'duplicate-fallback' });
  });

  it('503 when NS_NETWORK is unset; 400 for an invalid deadline', async () => {
    delete process.env.NS_NETWORK;
    expect((await post(body)).statusCode).toBe(503);
    process.env.NS_NETWORK = 'blue_dot';
    plan.planSend.mockRejectedValue(new RangeError('deadline must be in the future'));
    expect((await post(body)).json()).toMatchObject({ error: 'invalid_deadline' });
  });

  it('refusals release the claim exactly once', async () => {
    plan.planSend.mockRejectedValue(new SendError('missing_variable', 'x'));
    await post({ ...body, idempotency_key: 'k' });
    expect(idem.releaseIdempotency).toHaveBeenCalledTimes(1);
    idem.releaseIdempotency.mockClear();
    plan.planSend.mockRejectedValue(new RangeError('deadline must be in the future'));
    await post({ ...body, idempotency_key: 'k' });
    expect(idem.releaseIdempotency).toHaveBeenCalledTimes(1);
  });

  it('an enqueue failure stamps failed, releases once, and does not complete the claim', async () => {
    queue.pushManyToPriority.mockRejectedValue(new Error('redis down'));
    const res = await post({ ...body, idempotency_key: 'k' });
    expect(res.statusCode).toBe(500);
    expect(idem.releaseIdempotency).toHaveBeenCalledTimes(1);
    expect(idem.completeIdempotency).not.toHaveBeenCalled();
    expect(st.stamp).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: 'failed', error: 'enqueue failed' }));
  });

  it('all mode: a failed enqueue stamps every job failed and releases once', async () => {
    plan.planSend.mockResolvedValue({ mode: 'all', deliveries: [delivery('sms'), delivery('email')], redact: false, variables: {} });
    queue.pushManyToPriority.mockRejectedValue(new Error('redis down'));
    await post({ ...body, idempotency_key: 'k' });
    expect(queue.pushManyToPriority).toHaveBeenCalledTimes(1);
    expect(st.stamp).toHaveBeenCalledTimes(2);
    expect(idem.releaseIdempotency).toHaveBeenCalledTimes(1);
  });

  it('releases the content guard on a refusal without a key', async () => {
    plan.planSend.mockRejectedValue(new SendError('missing_variable', 'x'));
    await post(body);
    expect(dd.releaseDedupe).toHaveBeenCalledTimes(1);
  });

  it('passes x-correlation-id through, cut to 128 characters', async () => {
    const a = await app();
    const send = (id: string) => a.inject({ method: 'POST', url: '/v1/notify', payload: body, headers: { 'x-ns-key': 'signals', 'x-correlation-id': id } });
    expect((await send('trace-1')).json().correlation_id).toBe('trace-1');
    expect((await send('x'.repeat(300))).json().correlation_id).toBe('x'.repeat(128));
  });

  it('a successful send completes the claim and does not release it', async () => {
    const res = await post({ ...body, idempotency_key: 'k' });
    expect(res.statusCode).toBe(202);
    expect(idem.completeIdempotency).toHaveBeenCalledTimes(1);
    expect(idem.releaseIdempotency).not.toHaveBeenCalled();
  });

  it('redacted records carry names only: no job copy, no values, no rendered content', async () => {
    plan.planSend.mockResolvedValue({ mode: 'single', deliveries: [delivery('sms')], redact: true, variables: { message: '123456' } });
    await post({ template_key: 'login_otp', channel: 'sms', to: { phone: '+919999999999' }, variables: { message: '123456' } });
    const recs = store.recordAcceptedMany.mock.calls[0]![0] as any[];
    expect(recs[0].source).toBe('hmac:test-key');
    expect(auth.authenticate).toHaveBeenCalledWith({ scope: 'notify:send' });
    expect(recs[0].job).toBeUndefined();
    expect(recs[0].recoverable).toBe(false);
    expect(recs[0].payload.variable_names).toEqual(['message']);
    const dump = JSON.stringify(recs);
    expect(dump).not.toContain('123456');
    expect(dump).not.toContain('"rendered"');
    expect(dump).not.toContain('providerTemplateId');
  });

  it('redacted sends carry no variable values on the job', async () => {
    plan.planSend.mockResolvedValue({ mode: 'single', deliveries: [delivery('sms')], redact: true, variables: { message: '123456' } });
    await post({ template_key: 'login_otp', channel: 'sms', to: { phone: '+919999999999' }, variables: { message: '123456' } });
    const job = queue.pushManyToPriority.mock.calls[0]![0][0];
    expect(job.variables).toEqual({});
    expect(job.audit.redactValues).toBe(true);
  });

  it('a cold template store miss with Postgres down is 503 and releases the claim', async () => {
    plan.planSend.mockRejectedValue(new StoreUnavailable());
    const res = await post({ ...body, priority: 'urgent', idempotency_key: 'k' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'template store unavailable' });
    expect(idem.releaseIdempotency).toHaveBeenCalledTimes(1);
    expect(queue.pushManyToPriority).not.toHaveBeenCalled();
    plan.planSend.mockRejectedValue(new StoreUnavailable());
    await post(body);
    expect(dd.releaseDedupe).toHaveBeenCalledTimes(1);
  });

  it('retries a failed idempotency completion once; the send still stands', async () => {
    idem.completeIdempotency.mockRejectedValueOnce(new Error('db blip'));
    const res = await post({ ...body, idempotency_key: 'k' });
    expect(res.statusCode).toBe(202);
    expect(idem.completeIdempotency).toHaveBeenCalledTimes(2);
    idem.completeIdempotency.mockClear();
    idem.completeIdempotency.mockRejectedValueOnce(new Error('db down')).mockRejectedValueOnce(new Error('db down'));
    const again = await post({ ...body, idempotency_key: 'k2' });
    expect(again.statusCode).toBe(202);
    expect(idem.completeIdempotency).toHaveBeenCalledTimes(2);
    expect(idem.releaseIdempotency).not.toHaveBeenCalled();
  });

  it('a body correlation_id wins over the header, trimmed; longer than 128 is a 400', async () => {
    const a = await app();
    const send = (payload: unknown, id?: string) =>
      a.inject({ method: 'POST', url: '/v1/notify', payload, headers: { 'x-ns-key': 'signals', ...(id ? { 'x-correlation-id': id } : {}) } });
    expect((await send({ ...body, correlation_id: '  body-1 ' }, 'hdr-1')).json().correlation_id).toBe('body-1');
    expect((await send({ ...body, correlation_id: '   ' }, 'hdr-1')).json().correlation_id).toBe('hdr-1');
    expect((await send({ ...body, correlation_id: 'x'.repeat(129) })).statusCode).toBe(400);
  });

  it('email extras ride only on jobs that can deliver by email', async () => {
    plan.planSend.mockResolvedValue({ mode: 'all', deliveries: [delivery('sms'), delivery('email')], redact: false, variables: {} });
    await post({ ...body, cc: ['c@b.co'], reply_to: 'r@b.co' });
    const [smsJob, emailJob] = queue.pushManyToPriority.mock.calls[0]![0];
    expect(smsJob.v1.email).toBeUndefined();
    expect(emailJob.v1.email).toEqual({ cc: ['c@b.co'], replyTo: 'r@b.co', attachments: undefined });
    queue.pushManyToPriority.mockClear();
    plan.planSend.mockResolvedValue({ mode: 'first_available', deliveries: [delivery('sms'), delivery('email')], redact: false, variables: {} });
    await post({ ...body, cc: ['c@b.co'] });
    expect(queue.pushManyToPriority.mock.calls[0]![0][0].v1.email).toMatchObject({ cc: ['c@b.co'] });
    queue.pushManyToPriority.mockClear();
    plan.planSend.mockResolvedValue({ mode: 'first_available', deliveries: [delivery('sms')], redact: false, variables: {} });
    await post({ ...body, cc: ['c@b.co'] });
    expect(queue.pushManyToPriority.mock.calls[0]![0][0].v1.email).toBeUndefined();
  });

  it('the event payload records every contact point the request supplied, also when redacted', async () => {
    plan.planSend.mockResolvedValue({ mode: 'all', deliveries: [delivery('sms'), delivery('email')], redact: true, variables: { message: '123456' } });
    await post({ ...body, priority: 'urgent' });
    await new Promise((r) => setImmediate(r));
    const recs = store.recordAcceptedMany.mock.calls[0]![0] as any[];
    for (const r of recs) expect(r.payload.to).toEqual({ phone: '+919999999999', email: 'a@b.co' });
    expect(JSON.stringify(recs)).not.toContain('123456');
  });
});

describe('POST /v1/notify — content refs', () => {
  const en = { key: 'tnc.in_force.url', version: 'v3', locale: 'en' };
  const hi = { key: 'tnc.in_force.url', version: 'v3', locale: 'hi' };

  it('all: each job carries only its own channel\'s refs', async () => {
    plan.planSend.mockResolvedValue({ mode: 'all', deliveries: [delivery('sms', [hi]), delivery('email', [en])], redact: false, variables: { name: 'A' } });
    await post(body);
    const [smsJob, emailJob] = queue.pushManyToPriority.mock.calls[0]![0] as any[];
    expect(smsJob.audit.contentRefs).toEqual({ sms: [hi] });
    expect(emailJob.audit.contentRefs).toEqual({ email: [en] });
    const recs = store.recordAcceptedMany.mock.calls[0]![0] as any[];
    expect(recs.map((r) => r.payload.content_refs)).toEqual([{ sms: [hi] }, { email: [en] }]);
  });

  it('first_available: the map is keyed by candidate channel', async () => {
    plan.planSend.mockResolvedValue({ mode: 'first_available', deliveries: [delivery('sms', [hi]), delivery('email', [en])], redact: false, variables: { name: 'A' } });
    await post(body);
    const job = queue.pushManyToPriority.mock.calls[0]![0][0];
    expect(job.audit.contentRefs).toEqual({ sms: [hi], email: [en] });
  });

  it('refs are de-duplicated by key, version and locale; channels without refs are omitted', async () => {
    plan.planSend.mockResolvedValue({ mode: 'first_available', deliveries: [delivery('sms', [en, en, hi]), delivery('email')], redact: true, variables: { name: 'A' } });
    await post(body);
    const job = queue.pushManyToPriority.mock.calls[0]![0][0];
    expect(job.audit.contentRefs).toEqual({ sms: [en, hi] });
  });

  it('jobs carry no contentRefs when no delivery has any', async () => {
    await post(body);
    const job = queue.pushManyToPriority.mock.calls[0]![0][0];
    expect(job.audit).not.toHaveProperty('contentRefs');
  });
});
