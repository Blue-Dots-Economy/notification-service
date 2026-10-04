import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'src/types';

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
vi.mock('../providers', () => ({
  providers: {
    email: {
      name: 'email',
      vendor: 'smtp',
      templates: { welcome: 'provider-template-123' },
      schema: { safeParse: () => ({ success: true, data: {} }) },
      send,
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
    },
  },
}));

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('node:child_process', () => ({ fork }));

const queue = await import('../queue');
const { processJob, spawnWorker, validateWorkerConfig } = await import('../worker');

const job = (over: Partial<Job> = {}): Job => ({
  job_id: 'job-1',
  channel: 'email',
  priority: 'other',
  to: 'someone@example.com',
  template_id: 'welcome',
  variables: {},
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  send.mockResolvedValue({ ok: true });
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

describe('processJob — rate limit', () => {
  it('defers (does not lose) the job when the token check itself fails', async () => {
    acquireSendToken.mockRejectedValueOnce(new Error('redis down'));
    const j = job({ attempt: 1 });

    await processJob(j);

    expect(queue.deferJob).toHaveBeenCalledWith(j, 321);
    expect(j.attempt).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('lets a failing defer propagate', async () => {
    acquireSendToken.mockRejectedValueOnce(new Error('redis down'));
    vi.mocked(queue.deferJob).mockRejectedValueOnce(new Error('still down'));
    await expect(processJob(job())).rejects.toThrow('still down');
  });

  it('defers a denied token without counting an attempt, calling the provider or stamping', async () => {
    acquireSendToken.mockResolvedValueOnce(false);
    const j = job({ attempt: 2, priority: 'bulk' });

    await processJob(j);

    expect(queue.deferJob).toHaveBeenCalledWith(j, 321);
    expect(j.attempt).toBe(2);
    expect(send).not.toHaveBeenCalled();
    expect(stamp).not.toHaveBeenCalled();
    expect(markAttempt).not.toHaveBeenCalled();
    expect(queue.pushDLQ).not.toHaveBeenCalled();
    expect(incr).toHaveBeenCalledWith('ns_rate_limited_total', { channel: 'email', priority: 'bulk' });
  });

  it('proceeds as before when a token is granted', async () => {
    const j = job({ priority: 'realtime' });

    await processJob(j);

    expect(acquireSendToken).toHaveBeenCalledWith('email', 'smtp', 'realtime');
    expect(queue.deferJob).not.toHaveBeenCalled();
    expect(j.attempt).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('processJob — routing', () => {
  it('sends via the provider using the mapped template id, not the public key', async () => {
    await processJob(job());

    expect(send).toHaveBeenCalledWith({
      to: 'someone@example.com',
      template_id: 'provider-template-123',
      variables: {},
      body: undefined,
      job_id: 'job-1',
    });
  });

  it('does not retry or dead-letter a delivered job', async () => {
    await processJob(job());

    expect(queue.scheduleRetryWithMarker).not.toHaveBeenCalled();
    expect(queue.pushDLQ).not.toHaveBeenCalled();
  });

  it('dead-letters an unknown channel without attempting a send', async () => {
    await processJob(job({ channel: 'carrier-pigeon' }));

    expect(send).not.toHaveBeenCalled();
    expect(queue.pushDLQ).toHaveBeenCalledTimes(1);
    expect(queue.scheduleRetryWithMarker).not.toHaveBeenCalled();
  });

  it('dead-letters an unknown template without attempting a send', async () => {
    await processJob(job({ template_id: 'no-such-template' }));

    expect(send).not.toHaveBeenCalled();
    expect(queue.pushDLQ).toHaveBeenCalledTimes(1);
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

  it('counts the attempt even when the channel is unknown, so the DLQ record is honest', async () => {
    const j = job({ channel: 'nope', attempt: 1 });

    await processJob(j);

    expect(j.attempt).toBe(2);
  });
});

describe('processJob — backoff ladder on failure', () => {
  beforeEach(() => {
    send.mockResolvedValue({ ok: false, error: 'provider said no' });
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
    const j = job({ attempt: 9 });

    await processJob(j);

    expect(queue.pushDLQ).toHaveBeenCalledTimes(1);
    expect(queue.scheduleRetryWithMarker).not.toHaveBeenCalled();
  });

  it('gives four retries before the DLQ — 5s, 10s, 20s, 40s', async () => {
    const j = job();

    for (let i = 0; i < 5; i += 1) await processJob(j);

    expect(
      (queue.scheduleRetryWithMarker as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
        (c) => c[1],
      ),
    ).toEqual([5, 10, 20, 40]);
    expect(queue.pushDLQ).toHaveBeenCalledTimes(1);
  });
});

describe('processJob — body resolution (providers that cannot render)', () => {
  it('prefers the body the provider owns for a template it names', async () => {
    await processJob(job({ channel: 'sms', template_id: 'login_otp', body: 'caller text' }));

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ template_id: 'DLT-1', body: '{{message}} is your OTP' })
    );
  });

  it('falls back to the caller body for a raw pass-through id', async () => {
    await processJob(job({ channel: 'sms', template_id: 'RAW-DLT-9', body: 'caller text' }));

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ template_id: 'RAW-DLT-9', body: 'caller text' })
    );
  });

  it('dead-letters a named template whose id is not configured yet', async () => {
    await processJob(job({ channel: 'sms', template_id: 'pending_case' }));

    expect(send).not.toHaveBeenCalled();
    expect(queue.pushDLQ).toHaveBeenCalledTimes(1);
    // Must not leak through as a raw id: the vendor would answer with a generic
    // "invalid template" and hide that this is simply unapproved copy.
    expect(queue.scheduleRetryWithMarker).not.toHaveBeenCalled();
  });
});

describe('processJob — permanent failures', () => {
  it('dead-letters immediately when the provider says the failure is permanent', async () => {
    send.mockResolvedValue({ ok: false, error: 'pinnacle EC1013', retryable: false });

    await processJob(job());

    expect(queue.pushDLQ).toHaveBeenCalledTimes(1);
    expect(queue.scheduleRetryWithMarker).not.toHaveBeenCalled();
  });

  it('still retries a failure that is not marked permanent', async () => {
    send.mockResolvedValue({ ok: false, error: 'timeout', retryable: true });

    await processJob(job());

    expect(queue.scheduleRetryWithMarker).toHaveBeenCalledTimes(1);
    expect(queue.pushDLQ).not.toHaveBeenCalled();
  });

  it('keeps retrying when the provider expresses no opinion (back-compat)', async () => {
    send.mockResolvedValue({ ok: false });

    await processJob(job());

    expect(queue.scheduleRetryWithMarker).toHaveBeenCalledTimes(1);
  });
});

describe('processJob — a blank body is a config gap, not a caller opening', () => {
  // The security case: `bodies` declares that THIS service owns the template's
  // text. If a declared-but-blank body fell back to the caller's `body`, any
  // caller could put arbitrary text on the wire under a DLT-approved template
  // id — a compliance break and a phishing primitive in one.
  it('dead-letters rather than letting a caller body ride a named template', async () => {
    await processJob(job({ channel: 'sms', template_id: 'blank_body', body: 'CLAIM YOUR PRIZE' }));

    expect(send).not.toHaveBeenCalled();
    expect(queue.pushDLQ).toHaveBeenCalledTimes(1);
  });

  it('records why the job was dead-lettered', async () => {
    await processJob(job({ channel: 'sms', template_id: 'blank_body', body: 'x' }));

    expect(incr).toHaveBeenCalledWith(
      'ns_job_dlq_total',
      expect.objectContaining({ reason: 'template_not_configured' })
    );
  });
});

describe('processJob — DLQ paths are observable', () => {
  it.each([
    ['unknown channel', { channel: 'carrier-pigeon' }, 'unknown_channel'],
    ['unknown template', { template_id: 'no-such-template' }, 'unknown_template'],
  ])('counts a %s dead-letter', async (_label, over, reason) => {
    await processJob(job(over));

    expect(incr).toHaveBeenCalledWith('ns_job_dlq_total', expect.objectContaining({ reason }));
  });

  it('counts a permanent-failure dead-letter', async () => {
    send.mockResolvedValue({ ok: false, retryable: false });

    await processJob(job());

    expect(incr).toHaveBeenCalledWith(
      'ns_job_dlq_total',
      expect.objectContaining({ reason: 'permanent_failure' })
    );
  });

  it('counts a max-retries dead-letter', async () => {
    send.mockResolvedValue({ ok: false });

    await processJob(job({ attempt: 4 }));

    expect(incr).toHaveBeenCalledWith(
      'ns_job_dlq_total',
      expect.objectContaining({ reason: 'max_retries' })
    );
  });
});

describe('processJob — a provider that throws must not lose the job', () => {
  it('retries instead of dropping the notification', async () => {
    // The job is already popped and not yet in the DLQ, so an escaping throw
    // would lose it with no record anywhere.
    send.mockRejectedValue(new Error('boom'));

    await processJob(job());

    expect(queue.scheduleRetryWithMarker).toHaveBeenCalledTimes(1);
    expect(queue.pushDLQ).not.toHaveBeenCalled();
  });

  it('still dead-letters a thrower once the ladder is exhausted', async () => {
    send.mockRejectedValue(new Error('boom'));

    await processJob(job({ attempt: 4 }));

    expect(queue.pushDLQ).toHaveBeenCalledTimes(1);
  });
});

describe('processJob audit stamping', () => {
  beforeEach(() => stamp.mockClear());

  it('stamps dispatching then sent on success', async () => {
    await processJob(job());
    expect(stamp.mock.calls.map((c) => c[1])).toEqual([
      { status: 'dispatching', attemptNo: 1 },
      { status: 'sent', attemptNo: 1, providerMessageId: undefined },
    ]);
  });

  it('stamps queued for the next attempt when a retry is scheduled', async () => {
    send.mockResolvedValueOnce({ ok: false, error: 'timeout' });
    await processJob(job());
    expect(stamp.mock.calls.at(-1)?.[1]).toEqual({ status: 'queued', attemptNo: 2, error: 'timeout' });
  });

  it('stamps failed when dead-lettered', async () => {
    send.mockResolvedValueOnce({ ok: false, error: 'bad template', retryable: false });
    await processJob(job());
    expect(stamp.mock.calls.at(-1)?.[1]).toEqual({ status: 'failed', attemptNo: 1, error: 'bad template' });
  });

  it('stamps failed with max_retries when the ladder is exhausted', async () => {
    send.mockResolvedValueOnce({ ok: false });
    await processJob(job({ attempt: 4 }));
    expect(stamp.mock.calls.at(-1)?.[1]).toEqual({ status: 'failed', attemptNo: 5, error: 'max_retries' });
  });

  it('stamps failed for each pre-send dead-letter, without dispatching', async () => {
    await processJob(job({ channel: 'nope' }));
    await processJob(job({ channel: 'sms', template_id: 'pending_case' }));
    await processJob(job({ template_id: 'not-a-template' }));
    expect(stamp.mock.calls.map((c) => c[1])).toEqual([
      { status: 'failed', attemptNo: 1, error: 'unknown_channel' },
      { status: 'failed', attemptNo: 1, error: 'template_not_configured' },
      { status: 'failed', attemptNo: 1, error: 'unknown_template' },
    ]);
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
    send.mockResolvedValueOnce({ ok: false, error: 'timeout' });
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
    send.mockResolvedValueOnce({ ok: false, error: 'timeout' });
    stamp.mockClear();
    vi.mocked(queue.scheduleRetryWithMarker).mockRejectedValueOnce(new Error('redis down'));
    await expect(processJob(job())).rejects.toThrow('redis down');
    expect(stamp.mock.calls.map((c) => (c[1] as { status: string }).status)).toEqual(['dispatching']);
  });

  it('marks failed on every dead-letter path', async () => {
    send.mockResolvedValueOnce({ ok: false, error: 'bad', retryable: false });
    await processJob(job());
    await processJob(job({ channel: 'nope' }));
    expect(markAttempt.mock.calls.map((c) => [c[1], c[2]])).toEqual([['failed', 1], ['failed', 1]]);
  });
});

describe('deadlines and redacted jobs', () => {
  const smsJob = (over: Partial<Job> = {}) =>
    job({ channel: 'sms', template_id: 'login_otp', to: '+910000000000', variables: { message: '1' }, ...over });

  it('an expired job is not sent, ends expired, and is not dead-lettered', async () => {
    await processJob(smsJob({ priority: 'realtime', deadline: Date.now() - 1 }));
    expect(send).not.toHaveBeenCalled();
    expect(stamp).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ status: 'expired' }));
    expect(markAttempt).toHaveBeenCalledWith(expect.anything(), 'failed', expect.any(Number));
    expect(incr).toHaveBeenCalledWith('ns_job_expired_total', { channel: 'sms' });
    expect(queue.pushDLQ).not.toHaveBeenCalled();
  });

  it('retry past the deadline expires instead', async () => {
    send.mockResolvedValueOnce({ ok: false, error: 'timeout' });
    await processJob(smsJob({ priority: 'realtime', deadline: Date.now() + 1000 })); // first retry delay is 5s
    expect(queue.scheduleRetryWithMarker).not.toHaveBeenCalled();
    expect(stamp).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ status: 'expired' }));
  });

  it('expiry after a failed attempt keeps the provider error', async () => {
    send.mockResolvedValueOnce({ ok: false, error: 'vendor 503' });
    await processJob(smsJob({ priority: 'realtime', deadline: Date.now() + 1000 }));
    expect(stamp).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'expired', error: 'deadline passed: vendor 503' }),
    );
  });

  it('log lines say dropped for redacted jobs and DLQ otherwise, without values', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    send.mockResolvedValue({ ok: false, retryable: false, error: 'bad template' });
    await processJob(smsJob({ priority: 'realtime' }));
    await processJob(smsJob({ priority: 'other' }));
    const lines = log.mock.calls.map((c) => c.join(' '));
    log.mockRestore();
    expect(lines.some((l) => l.includes('dropped (redacted, no DLQ)'))).toBe(true);
    expect(lines.some((l) => l.includes('→ DLQ'))).toBe(true);
    expect(lines.filter((l) => l.includes('dropped')).every((l) => !l.includes('DLQ:'))).toBe(true);
  });

  it('redacted jobs are never dead-lettered', async () => {
    send.mockResolvedValueOnce({ ok: false, error: 'bad template', retryable: false });
    await processJob(smsJob({ priority: 'realtime' }));
    expect(queue.pushDLQ).not.toHaveBeenCalled();
    expect(stamp).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ status: 'failed' }));
    expect(markAttempt).toHaveBeenCalledWith(expect.anything(), 'failed', 1);
    expect(incr).toHaveBeenCalledWith('ns_job_dropped_total', { channel: 'sms', reason: 'permanent_failure' });
    expect(incr).not.toHaveBeenCalledWith('ns_job_dlq_total', expect.anything());
  });

  it('redacted jobs exhausting retries are dropped, not dead-lettered', async () => {
    send.mockResolvedValueOnce({ ok: false, error: 'timeout' });
    await processJob(smsJob({ priority: 'realtime', attempt: 4 }));
    expect(queue.pushDLQ).not.toHaveBeenCalled();
    expect(incr).toHaveBeenCalledWith('ns_job_dropped_total', expect.objectContaining({ reason: 'max_retries' }));
  });

  it('non-redacted jobs still dead-letter', async () => {
    send.mockResolvedValueOnce({ ok: false, error: 'bad template', retryable: false });
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
