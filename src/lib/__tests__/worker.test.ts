import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'src/types';

// The queue is mocked rather than faked here: these tests are about which queue
// call processJob makes and with what delay, not about Redis behaviour (that is
// queue.test.ts's job).
vi.mock('../queue', () => ({
  pushDLQ: vi.fn(async () => 1),
  scheduleRetry: vi.fn(async () => 1),
  popRealtime: vi.fn(async () => null),
  popOther: vi.fn(async () => null),
  popScheduledRetries: vi.fn(async () => []),
}));

// ../providers auto-discovers by reading the directory and `require`-ing each
// index.js, which only exists in compiled output — so it has to be mocked to be
// importable from source at all, quite apart from controlling send() outcomes.
const send = vi.fn(async () => ({ ok: true }) as { ok: boolean; error?: string });
vi.mock('../providers', () => ({
  providers: {
    email: {
      name: 'email',
      templates: { welcome: 'provider-template-123' },
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
});

describe('processJob — routing', () => {
  it('sends via the provider using the mapped template id, not the public key', async () => {
    await processJob(job());

    expect(send).toHaveBeenCalledWith({
      to: 'someone@example.com',
      template_id: 'provider-template-123',
      variables: {},
    });
  });

  it('does not retry or dead-letter a delivered job', async () => {
    await processJob(job());

    expect(queue.scheduleRetry).not.toHaveBeenCalled();
    expect(queue.pushDLQ).not.toHaveBeenCalled();
  });

  it('dead-letters an unknown channel without attempting a send', async () => {
    await processJob(job({ channel: 'carrier-pigeon' }));

    expect(send).not.toHaveBeenCalled();
    expect(queue.pushDLQ).toHaveBeenCalledTimes(1);
    expect(queue.scheduleRetry).not.toHaveBeenCalled();
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
      expect(queue.scheduleRetry).toHaveBeenCalledWith(j, expectedDelay);
      expect(queue.pushDLQ).not.toHaveBeenCalled();
    },
  );

  it('dead-letters instead of retrying once MAX_RETRIES is reached', async () => {
    const j = job({ attempt: 4 }); // becomes the 5th attempt

    await processJob(j);

    expect(j.attempt).toBe(5);
    expect(queue.pushDLQ).toHaveBeenCalledWith(j);
    expect(queue.scheduleRetry).not.toHaveBeenCalled();
  });

  it('dead-letters a job that somehow arrives past the limit', async () => {
    const j = job({ attempt: 9 });

    await processJob(j);

    expect(queue.pushDLQ).toHaveBeenCalledTimes(1);
    expect(queue.scheduleRetry).not.toHaveBeenCalled();
  });

  it('gives four retries before the DLQ — 5s, 10s, 20s, 40s', async () => {
    const j = job();

    for (let i = 0; i < 5; i += 1) await processJob(j);

    expect(
      (queue.scheduleRetry as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
        (c) => c[1],
      ),
    ).toEqual([5, 10, 20, 40]);
    expect(queue.pushDLQ).toHaveBeenCalledTimes(1);
  });
});
