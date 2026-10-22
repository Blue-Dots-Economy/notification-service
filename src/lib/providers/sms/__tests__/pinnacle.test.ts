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

import {
  errorCodeLabel,
  loadPinnacleConfig,
  linkNotAllowed,
  loadOtpTemplates,
  parseOtpTemplateRow,
  pollPinnacleBalance,
  sendSmsWithPinnacle,
} from '../pinnacle';
import { renderBody } from '../render';

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

    it('does not send clientuid, which Pinnacle rejects for a job id (EC1036 Invalid Client UID)', async () => {
      const fetchMock = mockFetch(OK);
      await send();
      expect(bodyOf(fetchMock).message[0]).not.toHaveProperty('clientuid');
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

    it('sends without dltentityid when the entity id is not configured', async () => {
      const fetchMock = mockFetch(OK);
      const res = await send({ env: { ...ENV, PINNACLE_DLT_ENTITY_ID: '' } as unknown as NodeJS.ProcessEnv });
      expect(res.ok).toBe(true);
      expect(bodyOf(fetchMock)).not.toHaveProperty('dltentityid');
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

describe('sign-in / sign-up OTP templates', () => {
  const SIGNIN =
    '{{message}} is the OTP to verify your phone number on Purple Dots {{url}}. Please do not share this with anyone. This is valid for 5 mins. - Team ALIMCO';
  const SIGNUP =
    '{{message}} is the OTP to verify your phone number on Purple Dots {{url}}. Do not share with anyone. Valid for 5 mins. Read the Terms of Use and Privacy Policy on the app carefully. - Team ALIMCO';

  const row = (key: string, id: string, body: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      template_key: key,
      network: 'purple_dot',
      channel: 'sms',
      locale: 'en',
      version: 1,
      provider: 'pinnacle',
      provider_template_id: id,
      approval_ref: key.endsWith('signup_otp') ? 'signup_otp_sms' : 'signin_otp_sms',
      variables: [
        { name: 'message', sensitive: true },
        { name: 'url', type: 'url', urlHosts: ['signals-purpledots.depwd.gov.in'] },
      ],
      body_text: body,
      ...extra,
    });

  it('parses a template row with the event-platform field names', () => {
    const parsed = parseOtpTemplateRow(row('signals_signup_otp', '1507000000000002', SIGNUP), 'signals_signup_otp');
    expect(parsed).toMatchObject({ provider_template_id: '1507000000000002', body_text: SIGNUP, network: 'purple_dot' });
  });

  it('rejects rows that are not usable', () => {
    const cases: Array<[string, RegExp]> = [
      ['not json', /not valid JSON/],
      [row('signals_signup_otp', '', SIGNUP), /provider_template_id/],
      [row('signals_signup_otp', '1507', SIGNUP, { channel: 'email' }), /channel/],
      [row('signals_signup_otp', '1507', SIGNUP, { provider: 'msg91' }), /provider/],
      [row('signals_signin_otp', '1507', SIGNIN), /expected 'signals_signup_otp'/],
      [row('signals_signup_otp', '1507', SIGNUP, { variables: [{ name: 'message' }] }), /undeclared variables: url/],
      [row('signals_signup_otp', '1507', SIGNUP, { variables: undefined }), /variables/],
      [row('signals_signup_otp', '1507', SIGNUP, { variables: ['message', 'url'] }), /variables/],
      [row('signals_signup_otp', '1507', SIGNUP, { network: undefined }), /network/],
      [row('signals_signup_otp', '1507', SIGNUP, { locale: undefined }), /locale/],
    ];
    for (const [raw, reason] of cases) {
      const parsed = parseOtpTemplateRow(raw, 'signals_signup_otp');
      expect('error' in parsed && parsed.error).toMatch(reason);
    }
  });

  it('declares only the templates that are configured, one per app and flow', () => {
    expect(loadOtpTemplates({} as NodeJS.ProcessEnv)).toEqual({ templates: {}, bodies: {}, urlHosts: {} });
    const env = {
      PINNACLE_TEMPLATE_SIGNALS_SIGNIN_OTP: row('signals_signin_otp', '1507000000000001', SIGNIN),
      PINNACLE_TEMPLATE_SIGNALS_SIGNUP_OTP: row('signals_signup_otp', '1507000000000002', SIGNUP),
      PINNACLE_TEMPLATE_AGGREGATOR_SIGNIN_OTP: row('aggregator_signin_otp', '1507000000000003', SIGNIN),
      PINNACLE_TEMPLATE_AGGREGATOR_SIGNUP_OTP: row('aggregator_signup_otp', '1507000000000004', SIGNUP),
    } as unknown as NodeJS.ProcessEnv;
    expect(loadOtpTemplates(env)).toEqual({
      templates: {
        signals_signin_otp: '1507000000000001',
        signals_signup_otp: '1507000000000002',
        aggregator_signin_otp: '1507000000000003',
        aggregator_signup_otp: '1507000000000004',
      },
      bodies: {
        signals_signin_otp: SIGNIN,
        signals_signup_otp: SIGNUP,
        aggregator_signin_otp: SIGNIN,
        aggregator_signup_otp: SIGNUP,
      },
      urlHosts: {
        '1507000000000001': { url: ['signals-purpledots.depwd.gov.in'] },
        '1507000000000002': { url: ['signals-purpledots.depwd.gov.in'] },
        '1507000000000003': { url: ['signals-purpledots.depwd.gov.in'] },
        '1507000000000004': { url: ['signals-purpledots.depwd.gov.in'] },
      },
    });
  });

  it('fails startup on an invalid row when Pinnacle is the SMS provider', () => {
    const env = {
      SMS_PROVIDER: 'pinnacle',
      PINNACLE_TEMPLATE_SIGNALS_SIGNUP_OTP: '{"template_key":"signals_signup_otp"}',
    } as unknown as NodeJS.ProcessEnv;
    expect(() => loadOtpTemplates(env)).toThrow(/PINNACLE_TEMPLATE_SIGNALS_SIGNUP_OTP/);
  });

  it('skips an invalid row when another vendor is the SMS provider', () => {
    const env = { PINNACLE_TEMPLATE_SIGNALS_SIGNUP_OTP: '{"template_key":"signals_signup_otp"}' } as unknown as NodeJS.ProcessEnv;
    expect(loadOtpTemplates(env)).toEqual({ templates: {}, bodies: {}, urlHosts: {} });
  });

  it('allows a link only on a host listed in urlHosts', () => {
    const hosts = { url: ['signals-purpledots.depwd.gov.in'] };
    expect(linkNotAllowed(hosts, { message: '1', url: 'https://signals-purpledots.depwd.gov.in' })).toBeUndefined();
    expect(linkNotAllowed(hosts, { message: '1', url: 'https://seekers-purpledots.depwd.gov.in' })).toMatch(/url host .* not in urlHosts/);
    expect(linkNotAllowed(hosts, { message: '1', url: 'not a url' })).toMatch(/url host .* not in urlHosts/);
    expect(linkNotAllowed(undefined, { message: '1', url: 'https://any.example' })).toBeUndefined();
    expect(linkNotAllowed(hosts, { message: '1' })).toBeUndefined();
  });

  it('renders the exact approved text for both templates', () => {
    const vars = { message: '482913', url: 'https://signals-purpledots.depwd.gov.in' };
    expect(renderBody(SIGNIN, vars)).toBe(
      '482913 is the OTP to verify your phone number on Purple Dots https://signals-purpledots.depwd.gov.in. Please do not share this with anyone. This is valid for 5 mins. - Team ALIMCO'
    );
    expect(renderBody(SIGNUP, vars)).toBe(
      '482913 is the OTP to verify your phone number on Purple Dots https://signals-purpledots.depwd.gov.in. Do not share with anyone. Valid for 5 mins. Read the Terms of Use and Privacy Policy on the app carefully. - Team ALIMCO'
    );
  });

  it('sends the sign-up text with its DLT id', async () => {
    const fetchMock = mockFetch(OK);
    const res = await sendSmsWithPinnacle(
      '+919000000001',
      '1507000000000002',
      { message: '482913', url: 'https://aggregators-purpledots.depwd.gov.in' },
      SIGNUP,
      'job-1',
      ENV
    );
    expect(res.ok).toBe(true);
    const sent = bodyOf(fetchMock);
    expect(sent.dlttempid).toBe('1507000000000002');
    expect(sent.message[0].text).toBe(
      '482913 is the OTP to verify your phone number on Purple Dots https://aggregators-purpledots.depwd.gov.in. Do not share with anyone. Valid for 5 mins. Read the Terms of Use and Privacy Policy on the app carefully. - Team ALIMCO'
    );
  });

  it('rejects a send with the link missing, without calling Pinnacle', async () => {
    const fetchMock = mockFetch(OK);
    const res = await sendSmsWithPinnacle('+919000000001', '1507000000000002', { message: '482913' }, SIGNUP, 'job-1', ENV);
    expect(res).toMatchObject({ ok: false, retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('times out a vendor call that does not answer, as a retryable failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
      )
    );
    const env = { ...ENV, PINNACLE_TIMEOUT_MS: '20' } as unknown as NodeJS.ProcessEnv;
    const res = await sendSmsWithPinnacle('+919000000001', '1507000000000001', { message: '1' }, 'code {{message}}', 'j', env);
    expect(res).toEqual({ ok: false, error: 'pinnacle request timed out', retryable: true });
  });

  it('uses the default timeout when the configured one is not a positive number', async () => {
    for (const timeout of ['-1', 'abc']) {
      const fetchMock = mockFetch(OK);
      const env = { ...ENV, PINNACLE_TIMEOUT_MS: timeout } as unknown as NodeJS.ProcessEnv;
      const res = await sendSmsWithPinnacle('+919000000001', '1507000000000001', { message: '1' }, 'code {{message}}', 'j', env);
      expect(res.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledOnce();
    }
  });
});
