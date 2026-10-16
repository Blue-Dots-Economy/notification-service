import { afterEach, describe, expect, it, vi } from 'vitest';

// metrics opens a Redis connection on import; these tests are about timeouts.
vi.mock('../../metrics', () => ({
  incr: vi.fn(async () => {}),
  setGauge: vi.fn(async () => {}),
  renderPrometheus: vi.fn(async () => ''),
}));

import { providerTimeoutMs } from '../http';
import { sendSmsWithMsg91 } from '../sms/msg91';
import { pollPinnacleBalance, sendSmsWithPinnacle } from '../sms/pinnacle';
import { sendWhatsAppMessage } from '../whatsapp/twilioSend';

describe('providerTimeoutMs', () => {
  it('defaults to 10s, reads the env and rejects invalid values', () => {
    expect(providerTimeoutMs({})).toBe(10000);
    expect(providerTimeoutMs({ PROVIDER_TIMEOUT_MS: '250' })).toBe(250);
    for (const bad of ['0', '-5', 'abc', '1.5']) {
      expect(() => providerTimeoutMs({ PROVIDER_TIMEOUT_MS: bad })).toThrow('PROVIDER_TIMEOUT_MS');
    }
  });
});

// A fetch that never answers until its signal aborts, like a vendor that accepts
// the connection and goes silent.
function hangingFetch() {
  return vi.fn((_url: unknown, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    }),
  );
}

describe('vendor call timeouts', () => {
  const saved = { ...process.env };
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });
  const setup = () => {
    process.env.PROVIDER_TIMEOUT_MS = '30';
    process.env.MSG91_AUTH_KEY = 'k';
    process.env.TWILIO_ACCOUNT_SID = 'AC1';
    process.env.TWILIO_AUTH_TOKEN = 't';
    const f = hangingFetch();
    vi.stubGlobal('fetch', f);
    return f;
  };
  const timedOut = { ok: false, retryable: true, error: 'provider timeout' };

  it('msg91 send times out as a retryable failure', async () => {
    const f = setup();
    expect(await sendSmsWithMsg91('+919000000001', 'flow', { a: 'b' })).toEqual(timedOut);
    expect(f.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('pinnacle send times out as a retryable failure', async () => {
    setup();
    const env = {
      PINNACLE_API_KEY: 'k', PINNACLE_SENDER_ID: 'S', PINNACLE_DLT_ENTITY_ID: 'E', PROVIDER_TIMEOUT_MS: '30',
    } as unknown as NodeJS.ProcessEnv;
    expect(await sendSmsWithPinnacle('+919000000001', 'tpl', {}, 'hello', 'j1', env)).toEqual(timedOut);
  });

  it('pinnacle balance poll gives up instead of hanging', async () => {
    const f = setup();
    const env = {
      PINNACLE_API_KEY: 'k', PINNACLE_SENDER_ID: 'S', PINNACLE_DLT_ENTITY_ID: 'E', PROVIDER_TIMEOUT_MS: '30',
    } as unknown as NodeJS.ProcessEnv;
    expect(await pollPinnacleBalance(env)).toBeNull();
    expect(f.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('twilio send times out as a retryable failure', async () => {
    setup();
    expect(await sendWhatsAppMessage('+919000000001', 'HX1')).toEqual(timedOut);
  });
});
