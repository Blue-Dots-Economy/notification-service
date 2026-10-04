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
vi.mock('../rate_limit', () => ({ acquireSendToken, rateLimitDeferMs: () => 321 }));

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

const queue = await import('../queue');
const { processJob } = await import('../worker');

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

describe('processJob — rate limit', () => {
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

  it('stamps queued, then schedules the retry and its marker together (no separate marker write)', async () => {
    send.mockResolvedValueOnce({ ok: false, error: 'timeout' });
    const audit = { eventId: 'e', attemptId: 'att-1', createdAt: '2026-10-04T00:00:00.000Z', correlationId: 'c' };
    await processJob(job({ audit }));
    expect(markAttempt).not.toHaveBeenCalled();
    expect(queue.scheduleRetryWithMarker).toHaveBeenCalledWith(expect.anything(), 5, {
      key: 'ns:attempt:att-1', value: 'retry:2', ttlSeconds: 604800,
    });
    expect(stamp.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      vi.mocked(queue.scheduleRetryWithMarker).mock.invocationCallOrder[0]!,
    );
  });

  it('marks failed on every dead-letter path', async () => {
    send.mockResolvedValueOnce({ ok: false, error: 'bad', retryable: false });
    await processJob(job());
    await processJob(job({ channel: 'nope' }));
    expect(markAttempt.mock.calls.map((c) => [c[1], c[2]])).toEqual([['failed', 1], ['failed', 1]]);
  });
});
