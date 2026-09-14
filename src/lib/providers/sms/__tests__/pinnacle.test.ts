import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `../../metrics` opens a Redis connection on import, which would keep the test
// process alive. The assertions here are about the request Pinnacle receives and
// how its answer is classified, not about counters.
// `vi.hoisted` because `vi.mock` is hoisted above ordinary top-level consts.
const { incr, setGauge } = vi.hoisted(() => ({
  incr: vi.fn(async () => {}),
  setGauge: vi.fn(async () => {}),
}));
vi.mock('../../../metrics', () => ({
  incr,
  setGauge,
  renderPrometheus: vi.fn(async () => ''),
}));

import { errorCodeLabel, loadPinnacleConfig, pollPinnacleBalance, sendSmsWithPinnacle } from '../pinnacle';

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
  beforeEach(() => vi.clearAllMocks());
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

    // Every documented code, so a change to the classification cannot pass by
    // being tested on three of thirty-odd. The two transient codes are the
    // vendor's only documented retryables; everything else is a refusal that
    // will be refused identically four more times.
    const TRANSIENT = ['EC1009', 'EC1010'];
    const PERMANENT = [
      'EC1000', 'EC1001', 'EC1002', 'EC1003', 'EC1004', 'EC1005', 'EC1006',
      'EC1007', 'EC1008', 'EC1011', 'EC1012', 'EC1013', 'EC1014', 'EC1015',
      'EC1016', 'EC1017', 'EC1019', 'EC1021', 'EC1022', 'EC1023', 'EC1024',
      'EC1025', 'EC1026', 'EC1027', 'EC1028', 'EC1029', 'EC1030', 'EC1031',
      'EC1032', 'EC1033', 'EC1034', 'EC1035', 'EC1036', 'EC1037', 'EC1038',
      'EC1039',
    ];

    it.each(PERMANENT)('does not retry %s', async (code) => {
      mockFetch({ code, status: 'error' });
      expect((await send()).retryable).toBe(false);
    });

    it.each(TRANSIENT)('retries %s', async (code) => {
      mockFetch({ code, status: 'error' });
      expect((await send()).retryable).toBe(true);
    });

    it('does not retry an unrecognised code — a refusal is a refusal', async () => {
      // Classification is an allowlist of retryables, so an EC code absent from
      // the vendor table fails closed. Transient conditions arrive as HTTP
      // 5xx/408/429 or a socket error, never as an EC code.
      mockFetch({ code: 'EC9999', status: 'error' });
      expect((await send()).retryable).toBe(false);
    });

    it.each([
      [503, true],
      [500, true],
      // 408 and 429 are about timing, not content, and both retried before this
      // classification existed. Dead-lettering a rate-limited OTP on its first
      // attempt turns a brief burst into failed logins.
      [408, true],
      [429, true],
      [401, false],
      [400, false],
    ])('HTTP %i retryable=%s', async (status, retryable) => {
      mockFetch({}, { ok: false, status });
      expect((await send()).retryable).toBe(retryable);
    });

    it('retries a network failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
      const res = await send();
      expect(res.ok).toBe(false);
      expect(res.retryable).toBe(true);
    });
  });

  describe('malformed vendor responses', () => {
    // The whole reason this adapter exists is that Pinnacle answers 200 for
    // business errors, so the shapes it can return under 200 are the ones that
    // matter most and were previously unreachable in tests.
    it('treats a non-JSON body as a retryable bad response, not a network error', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token <');
        },
        text: async () => '<html>502</html>',
      });
      vi.stubGlobal('fetch', fetchMock);

      const res = await send();
      expect(res.ok).toBe(false);
      expect(res.retryable).toBe(true);
      expect(res.error).toMatch(/non-JSON/);
    });

    it('treats an empty body as a failure rather than a delivery', async () => {
      mockFetch(null);
      expect((await send()).ok).toBe(false);
    });

    it('accepts success with no code field', async () => {
      mockFetch({ status: 'success', data: [{ uniqueid: 'u-9' }] });
      expect((await send()).ok).toBe(true);
    });

    it('does not let status:success mask an error code', async () => {
      // A vendor that reports both must not be read as a delivery.
      mockFetch({ status: 'success', code: 'EC1003' });
      const res = await send();
      expect(res.ok).toBe(false);
      expect(res.retryable).toBe(false);
    });
  });

  describe('metrics the alerts depend on', () => {
    it('counts a successful send', async () => {
      mockFetch(OK);
      await send();
      expect(incr).toHaveBeenCalledWith('ns_sms_send_total', {
        provider: 'pinnacle',
        result: 'ok',
      });
    });

    it('counts a failure and its vendor code', async () => {
      mockFetch({ code: 'EC1003', status: 'error' });
      await send();

      expect(incr).toHaveBeenCalledWith('ns_sms_send_total', {
        provider: 'pinnacle',
        result: 'failed',
      });
      expect(incr).toHaveBeenCalledWith('ns_sms_provider_error_total', {
        provider: 'pinnacle',
        code: 'EC1003',
      });
    });

    it('bounds the code label so a vendor string cannot break the scrape', () => {
      // Prometheus rejects the ENTIRE exposition document on one parse error,
      // and the encoding's own delimiters would corrupt the series round-trip.
      expect(errorCodeLabel('EC1003')).toBe('EC1003');
      expect(errorCodeLabel('HTTP_502')).toBe('HTTP_502');
      expect(errorCodeLabel('something,weird=here|now')).toBe('OTHER');
      expect(errorCodeLabel('')).toBe('OTHER');
      expect(errorCodeLabel('EC99999')).toBe('OTHER');
    });
  });

  describe('balance polling', () => {
    it('publishes the balance and its freshness', async () => {
      mockFetch({ code: 200, status: 'Success', data: { balance: 10000 } });
      await pollPinnacleBalance(ENV);

      expect(setGauge).toHaveBeenCalledWith('ns_provider_balance', 10000, {
        provider: 'pinnacle',
      });
      // Freshness alongside the value: the number alone cannot distinguish a
      // healthy balance from a poller that died an hour ago.
      expect(setGauge).toHaveBeenCalledWith(
        'ns_provider_balance_updated_at',
        expect.any(Number),
        { provider: 'pinnacle' }
      );
    });

    it.each([
      ['unreachable vendor', () => vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down'))), 'request_failed'],
      ['non-2xx', () => mockFetch({}, { ok: false, status: 500 }), 'http_error'],
      ['unparseable payload', () => mockFetch({ data: { balance: 'lots' } }), 'unparseable'],
    ])('records a failure counter on %s', async (_label, arrange, reason) => {
      arrange();
      expect(await pollPinnacleBalance(ENV)).toBeNull();

      expect(incr).toHaveBeenCalledWith('ns_provider_balance_poll_failures_total', {
        provider: 'pinnacle',
        reason,
      });
    });

    it('does not publish a stale balance when the poll fails', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
      await pollPinnacleBalance(ENV);

      expect(setGauge).not.toHaveBeenCalled();
    });
  });
});
