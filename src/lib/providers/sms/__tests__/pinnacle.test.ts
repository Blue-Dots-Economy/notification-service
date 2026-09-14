import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `../../metrics` opens a Redis connection on import, which would keep the test
// process alive. The assertions here are about the request Pinnacle receives and
// how its answer is classified, not about counters.
vi.mock('../../../metrics', () => ({
  incr: vi.fn(async () => {}),
  setGauge: vi.fn(async () => {}),
  renderPrometheus: vi.fn(async () => ''),
}));

import { loadPinnacleConfig, pollPinnacleBalance, sendSmsWithPinnacle } from '../pinnacle';

const ENV = {
  PINNACLE_API_KEY: 'key-123',
  PINNACLE_SENDER_ID: 'BLUDOT',
  PINNACLE_DLT_ENTITY_ID: 'ENT-1',
} as unknown as NodeJS.ProcessEnv;

function mockFetch(payload: unknown, init: { ok?: boolean; status?: number } = {}) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const OK = { code: 200, status: 'success', data: [{ mobile: '919000000001', uniqueid: 'u-1' }] };

function bodyOf(fetchMock: ReturnType<typeof vi.fn>) {
  return JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
}

const DEFAULT_BODY = '{{message}} is your OTP. - Team Blue Dots';

interface SendOverrides {
  to?: string;
  templateId?: string;
  variables?: Record<string, string>;
  body?: string | null; // null = omit the body entirely
  env?: NodeJS.ProcessEnv;
}

function send(over: SendOverrides = {}) {
  return sendSmsWithPinnacle(
    over.to ?? '+919000000001',
    over.templateId ?? 'DLT-TEMPLATE-1',
    over.variables ?? { message: '123456' },
    over.body === null ? undefined : (over.body ?? DEFAULT_BODY),
    'job-1',
    over.env ?? ENV
  );
}

describe('pinnacle SMS provider', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('request shape', () => {
    it('sends rendered text, not variables — pinnacle renders nothing', async () => {
      const fetchMock = mockFetch(OK);
      const res = await send();

      expect(res.ok).toBe(true);
      const body = bodyOf(fetchMock);
      expect(body.message[0].text).toBe('123456 is your OTP. - Team Blue Dots');
      expect(body.message[0]).not.toHaveProperty('variables');
    });

    it('carries the template id as dlttempid and the entity/sender from config', async () => {
      const fetchMock = mockFetch(OK);
      await send();

      const body = bodyOf(fetchMock);
      expect(body.dlttempid).toBe('DLT-TEMPLATE-1');
      expect(body.dltentityid).toBe('ENT-1');
      expect(body.sender).toBe('BLUDOT');
    });

    it('strips + from the number', async () => {
      const fetchMock = mockFetch(OK);
      await send();
      expect(bodyOf(fetchMock).message[0].number).toBe('919000000001');
    });

    it('forwards the job id as clientuid, for receipt correlation', async () => {
      const fetchMock = mockFetch(OK);
      await send();
      expect(bodyOf(fetchMock).message[0].clientuid).toBe('job-1');
    });

    it('returns the vendor uniqueid as the provider message id', async () => {
      mockFetch(OK);
      expect((await send()).provider_message_id).toBe('u-1');
    });

    it('marks Devanagari copy as UNI so it is not garbled on the handset', async () => {
      const fetchMock = mockFetch(OK);
      await send({ body: 'आपका OTP {{message}} है' });
      expect(bodyOf(fetchMock).messagetype).toBe('UNI');
    });

    it('omits optional DLT fields that are not configured', async () => {
      const fetchMock = mockFetch(OK);
      await send();
      const body = bodyOf(fetchMock);
      expect(body).not.toHaveProperty('dltheaderid');
      expect(body).not.toHaveProperty('tmid');
    });

    it('authenticates with the apikey header over https', async () => {
      const fetchMock = mockFetch(OK);
      await send();
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('https://api.pinnacle.in/index.php/sms/json');
      expect((init as { headers: Record<string, string> }).headers.apikey).toBe('key-123');
    });
  });

  describe('configuration', () => {
    it('fails permanently when credentials are missing, rather than retrying', async () => {
      mockFetch(OK);
      const res = await send({ env: { PINNACLE_API_KEY: 'k' } as NodeJS.ProcessEnv });
      expect(res.ok).toBe(false);
      expect(res.retryable).toBe(false);
      expect(res.error).toMatch(/PINNACLE_SENDER_ID/);
    });

    it('forces an http base url to https — the api key rides in a header', () => {
      const config = loadPinnacleConfig({
        ...ENV,
        PINNACLE_BASE_URL: 'http://api.pinnacle.in',
      } as NodeJS.ProcessEnv);
      expect('error' in config ? '' : config.baseUrl).toBe('https://api.pinnacle.in');
    });
  });

  describe('body handling', () => {
    it('fails permanently with no body — no retry count produces one', async () => {
      mockFetch(OK);
      const res = await send({ body: null });
      expect(res.ok).toBe(false);
      expect(res.retryable).toBe(false);
      expect(res.error).toMatch(/no body configured/);
    });

    it('refuses to send a body with an unresolved variable', async () => {
      const fetchMock = mockFetch(OK);
      const res = await sendSmsWithPinnacle(
        '919000000001',
        'T1',
        {},
        'Hi {{name}}',
        'job-2',
        ENV
      );
      expect(res.ok).toBe(false);
      expect(res.retryable).toBe(false);
      expect(res.error).toMatch(/missing template variables: name/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a rendered body past the vendor length ceiling', async () => {
      const fetchMock = mockFetch(OK);
      const res = await sendSmsWithPinnacle(
        '919000000001',
        'T1',
        { message: 'x'.repeat(2100) },
        '{{message}}',
        'job-3',
        ENV
      );
      expect(res.ok).toBe(false);
      expect(res.retryable).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('response classification', () => {
    it('treats a 200 carrying an EC code as a failure', async () => {
      mockFetch({ code: 'EC1013', status: 'error', msg: 'Template id is invalid' });
      const res = await send();
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/EC1013/);
    });

    it('does not retry an invalid template id', async () => {
      mockFetch({ code: 'EC1013', status: 'error' });
      expect((await send()).retryable).toBe(false);
    });

    it('does not retry insufficient balance', async () => {
      mockFetch({ code: 'EC1003', status: 'error' });
      expect((await send()).retryable).toBe(false);
    });

    it('does not retry an invalid sender id', async () => {
      mockFetch({ code: 'EC1004', status: 'error' });
      expect((await send()).retryable).toBe(false);
    });

    it('retries the documented transient codes', async () => {
      for (const code of ['EC1009', 'EC1010']) {
        mockFetch({ code, status: 'error' });
        expect((await send()).retryable, code).not.toBe(false);
        vi.unstubAllGlobals();
      }
    });

    it('retries an unrecognised code — unknown may be transient', async () => {
      mockFetch({ code: 'EC9999', status: 'error' });
      expect((await send()).retryable).not.toBe(false);
    });

    it('retries a 5xx but not a 4xx', async () => {
      mockFetch({}, { ok: false, status: 503 });
      expect((await send()).retryable).toBe(true);
      vi.unstubAllGlobals();
      mockFetch({}, { ok: false, status: 401 });
      expect((await send()).retryable).toBe(false);
    });

    it('retries a network failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
      const res = await send();
      expect(res.ok).toBe(false);
      expect(res.retryable).toBe(true);
    });
  });

  describe('balance polling', () => {
    it('reads the balance from the vendor payload', async () => {
      mockFetch({ code: 200, status: 'Success', data: { balance: 10000 } });
      expect(await pollPinnacleBalance(ENV)).toBe(10000);
    });

    it('returns null rather than throwing when the vendor is unreachable', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
      expect(await pollPinnacleBalance(ENV)).toBeNull();
    });
  });
});
