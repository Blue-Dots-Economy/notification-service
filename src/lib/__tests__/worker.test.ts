import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'src/types';
import type { PlannedDelivery } from '../send/plan';

// The queue is mocked rather than faked here: these tests are about which queue
// call processJob makes and with what delay, not about Redis behaviour (that is
// queue.test.ts's job).
// `../metrics` opens a Redis connection on import, which would keep the test
// process alive. The DLQ counters it records are asserted via this mock.
const { incr } = vi.hoisted(() => ({ incr: vi.fn(async () => {}) }));
vi.mock('../metrics', () => ({
  incr,
  setGauge: vi.fn(async () => {}),
  renderPrometheus: vi.fn(async () => ''),
}));

const { stamp } = vi.hoisted(() => ({ stamp: vi.fn(async () => {}) }));
vi.mock('../audit/stamp', () => ({ stamp }));

const { markAttempt } = vi.hoisted(() => ({ markAttempt: vi.fn(async () => {}) }));
vi.mock('../audit/marker', () => ({
  markAttempt,
  attemptMarker: (j: Job, fate: string, n: number) =>
    j.audit ? { key: `ns:attempt:${j.audit.attemptId}`, value: `${fate}:${n}`, ttlSeconds: 604800 } : undefined,
}));

const { acquireSendToken } = vi.hoisted(() => ({ acquireSendToken: vi.fn(async () => true) }));
vi.mock('../redis', () => ({ default: {} }));
vi.mock('../rate_limit', async () => {
  const actual = await vi.importActual<typeof import('../rate_limit')>('../rate_limit');
  return {
    acquireSendToken,
    bucketsFor: actual.bucketsFor,
    // Parses (and so validates) an explicit env, like the real one; fixed otherwise.
    rateLimitDeferMs: (env?: NodeJS.ProcessEnv) => (env ? (actual.rateLimitDeferMs(env), 321) : 321),
  };
});

vi.mock('../queue', () => ({
  deferJob: vi.fn(async () => {}),
  pushDLQ: vi.fn(async () => 1),
  pushToPriority: vi.fn(async () => {}),
  pushToPriorityWithMarker: vi.fn(async () => {}),
  scheduleRetryWithMarker: vi.fn(async () => 1),
  popRealtime: vi.fn(async () => null),
  popOther: vi.fn(async () => null),
  popScheduledRetries: vi.fn(async () => []),
}));

// ../providers auto-discovers by reading the directory and `require`-ing each
// index.js, which only exists in compiled output — so it has to be mocked to be
// importable from source at all, quite apart from controlling send() outcomes.
const send = vi.fn(
  async () => ({ ok: true }) as { ok: boolean; error?: string; retryable?: boolean }
);
type SendResult = { ok: boolean; error?: string; retryable?: boolean; provider_message_id?: string };
const smsSendRendered = vi.fn(async (_args: unknown): Promise<SendResult> => ({ ok: true }));
const emailSendRendered = vi.fn(async (_args: unknown): Promise<SendResult> => ({ ok: true }));
vi.mock('../providers', () => ({
  providers: {
    email: {
      name: 'email',
      vendor: 'smtp',
      templates: { welcome: 'provider-template-123' },
      schema: { safeParse: () => ({ success: true, data: {} }) },
      send,
      sendRendered: emailSendRendered,
    },
    // Mirrors the SMS shape: raw ids pass through, one named template carries a
    // provider-owned body, and a named template with no id is the "DLT approval
    // has not landed yet" placeholder.
    sms: {
      name: 'sms',
      vendor: 'msg91',
      templates: { login_otp: 'DLT-1', pending_case: '', blank_body: 'DLT-2' },
      bodies: { login_otp: '{{message}} is your OTP', blank_body: '' },
      allowRawTemplateId: true,
      schema: { safeParse: () => ({ success: true, data: {} }) },
      send,
      sendRendered: smsSendRendered,
    },
    // A channel whose provider predates sendRendered.
    whatsapp: {
      name: 'whatsapp',
      vendor: 'twilio',
      templates: {},
      schema: { safeParse: () => ({ success: true, data: {} }) },
      send,
    },
  },
}));

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('node:child_process', () => ({ fork }));

const queue = await import('../queue');
const { processJob, spawnWorker, validateWorkerConfig } = await import('../worker');

/** A planned delivery on `channel`, with the vendor the mocked provider has. */
const delivery = (channel: string) =>
  ({
    channel,
    to: channel === 'email' ? 'someone@example.com' : '+910000000000',
    templateKey: `k_${channel}`,
    provider: channel === 'email' ? 'smtp' : 'msg91',
    providerTemplateId: 'f',
    rendered: { mode: 'provider', channel, providerTemplateId: 'f', variables: {} },
    dlt: { senderId: null, dltEntityId: null, dltHeaderId: null, dltTagId: null },
  }) as unknown as PlannedDelivery;

/** A single-delivery v1 email job: it never falls through, so its fate is the shared one. */
const job = (over: Partial<Job> = {}): Job => ({
  job_id: 'job-1',
  channel: 'email',
  priority: 'other',
  to: 'someone@example.com',
  template_id: 'welcome',
  variables: {},
  v1: { mode: 'all', deliveries: [delivery('email')], index: 0 },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  send.mockResolvedValue({ ok: true });
  smsSendRendered.mockResolvedValue({ ok: true });
  emailSendRendered.mockResolvedValue({ ok: true });
  acquireSendToken.mockResolvedValue(true);
});

describe('validateWorkerConfig', () => {
  it('accepts defaults', () => {
    expect(() => validateWorkerConfig({})).not.toThrow();
  });
  it.each([
    ['RATE_EMAIL_PER_SEC', '-1'],
    ['RATE_SMS_BURST', 'abc'],
    ['RATE_URGENT_SHARE', '1'],
    ['RATE_LIMIT_DEFER_MS', '0'],
    ['PROVIDER_TIMEOUT_MS', 'x'],
  ])('throws naming %s', (key, value) => {
    expect(() => validateWorkerConfig({ [key]: value })).toThrow(key);
  });
});

describe('spawnWorker', () => {
  it('exits the API with the worker exit code when the worker dies', async () => {
    const { EventEmitter } = await import('node:events');
    const child = new EventEmitter();
    fork.mockReturnValueOnce(child);
    const exit = vi.fn() as unknown as (code: number) => never;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    spawnWorker(exit);
    expect(fork).toHaveBeenCalledWith(expect.any(String), ['worker']);
    expect(exit).not.toHaveBeenCalled();

    child.emit('exit', 3, null);
    expect(exit).toHaveBeenCalledWith(3);
  });

  it('exits non-zero when the worker was killed by a signal', async () => {
    const { EventEmitter } = await import('node:events');
    const child = new EventEmitter();
    fork.mockReturnValueOnce(child);
    const exit = vi.fn() as unknown as (code: number) => never;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    spawnWorker(exit);
    child.emit('exit', null, 'SIGKILL');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('defaults to process.exit', async () => {
    const { EventEmitter } = await import('node:events');
    const child = new EventEmitter();
    fork.mockReturnValueOnce(child);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    spawnWorker();
    child.emit('exit', 2, null);
    expect(exitSpy).toHaveBeenCalledWith(2);
    exitSpy.mockRestore();
  });
});


describe('processJob — a job with no v1 plan', () => {
  // Recovery (24 h) or a DLQ replay can still hand the worker a job queued by
  // the removed legacy /notify. It is dead-lettered, never sent and never thrown.
  const legacyJob = (over: Record<string, unknown> = {}) =>
    ({
      job_id: 'j1', channel: 'sms', priority: 'other', to: '+911234567890',
      template_id: 'login_otp', variables: { message: '1' }, ...over,
    }) as unknown as Job;
  const audit = { eventId: 'e', attemptId: 'att-1', createdAt: '2026-10-04T00:00:00.000Z', correlationId: 'c' };

  it('a job with no v1 plan is dead-lettered as legacy_job_shape', async () => {
    const j = legacyJob();
    await expect(processJob(j)).resolves.not.toThrow();
    expect(queue.pushDLQ).toHaveBeenCalledWith(j);
    expect(incr).toHaveBeenCalledWith('ns_job_dlq_total', { channel: 'sms', reason: 'legacy_job_shape' });
    expect(send).not.toHaveBeenCalled();
    expect(smsSendRendered).not.toHaveBeenCalled();
    expect(emailSendRendered).not.toHaveBeenCalled();
    expect(acquireSendToken).not.toHaveBeenCalled();
    expect(queue.scheduleRetryWithMarker).not.toHaveBeenCalled();
  });

  it('closes the attempt it was popped for: marker and stamp failed with the reason', async () => {
    // Recovery pushes attempt = attempt_no - 1, so the row being closed is attempt + 1.
    await processJob(legacyJob({ attempt: 2, audit }));
    expect(markAttempt).toHaveBeenCalledWith(expect.anything(), 'failed', 3);
    expect(stamp.mock.calls.map((c) => c[1])).toEqual([{ status: 'failed', attemptNo: 3, error: 'legacy_job_shape' }]);
  });

  it('a DLQ replay of a legacy job (attempt reset, fresh attempt id) is dead-lettered again', async () => {
    const j = legacyJob({ attempt: 0, replays: 1, deadline: undefined, audit: { ...audit, attemptId: 'att-2' } });
    await processJob(j);
    expect(queue.pushDLQ).toHaveBeenCalledWith(j);
    expect(stamp).toHaveBeenLastCalledWith(j, { status: 'failed', attemptNo: 1, error: 'legacy_job_shape' });
    expect(send).not.toHaveBeenCalled();
  });

  it('a redacted legacy job is dropped, not dead-lettered, like every redacted failure', async () => {
    await processJob(legacyJob({ priority: 'realtime' }));
    expect(queue.pushDLQ).not.toHaveBeenCalled();
    expect(incr).toHaveBeenCalledWith('ns_job_dropped_total', { channel: 'sms', reason: 'legacy_job_shape' });
    expect(incr).not.toHaveBeenCalledWith('ns_job_dlq_total', expect.anything());
  });

  it.each([
    ['null', null],
    ['false', false],
  ])('v1: %s is a legacy shape too', async (_label, v1) => {
    await processJob(legacyJob({ v1 }));
    expect(incr).toHaveBeenCalledWith('ns_job_dlq_total', { channel: 'sms', reason: 'legacy_job_shape' });
  });

  it('dead-letters even past its deadline or on an unknown channel, without throwing', async () => {
    await expect(processJob(legacyJob({ deadline: Date.now() - 1 }))).resolves.not.toThrow();
    await expect(processJob(legacyJob({ channel: 'carrier-pigeon' }))).resolves.not.toThrow();
    expect(incr).toHaveBeenCalledWith('ns_job_dlq_total', { channel: 'sms', reason: 'legacy_job_shape' });
    expect(incr).toHaveBeenCalledWith('ns_job_dlq_total', { channel: 'carrier-pigeon', reason: 'legacy_job_shape' });
    expect(incr).not.toHaveBeenCalledWith('ns_job_expired_total', expect.anything());
  });
});

// The suites below drive the shared machinery (token, ladder, stamps, markers,
// deadlines, redaction) through single-delivery v1 jobs: a one-delivery `all`
// job never falls through, so its fate is the shared one.
describe('processJob — rate limit', () => {
  it('defers (does not lose) the job when the token check itself fails', async () => {
    vi.spyOn(console, 'error').mockImplementationOnce(() => {});
    acquireSendToken.mockRejectedValueOnce(new Error('redis down'));
    const j = job({ attempt: 1 });

    expect(await processJob(j)).toEqual({ deferredMs: 321 });

    expect(queue.deferJob).toHaveBeenCalledWith(j, 321);
    expect(j.attempt).toBe(1);
    expect(emailSendRendered).not.toHaveBeenCalled();
  });

  it('lets a failing defer propagate', async () => {
    vi.spyOn(console, 'error').mockImplementationOnce(() => {});
    acquireSendToken.mockRejectedValueOnce(new Error('redis down'));
    vi.mocked(queue.deferJob).mockRejectedValueOnce(new Error('still down'));
    await expect(processJob(job())).rejects.toThrow('still down');
  });

  it('defers a denied token without counting an attempt, calling the provider or stamping', async () => {
    acquireSendToken.mockResolvedValueOnce(false);
    const j = job({ attempt: 2, priority: 'bulk' });

    expect(await processJob(j)).toEqual({ deferredMs: 321 });

    expect(queue.deferJob).toHaveBeenCalledWith(j, 321);
    expect(j.attempt).toBe(2);
    expect(emailSendRendered).not.toHaveBeenCalled();
    expect(stamp).not.toHaveBeenCalled();
    expect(markAttempt).not.toHaveBeenCalled();
    expect(queue.pushDLQ).not.toHaveBeenCalled();
    expect(incr).toHaveBeenCalledWith('ns_rate_limited_total', { channel: 'email', priority: 'bulk' });
  });

  it('proceeds when a token is granted', async () => {
    const j = job({ priority: 'realtime' });

    expect(await processJob(j)).toBeUndefined(); // not a deferral

    expect(acquireSendToken).toHaveBeenCalledWith('email', 'smtp', 'realtime');
    expect(queue.deferJob).not.toHaveBeenCalled();
    expect(j.attempt).toBe(1);
    expect(emailSendRendered).toHaveBeenCalledTimes(1);
  });
});

describe('processJob — attempt counting', () => {
  it('counts a first attempt as 1 when the job has no counter yet', async () => {
    const j = job();
    await processJob(j);
    expect(j.attempt).toBe(1);
  });

  it('increments an existing counter', async () => {
    const j = job({ attempt: 2 });
    await processJob(j);
    expect(j.attempt).toBe(3);
  });
});

describe('processJob — backoff ladder on failure', () => {
  beforeEach(() => {
    emailSendRendered.mockResolvedValue({ ok: false, error: 'provider said no' });
  });

  it.each([
    [undefined, 1, 5],
    [1, 2, 10],
    [2, 3, 20],
    [3, 4, 40],
  ])(
    'incoming attempt %s becomes %i and reschedules in %is',
    async (incoming, expectedAttempt, expectedDelay) => {
      const j = job({ attempt: incoming as number | undefined });

      await processJob(j);

      expect(j.attempt).toBe(expectedAttempt);
      expect(queue.scheduleRetryWithMarker).toHaveBeenCalledWith(j, expectedDelay, undefined);
      expect(queue.pushDLQ).not.toHaveBeenCalled();
    },
  );

  it('dead-letters instead of retrying once MAX_RETRIES is reached', async () => {
    const j = job({ attempt: 4 }); // becomes the 5th attempt

    await processJob(j);

    expect(j.attempt).toBe(5);
    expect(queue.pushDLQ).toHaveBeenCalledWith(j);
    expect(queue.scheduleRetryWithMarker).not.toHaveBeenCalled();
  });

  it('dead-letters a job that somehow arrives past the limit', async () => {
    await processJob(job({ attempt: 9 }));

    expect(queue.pushDLQ).toHaveBeenCalledTimes(1);
    expect(queue.scheduleRetryWithMarker).not.toHaveBeenCalled();
  });

  it('gives four retries before the DLQ — 5s, 10s, 20s, 40s', async () => {
    const j = job();

    for (let i = 0; i < 5; i += 1) await processJob(j);

    expect(vi.mocked(queue.scheduleRetryWithMarker).mock.calls.map((c) => c[1])).toEqual([5, 10, 20, 40]);
    expect(queue.pushDLQ).toHaveBeenCalledTimes(1);
  });
});

describe('processJob — permanent failures', () => {
  it('dead-letters immediately when the provider says the failure is permanent', async () => {
    emailSendRendered.mockResolvedValueOnce({ ok: false, error: 'template not registered', retryable: false });
    const j = job();
    await processJob(j);
    expect(queue.pushDLQ).toHaveBeenCalledWith(j);
    expect(queue.scheduleRetryWithMarker).not.toHaveBeenCalled();
  });

  it('keeps retrying when the provider expresses no opinion', async () => {
    emailSendRendered.mockResolvedValueOnce({ ok: false, error: 'vendor 503' });
    await processJob(job());
    expect(queue.scheduleRetryWithMarker).toHaveBeenCalledTimes(1);
    expect(queue.pushDLQ).not.toHaveBeenCalled();
  });
});

describe('processJob — DLQ paths are observable', () => {
  it('counts a permanent-failure dead-letter', async () => {
    emailSendRendered.mockResolvedValue({ ok: false, retryable: false });
    await processJob(job());
    expect(incr).toHaveBeenCalledWith('ns_job_dlq_total', expect.objectContaining({ reason: 'permanent_failure' }));
  });

  it('counts a max-retries dead-letter', async () => {
    emailSendRendered.mockResolvedValue({ ok: false });
    await processJob(job({ attempt: 4 }));
    expect(incr).toHaveBeenCalledWith('ns_job_dlq_total', expect.objectContaining({ reason: 'max_retries' }));
  });
});

describe('processJob — a provider that throws must not lose the job', () => {
  it('retries instead of dropping the notification', async () => {
    // The job is already popped and not yet in the DLQ, so an escaping throw
    // would lose it with no record anywhere.
    emailSendRendered.mockRejectedValue(new Error('boom'));

    await processJob(job());

    expect(queue.scheduleRetryWithMarker).toHaveBeenCalledTimes(1);
    expect(queue.pushDLQ).not.toHaveBeenCalled();
  });

  it('still dead-letters a thrower once the ladder is exhausted', async () => {
    emailSendRendered.mockRejectedValue(new Error('boom'));

    await processJob(job({ attempt: 4 }));

    expect(queue.pushDLQ).toHaveBeenCalledTimes(1);
  });
});

describe('processJob audit stamping', () => {
  it('stamps dispatching then sent on success', async () => {
    await processJob(job());
    expect(stamp.mock.calls.map((c) => c[1])).toEqual([
      { status: 'dispatching', attemptNo: 1 },
      { status: 'sent', attemptNo: 1, providerMessageId: undefined },
    ]);
  });

  it('stamps queued for the next attempt when a retry is scheduled', async () => {
    emailSendRendered.mockResolvedValueOnce({ ok: false, error: 'timeout' });
    await processJob(job());
    expect(stamp.mock.calls.at(-1)?.[1]).toEqual({ status: 'queued', attemptNo: 2, error: 'timeout' });
  });

  it('stamps failed when dead-lettered', async () => {
    emailSendRendered.mockResolvedValueOnce({ ok: false, error: 'bad template', retryable: false });
    await processJob(job());
    expect(stamp.mock.calls.at(-1)?.[1]).toEqual({ status: 'failed', attemptNo: 1, error: 'bad template' });
  });

  it('stamps failed with max_retries when the ladder is exhausted', async () => {
    emailSendRendered.mockResolvedValueOnce({ ok: false });
    await processJob(job({ attempt: 4 }));
    expect(stamp.mock.calls.at(-1)?.[1]).toEqual({ status: 'failed', attemptNo: 5, error: 'max_retries' });
  });
});

describe('processJob attempt markers', () => {
  it('marks sent before the sent stamp', async () => {
    await processJob(job());
    expect(markAttempt).toHaveBeenCalledWith(expect.anything(), 'sent', 1);
    const sentStamp = stamp.mock.calls.findIndex((c) => (c[1] as { status: string }).status === 'sent');
    expect(markAttempt.mock.invocationCallOrder[0]).toBeLessThan(stamp.mock.invocationCallOrder[sentStamp]!);
  });

  // The row must stay `dispatching` until the retry and its marker are in
  // Redis: the stale-dispatch sweep then re-queues a crash before the MULTI (no
  // marker) and leaves a crash after it alone (marker). Stamped `queued` first,
  // a crash in between was a lost `queued` row the sweep never picks up.
  it('schedules the retry and its marker together, then stamps queued (no separate marker write)', async () => {
    emailSendRendered.mockResolvedValueOnce({ ok: false, error: 'timeout' });
    const audit = { eventId: 'e', attemptId: 'att-1', createdAt: '2026-10-04T00:00:00.000Z', correlationId: 'c' };
    await processJob(job({ audit }));
    expect(markAttempt).not.toHaveBeenCalled();
    expect(queue.scheduleRetryWithMarker).toHaveBeenCalledWith(expect.anything(), 5, {
      key: 'ns:attempt:att-1', value: 'retry:2', ttlSeconds: 604800,
    });
    expect(stamp.mock.calls.at(-1)?.[1]).toMatchObject({ status: 'queued', attemptNo: 2 });
    expect(vi.mocked(queue.scheduleRetryWithMarker).mock.invocationCallOrder[0]!).toBeLessThan(
      stamp.mock.invocationCallOrder.at(-1)!,
    );
  });

  it('leaves the row dispatching when scheduling the retry fails, so the stale sweep recovers it', async () => {
    emailSendRendered.mockResolvedValueOnce({ ok: false, error: 'timeout' });
    stamp.mockClear();
    vi.mocked(queue.scheduleRetryWithMarker).mockRejectedValueOnce(new Error('redis down'));
    await expect(processJob(job())).rejects.toThrow('redis down');
    expect(stamp.mock.calls.map((c) => (c[1] as { status: string }).status)).toEqual(['dispatching']);
  });

  it('marks failed on every dead-letter path', async () => {
    emailSendRendered.mockResolvedValueOnce({ ok: false, error: 'bad', retryable: false });
    await processJob(job());
    await processJob(job({ v1: { mode: 'all', deliveries: [delivery('pigeon')], index: 0 } }));
    await processJob({ job_id: 'legacy', channel: 'sms', priority: 'other', to: 'x', template_id: 't', variables: {} });
    expect(markAttempt.mock.calls.map((c) => [c[1], c[2]])).toEqual([['failed', 1], ['failed', 1], ['failed', 1]]);
  });
});

describe('deadlines and redacted jobs', () => {
  const smsJob = (over: Partial<Job> = {}) =>
    job({
      channel: 'sms', template_id: 'login_otp', to: '+910000000000', variables: { message: '1' },
      v1: { mode: 'all', deliveries: [delivery('sms')], index: 0 }, ...over,
    });

  it('an expired job is not sent, ends expired, and is not dead-lettered', async () => {
    await processJob(smsJob({ priority: 'realtime', deadline: Date.now() - 1 }));
    expect(smsSendRendered).not.toHaveBeenCalled();
    expect(stamp).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ status: 'expired' }));
    expect(markAttempt).toHaveBeenCalledWith(expect.anything(), 'expired', 1);
    expect(markAttempt).not.toHaveBeenCalledWith(expect.anything(), 'failed', expect.anything());
    expect(incr).toHaveBeenCalledWith('ns_job_expired_total', { channel: 'sms' });
    expect(queue.pushDLQ).not.toHaveBeenCalled();
  });

  it('retry past the deadline expires instead', async () => {
    smsSendRendered.mockResolvedValueOnce({ ok: false, error: 'timeout' });
    await processJob(smsJob({ priority: 'realtime', deadline: Date.now() + 1000 })); // first retry delay is 5s
    expect(queue.scheduleRetryWithMarker).not.toHaveBeenCalled();
    expect(stamp).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ status: 'expired' }));
  });

  it('expiry after a failed attempt keeps the provider error', async () => {
    smsSendRendered.mockResolvedValueOnce({ ok: false, error: 'vendor 503' });
    await processJob(smsJob({ priority: 'realtime', deadline: Date.now() + 1000 }));
    expect(stamp).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'expired', error: 'deadline passed: vendor 503' }),
    );
  });

  it('log lines say dropped for redacted jobs and DLQ otherwise, without values', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    smsSendRendered.mockResolvedValue({ ok: false, retryable: false, error: 'bad template' });
    await processJob(smsJob({ priority: 'realtime' }));
    await processJob(smsJob({ priority: 'other' }));
    const lines = log.mock.calls.map((c) => c.join(' '));
    log.mockRestore();
    expect(lines.some((l) => l.includes('dropped (redacted, no DLQ)'))).toBe(true);
    expect(lines.some((l) => l.includes('→ DLQ'))).toBe(true);
    expect(lines.filter((l) => l.includes('dropped')).every((l) => !l.includes('DLQ:'))).toBe(true);
  });

  it('redacted jobs are never dead-lettered', async () => {
    smsSendRendered.mockResolvedValueOnce({ ok: false, error: 'bad template', retryable: false });
    await processJob(smsJob({ priority: 'realtime' }));
    expect(queue.pushDLQ).not.toHaveBeenCalled();
    expect(stamp).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ status: 'failed' }));
    expect(markAttempt).toHaveBeenCalledWith(expect.anything(), 'failed', 1);
    expect(incr).toHaveBeenCalledWith('ns_job_dropped_total', { channel: 'sms', reason: 'permanent_failure' });
    expect(incr).not.toHaveBeenCalledWith('ns_job_dlq_total', expect.anything());
  });

  it('redacted jobs exhausting retries are dropped, not dead-lettered', async () => {
    smsSendRendered.mockResolvedValueOnce({ ok: false, error: 'timeout' });
    await processJob(smsJob({ priority: 'realtime', attempt: 4 }));
    expect(queue.pushDLQ).not.toHaveBeenCalled();
    expect(incr).toHaveBeenCalledWith('ns_job_dropped_total', expect.objectContaining({ reason: 'max_retries' }));
  });

  it('non-redacted jobs still dead-letter', async () => {
    smsSendRendered.mockResolvedValueOnce({ ok: false, error: 'bad template', retryable: false });
    await processJob(smsJob({ priority: 'other' }));
    expect(queue.pushDLQ).toHaveBeenCalled();
    expect(incr).toHaveBeenCalledWith('ns_job_dlq_total', expect.objectContaining({ reason: 'permanent_failure' }));
  });

  it('an expired non-redacted job is not dead-lettered either', async () => {
    await processJob(smsJob({ priority: 'other', deadline: Date.now() - 1 }));
    expect(queue.pushDLQ).not.toHaveBeenCalled();
    expect(stamp).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ status: 'expired' }));
  });

  it('a rate-limited job that would be deferred past its deadline expires instead', async () => {
    acquireSendToken.mockResolvedValueOnce(false);
    await processJob(smsJob({ priority: 'realtime', deadline: Date.now() + 10 })); // defer is 321ms
    expect(queue.deferJob).not.toHaveBeenCalled();
    expect(stamp).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ status: 'expired' }));
  });

  it('a token-check error past the deadline expires instead of deferring', async () => {
    vi.spyOn(console, 'error').mockImplementationOnce(() => {});
    acquireSendToken.mockRejectedValueOnce(new Error('redis down'));
    await processJob(smsJob({ priority: 'realtime', deadline: Date.now() + 10 }));
    expect(queue.deferJob).not.toHaveBeenCalled();
    expect(stamp).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ status: 'expired' }));
  });

  it('a deferral inside the deadline still defers', async () => {
    acquireSendToken.mockResolvedValueOnce(false);
    await processJob(smsJob({ priority: 'realtime', deadline: Date.now() + 60_000 }));
    expect(queue.deferJob).toHaveBeenCalled();
  });
});

describe('validateWorkerConfig — deadline', () => {
  it('rejects a bad URGENT_DEFAULT_DEADLINE_S', () => {
    expect(() => validateWorkerConfig({ URGENT_DEFAULT_DEADLINE_S: '-5' })).toThrow('URGENT_DEFAULT_DEADLINE_S');
  });
});

describe('v1 jobs', () => {
  const d = (channel: string) => ({
    channel,
    to: channel === 'email' ? 'a@b.c' : '+919999999999',
    templateKey: `k_${channel}`,
    provider: channel === 'email' ? 'smtp' : 'msg91',
    providerTemplateId: 'f',
    rendered: { mode: 'provider', channel, providerTemplateId: 'f', variables: {} },
    dlt: { senderId: null, dltEntityId: null, dltHeaderId: null, dltTagId: null },
  });
  const v1Job = (mode = 'first_available', audit: Record<string, unknown> = {}) => ({
    job_id: 'j', channel: 'sms', priority: 'other', to: '+919999999999', template_id: 'k_sms', variables: { name: 'A' },
    v1: { mode, deliveries: [d('sms'), d('email')], index: 0, email: { cc: ['x@y.z'] } },
    audit: { eventId: 'e', attemptId: 'a1', createdAt: 'c', correlationId: 'c', deliveryMode: mode, ...audit },
  });
  const pushed = () => vi.mocked(queue.pushToPriorityWithMarker).mock.calls[0]![0] as Job;

  it('sends pre-rendered content via sendRendered', async () => {
    await processJob(v1Job() as never);
    expect(smsSendRendered).toHaveBeenCalledWith(expect.objectContaining({ to: '+919999999999', providerTemplateId: 'f', job_id: 'j', email: undefined }));
    expect(send).not.toHaveBeenCalled();
    expect(markAttempt).toHaveBeenCalledWith(expect.anything(), 'sent', 1);
    expect(stamp).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ status: 'sent', attemptNo: 1 }));
  });

  it('passes the email extras to an email delivery only', async () => {
    await processJob({ ...v1Job(), channel: 'email', v1: { ...v1Job().v1, index: 1 } } as never);
    expect(emailSendRendered).toHaveBeenCalledWith(expect.objectContaining({ to: 'a@b.c', email: { cc: ['x@y.z'] } }));
  });

  it('takes the token for the delivery channel and vendor, deferring like legacy jobs', async () => {
    acquireSendToken.mockResolvedValueOnce(false);
    const res = await processJob(v1Job() as never);
    expect(acquireSendToken).toHaveBeenCalledWith('sms', 'msg91', 'other');
    expect(res).toEqual({ deferredMs: 321 });
    expect(smsSendRendered).not.toHaveBeenCalled();
  });

  it('defers when the token check throws', async () => {
    vi.spyOn(console, 'error').mockImplementationOnce(() => {});
    acquireSendToken.mockRejectedValueOnce(new Error('redis down'));
    expect(await processJob(v1Job() as never)).toEqual({ deferredMs: 321 });
  });

  it('retries a retryable failure as today', async () => {
    smsSendRendered.mockResolvedValueOnce({ ok: false, error: 'timeout' });
    await processJob(v1Job() as never);
    expect(queue.scheduleRetryWithMarker).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1 }), 5, expect.anything());
    expect(queue.pushToPriorityWithMarker).not.toHaveBeenCalled();
    expect(stamp.mock.calls.at(-1)?.[1]).toMatchObject({ status: 'queued', attemptNo: 2 });
    expect(vi.mocked(queue.scheduleRetryWithMarker).mock.invocationCallOrder[0]!).toBeLessThan(
      stamp.mock.invocationCallOrder.at(-1)!,
    );
  });

  it('leaves a v1 row dispatching when scheduling the retry fails, so the stale sweep recovers it', async () => {
    smsSendRendered.mockResolvedValueOnce({ ok: false, error: 'timeout' });
    stamp.mockClear();
    vi.mocked(queue.scheduleRetryWithMarker).mockRejectedValueOnce(new Error('redis down'));
    await expect(processJob(v1Job() as never)).rejects.toThrow('redis down');
    expect(stamp.mock.calls.map((c) => (c[1] as { status: string }).status)).toEqual(['dispatching']);
  });

  it('first_available falls through on permanent failure', async () => {
    smsSendRendered.mockResolvedValueOnce({ ok: false, retryable: false, error: 'bad' });
    await processJob(v1Job() as never);
    expect(stamp).toHaveBeenCalledWith(
      expect.objectContaining({ audit: expect.objectContaining({ attemptId: 'a1' }) }),
      expect.objectContaining({ status: 'failed', error: 'bad' }),
    );
    // a1's failed marker is written in the same MULTI as a2's push, never on its own.
    expect(markAttempt).not.toHaveBeenCalledWith(expect.objectContaining({ audit: expect.objectContaining({ attemptId: 'a1' }) }), 'failed', 1);
    expect(queue.pushToPriorityWithMarker).toHaveBeenCalledWith(expect.anything(), { key: 'ns:attempt:a1', value: 'failed:1', ttlSeconds: 604800 });
    const next = pushed();
    expect(next).toMatchObject({ channel: 'email', to: 'a@b.c', template_id: 'k_email', attempt: 0, v1: { index: 1 } });
    expect(next.audit!.attemptId).not.toBe('a1');
    expect(next.audit).toMatchObject({ eventId: 'e', deliveryMode: 'first_available' });
    expect(stamp).toHaveBeenCalledWith(next, { status: 'queued', attemptNo: 1 });
    expect(incr).toHaveBeenCalledWith('ns_send_fallthrough_total', { from: 'sms', to: 'email' });
    expect(queue.pushDLQ).not.toHaveBeenCalled();
    expect(incr).not.toHaveBeenCalledWith('ns_job_dlq_total', expect.anything());
  });

  it('fall-through order: stamp a2 queued → MULTI {push a2, a1 marker} → stamp a1 failed', async () => {
    smsSendRendered.mockResolvedValueOnce({ ok: false, retryable: false, error: 'bad' });
    await processJob(v1Job() as never);
    const next = pushed();
    const stampOrder = (attemptId: string, status: string) => {
      const i = stamp.mock.calls.findIndex(([j, u]) => (j as Job).audit!.attemptId === attemptId && (u as { status: string }).status === status);
      expect(i).toBeGreaterThanOrEqual(0);
      return stamp.mock.invocationCallOrder[i]!;
    };
    const push = vi.mocked(queue.pushToPriorityWithMarker).mock.invocationCallOrder[0]!;
    expect(stampOrder(next.audit!.attemptId, 'queued')).toBeLessThan(push);
    expect(push).toBeLessThan(stampOrder('a1', 'failed'));
  });

  it('first_available falls through once retries are exhausted', async () => {
    smsSendRendered.mockResolvedValueOnce({ ok: false, error: 'timeout' });
    await processJob({ ...v1Job(), attempt: 4 } as never);
    expect(queue.scheduleRetryWithMarker).not.toHaveBeenCalled();
    expect(pushed()).toMatchObject({ channel: 'email', attempt: 0, v1: { index: 1 } });
  });

  it('the new attempt row carries the ADVANCED job, so recovery resends the next delivery', async () => {
    const { toAcceptedRecord } = await vi.importActual<typeof import('../audit/redact')>('../audit/redact');
    smsSendRendered.mockResolvedValueOnce({ ok: false, retryable: false, error: 'bad' });
    await processJob(v1Job() as never);
    const rec = toAcceptedRecord(pushed(), 'worker');
    expect(rec).toMatchObject({ channel: 'email', templateId: 'k_email', recoverable: true });
    expect(rec.ids.attemptId).toBe(pushed().audit!.attemptId);
    expect(rec.ids.deliveryMode).toBe('first_available');
    expect((rec.job as unknown as Job).v1!.index).toBe(1);
    expect((rec.job as unknown as Job).channel).toBe('email');
  });

  it('a redacted fall-through keeps names only and no job copy', async () => {
    const { toAcceptedRecord } = await vi.importActual<typeof import('../audit/redact')>('../audit/redact');
    smsSendRendered.mockResolvedValueOnce({ ok: false, retryable: false, error: 'bad' });
    await processJob({ ...v1Job('first_available', { redactValues: true, variableNames: ['code'] }), variables: {} } as never);
    const next = pushed();
    expect(next.audit).toMatchObject({ redactValues: true, variableNames: ['code'], deliveryMode: 'first_available' });
    const rec = toAcceptedRecord(next, 'worker');
    expect(rec.job).toBeUndefined();
    expect(rec.recoverable).toBe(false);
    expect(rec.payload).toEqual({ to: 'a@b.c', variable_names: ['code'] });
  });

  it('a fall-through past the deadline expires instead of pushing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    smsSendRendered.mockImplementationOnce(async () => {
      vi.setSystemTime(start + 10_000); // the send outlives the deadline
      return { ok: false, retryable: false, error: 'bad' };
    });
    try {
      await processJob({ ...v1Job(), deadline: start + 5_000 } as never);
    } finally {
      vi.useRealTimers();
    }
    expect(queue.pushToPriorityWithMarker).not.toHaveBeenCalled();
    expect(queue.pushDLQ).not.toHaveBeenCalled();
    expect(stamp).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ status: 'expired', error: 'deadline passed: bad' }));
  });

  it('a failed push closes the new attempt and propagates', async () => {
    smsSendRendered.mockResolvedValueOnce({ ok: false, retryable: false, error: 'bad' });
    vi.mocked(queue.pushToPriorityWithMarker).mockRejectedValueOnce(new Error('redis down'));
    await expect(processJob(v1Job() as never)).rejects.toThrow('redis down');
    expect(stamp).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'email' }),
      { status: 'failed', attemptNo: 1, error: 'enqueue failed' },
    );
    // a1 is closed too (marker + stamp), as before the MULTI change.
    expect(markAttempt).toHaveBeenCalledWith(expect.objectContaining({ audit: expect.objectContaining({ attemptId: 'a1' }) }), 'failed', 1);
    expect(stamp).toHaveBeenLastCalledWith(
      expect.objectContaining({ audit: expect.objectContaining({ attemptId: 'a1' }) }),
      expect.objectContaining({ status: 'failed', attemptNo: 1, error: 'bad' }),
    );
  });

  it('the last delivery failing permanently dead-letters (or drops when redacted)', async () => {
    emailSendRendered.mockResolvedValueOnce({ ok: false, retryable: false, error: 'bad' });
    const job = { ...v1Job(), channel: 'email', to: 'a@b.c', v1: { ...v1Job().v1, index: 1 } };
    await processJob(job as never);
    expect(queue.pushToPriorityWithMarker).not.toHaveBeenCalled();
    expect(queue.pushDLQ).toHaveBeenCalled();

    vi.clearAllMocks();
    emailSendRendered.mockResolvedValueOnce({ ok: false, retryable: false, error: 'bad' });
    await processJob({ ...job, audit: { ...job.audit, redactValues: true } } as never);
    expect(queue.pushDLQ).not.toHaveBeenCalled();
    expect(incr).toHaveBeenCalledWith('ns_job_dropped_total', { channel: 'email', reason: 'permanent_failure' });
    expect(stamp).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ status: 'failed' }));
  });

  it('a vendor change since accept fails permanently', async () => {
    const job = v1Job('all');
    job.v1.deliveries = [d('sms')];
    job.v1.deliveries[0]!.provider = 'pinnacle';
    await processJob(job as never);
    expect(smsSendRendered).not.toHaveBeenCalled();
    expect(stamp).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ status: 'failed', error: 'vendor changed since accept' }));
    expect(queue.pushDLQ).toHaveBeenCalled();
  });

  it('a vendor change on a first_available delivery falls through', async () => {
    const job = v1Job();
    job.v1.deliveries[0]!.provider = 'pinnacle';
    await processJob(job as never);
    expect(smsSendRendered).not.toHaveBeenCalled();
    expect(pushed()).toMatchObject({ channel: 'email', v1: { index: 1 } });
  });

  it('a provider without sendRendered fails permanently', async () => {
    await processJob({ ...v1Job('all'), channel: 'whatsapp', v1: { mode: 'all', deliveries: [{ ...d('whatsapp'), provider: 'twilio' }], index: 0 } } as never);
    expect(send).not.toHaveBeenCalled();
    expect(stamp).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ status: 'failed', error: 'rendered send unsupported' }));
  });

  it('an unknown delivery channel fails permanently', async () => {
    await processJob({ ...v1Job('all'), v1: { mode: 'all', deliveries: [d('pigeon')], index: 0 } } as never);
    expect(incr).toHaveBeenCalledWith('ns_job_dlq_total', expect.objectContaining({ reason: 'unknown_channel' }));
  });

  it.each([
    ['an index out of range', { mode: 'first_available', deliveries: [d('sms')], index: 3 }],
    ['a negative index', { mode: 'first_available', deliveries: [d('sms'), d('email')], index: -1 }],
    ['missing deliveries', { mode: 'first_available', index: 0 }],
  ])('%s fails permanently instead of crashing', async (_label, v1) => {
    await expect(processJob({ ...v1Job(), v1 } as never)).resolves.not.toThrow();
    expect(smsSendRendered).not.toHaveBeenCalled();
    expect(queue.pushToPriorityWithMarker).not.toHaveBeenCalled();
    expect(stamp).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ status: 'failed' }));
    expect(incr).toHaveBeenCalledWith('ns_job_dlq_total', expect.objectContaining({ reason: 'invalid_delivery' }));
  });

  it('all-mode jobs never fall through', async () => {
    smsSendRendered.mockResolvedValueOnce({ ok: false, retryable: false, error: 'bad' });
    await processJob({ ...v1Job('all'), v1: { mode: 'all', deliveries: [d('sms')], index: 0 } } as never);
    expect(queue.pushToPriorityWithMarker).not.toHaveBeenCalled();
    expect(queue.pushDLQ).toHaveBeenCalled();
  });

  it('an all-mode job is never advanced even if it somehow holds two deliveries', async () => {
    smsSendRendered.mockResolvedValueOnce({ ok: false, retryable: false, error: 'bad' });
    await processJob(v1Job('all') as never);
    expect(queue.pushToPriorityWithMarker).not.toHaveBeenCalled();
  });

  it('an expired v1 job is never sent', async () => {
    await processJob({ ...v1Job(), deadline: Date.now() - 1 } as never);
    expect(smsSendRendered).not.toHaveBeenCalled();
    expect(stamp).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ status: 'expired' }));
    expect(markAttempt).toHaveBeenLastCalledWith(expect.anything(), 'expired', 1);
  });
});
