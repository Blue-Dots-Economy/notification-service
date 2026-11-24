import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `../../../metrics` opens a Redis connection on import, which would keep the test
// process alive. These tests are about the MSG91 request, not about counters.
vi.mock('../../../metrics', () => ({
  incr: vi.fn(async () => {}),
  setGauge: vi.fn(async () => {}),
  renderPrometheus: vi.fn(async () => ''),
}));

import { loadOtpTemplateConfigs, sendSmsWithMsg91, smsProvider } from '../msg91';
import { parseTemplateConfig } from '../template_config';

function mockFetchOk() {
  const fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>) {
  return JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
}

describe('msg91 SMS provider', () => {
  beforeEach(() => {
    process.env.MSG91_AUTH_KEY = 'k';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('maps the legacy lone {message} to the single ##var## slot (OTP compat)', async () => {
    const fetchMock = mockFetchOk();
    const res = await sendSmsWithMsg91('+919000000001', 'flow-otp', { message: '123456' });
    expect(res.ok).toBe(true);
    const body = bodyOf(fetchMock);
    expect(body.template_id).toBe('flow-otp');
    expect(body.recipients).toEqual([{ mobiles: '919000000001', var: '123456' }]);
  });

  it('spreads multi-var named variables onto the recipient', async () => {
    const fetchMock = mockFetchOk();
    await sendSmsWithMsg91('919000000002', 'flow-profile-create', {
      name: 'Asha',
      link: 'https://x',
    });
    expect(bodyOf(fetchMock).recipients).toEqual([
      { mobiles: '919000000002', name: 'Asha', link: 'https://x' },
    ]);
  });

  it('strips a leading + from the mobile number', async () => {
    const fetchMock = mockFetchOk();
    await sendSmsWithMsg91('+919000000003', 'flow', { name: 'X' });
    expect(bodyOf(fetchMock).recipients[0].mobiles).toBe('919000000003');
  });

  it('a `mobiles` variable cannot override the resolved recipient phone', async () => {
    const fetchMock = mockFetchOk();
    await sendSmsWithMsg91('+919000000004', 'flow', {
      name: 'X',
      mobiles: '910000000000', // hijack attempt
    });
    expect(bodyOf(fetchMock).recipients[0].mobiles).toBe('919000000004');
  });

  it('returns ok:false on a non-2xx MSG91 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'bad flow id' })
    );
    expect((await sendSmsWithMsg91('9100', 'flow', { name: 'X' })).ok).toBe(false);
  });

  it('logs the MSG91 error body, which used to print as a pending Promise', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'bad flow id' })
    );

    await sendSmsWithMsg91('9100', 'flow', { name: 'X' });

    expect(log).toHaveBeenCalledWith(expect.stringContaining('bad flow id'));
    log.mockRestore();
  });

  it('does not retry a 4xx (our request) but does retry a 5xx (theirs)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => '' })
    );
    expect((await sendSmsWithMsg91('9100', 'flow', { name: 'X' })).retryable).toBe(false);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 502, text: async () => '' })
    );
    expect((await sendSmsWithMsg91('9100', 'flow', { name: 'X' })).retryable).toBe(true);
  });

  it('retries a network failure rather than dropping the message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    const res = await sendSmsWithMsg91('9100', 'flow', { name: 'X' });
    expect(res.ok).toBe(false);
    expect(res.retryable).toBe(true);
  });

  it('allows raw template ids and accepts named-variable payloads', () => {
    expect(smsProvider.allowRawTemplateId).toBe(true);
    expect(smsProvider.schema.safeParse({ name: 'Asha', link: 'https://x' }).success).toBe(true);
    expect(smsProvider.schema.safeParse({ message: '123' }).success).toBe(true);
  });
});

// One row in the notification-service template table shape, as up-gzb configures it.
function otpRow(key: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    template_key: key,
    network: 'blue_dot',
    channel: 'sms',
    locale: 'en',
    provider: 'msg91',
    provider_template_id: `flow-${key}`,
    body_text: '{{num}} is the OTP on Rojgar Mitra {{urg}}.',
    variables: [
      { name: 'num', from: 'message', sensitive: true },
      { name: 'urg', type: 'url', value: 'https://example.in' },
    ],
    ...overrides,
  });
}

describe('msg91 OTP template configs', () => {
  it('loads nothing when no row is set', () => {
    expect(loadOtpTemplateConfigs({})).toEqual({});
  });

  it('loads signals and aggregator rows by template key', () => {
    const rows = loadOtpTemplateConfigs({
      MSG91_TEMPLATE_SIGNALS_SIGNIN_OTP: otpRow('signals_signin_otp'),
      MSG91_TEMPLATE_AGGREGATOR_SIGNUP_OTP: otpRow('aggregator_signup_otp'),
    });
    expect(Object.keys(rows)).toEqual(['signals_signin_otp', 'aggregator_signup_otp']);
    expect(rows.aggregator_signup_otp.provider_template_id).toBe('flow-aggregator_signup_otp');
  });

  it.each([
    ['not JSON', '{'],
    ['the wrong template_key', otpRow('signals_signup_otp')],
    ['provider pinnacle', otpRow('signals_signin_otp', { provider: 'pinnacle' })],
    ['no provider_template_id', otpRow('signals_signin_otp', { provider_template_id: ' ' })],
    ['an undeclared placeholder', otpRow('signals_signin_otp', { body_text: '{{otp}} is your OTP' })],
  ])('refuses to start on a row with %s', (_why, raw) => {
    expect(() => loadOtpTemplateConfigs({ MSG91_TEMPLATE_SIGNALS_SIGNIN_OTP: raw })).toThrow(
      /MSG91_TEMPLATE_SIGNALS_SIGNIN_OTP is invalid/
    );
  });

  it('refuses to start on a duplicate variable name', () => {
    const raw = otpRow('signals_signin_otp', { body_text: '{{num}}', variables: [{ name: 'num' }, { name: 'num' }] });
    expect(() => loadOtpTemplateConfigs({ MSG91_TEMPLATE_SIGNALS_SIGNIN_OTP: raw })).toThrow(/duplicate/);
  });

  it('only accepts from/value on msg91 configs, not pinnacle', () => {
    const msg91 = JSON.parse(otpRow('signals_signin_otp'));
    expect('error' in parseTemplateConfig(JSON.stringify(msg91), 'signals_signin_otp', 'msg91')).toBe(false);
    const pinnacle = { ...msg91, provider: 'pinnacle' };
    const parsed = parseTemplateConfig(JSON.stringify(pinnacle), 'signals_signin_otp', 'pinnacle');
    expect('error' in parsed && parsed.error).toMatch(/variables\.\d\.(from|value)/);
  });

  it('only skips a broken row when Pinnacle is the vendor', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(loadOtpTemplateConfigs({ SMS_PROVIDER: 'pinnacle', MSG91_TEMPLATE_SIGNALS_SIGNIN_OTP: '{' })).toEqual({});
    log.mockRestore();
  });
});

describe('msg91 send with OTP template configs', () => {
  async function send(env: Record<string, string>, template_key: string, variables: Record<string, string>) {
    vi.resetModules();
    Object.assign(process.env, env);
    try {
      const { smsProvider: provider } = await import('../msg91');
      const fetchMock = mockFetchOk();
      const res = await provider.send({ to: '919000000006', template_id: 'flow', template_key, variables });
      return { res, recipient: fetchMock.mock.calls.length ? bodyOf(fetchMock).recipients[0] : undefined };
    } finally {
      for (const key of Object.keys(env)) delete process.env[key];
      vi.unstubAllGlobals();
    }
  }

  const keycloak = { message: '123456', url: 'https://jobs.example.in' };

  it.each([
    ['MSG91_TEMPLATE_SIGNALS_SIGNIN_OTP', 'signals_signin_otp'],
    ['MSG91_TEMPLATE_AGGREGATOR_SIGNUP_OTP', 'aggregator_signup_otp'],
  ])('%s sends the row variables: renamed OTP and fixed url', async (setting, key) => {
    const { recipient } = await send({ [setting]: otpRow(key) }, key, keycloak);
    expect(recipient).toEqual({ mobiles: '919000000006', num: '123456', urg: 'https://example.in' });
  });

  it('refuses to send when a declared variable has no value', async () => {
    const env = { MSG91_TEMPLATE_SIGNALS_SIGNIN_OTP: otpRow('signals_signin_otp') };
    const { res, recipient } = await send(env, 'signals_signin_otp', { url: 'https://x' });
    expect(res).toMatchObject({ ok: false, retryable: false });
    expect(res.error).toContain('num');
    expect(recipient).toBeUndefined();
  });

  it('enforces urlHosts on a caller-supplied link', async () => {
    const env = {
      MSG91_TEMPLATE_SIGNALS_SIGNIN_OTP: otpRow('signals_signin_otp', {
        variables: [
          { name: 'num', from: 'message' },
          { name: 'urg', from: 'url', type: 'url', urlHosts: ['Jobs.Example.in'] },
        ],
      }),
    };
    const ok = await send(env, 'signals_signin_otp', keycloak);
    expect(ok.recipient).toEqual({ mobiles: '919000000006', num: '123456', urg: 'https://jobs.example.in' });

    const bad = await send(env, 'signals_signin_otp', { message: '1', url: 'https://evil.example' });
    expect(bad.res).toMatchObject({ ok: false, retryable: false });
    expect(bad.res.error).toContain('not in urlHosts');
    expect(bad.recipient).toBeUndefined();
  });

  it('sends without an optional (required: false) variable the caller left out', async () => {
    const env = {
      MSG91_TEMPLATE_SIGNALS_SIGNIN_OTP: otpRow('signals_signin_otp', {
        variables: [
          { name: 'num', from: 'message' },
          { name: 'urg', from: 'url', required: false },
        ],
      }),
    };
    const { recipient } = await send(env, 'signals_signin_otp', { message: '123456' });
    expect(recipient).toEqual({ mobiles: '919000000006', num: '123456' });
  });

  it('sends a lone declared `message` as message, not the legacy ##var##', async () => {
    const env = {
      MSG91_TEMPLATE_SIGNALS_SIGNIN_OTP: otpRow('signals_signin_otp', {
        body_text: '{{message}} is your OTP',
        variables: [{ name: 'message' }],
      }),
    };
    const { recipient } = await send(env, 'signals_signin_otp', { message: '123456' });
    expect(recipient).toEqual({ mobiles: '919000000006', message: '123456' });
  });

  it('MSG91_TEMPLATE_LOGIN_OTP sends the guardian {message} through the row, replacing the default id', async () => {
    const env = { MSG91_TEMPLATE_LOGIN_OTP: otpRow('login_otp') };
    const { recipient } = await send(env, 'login_otp', { message: '123456' });
    expect(recipient).toEqual({ mobiles: '919000000006', num: '123456', urg: 'https://example.in' });

    vi.resetModules();
    process.env.MSG91_TEMPLATE_LOGIN_OTP = otpRow('login_otp');
    try {
      const { smsProvider: provider } = await import('../msg91');
      expect(provider.templates.login_otp).toBe('flow-login_otp');
    } finally {
      delete process.env.MSG91_TEMPLATE_LOGIN_OTP;
    }
  });

  it('sends OTP keys unchanged when no row is set (every other instance)', async () => {
    const { recipient } = await send({}, 'signals_signin_otp', keycloak);
    expect(recipient).toEqual({ mobiles: '919000000006', ...keycloak });
  });

  it('leaves login_otp on ##var## and ignores built-in names', async () => {
    const env = { MSG91_TEMPLATE_SIGNALS_SIGNIN_OTP: otpRow('signals_signin_otp') };
    expect((await send(env, 'login_otp', { message: '123456' })).recipient).toEqual({
      mobiles: '919000000006',
      var: '123456',
    });
    expect((await send(env, 'constructor', keycloak)).recipient).toEqual({ mobiles: '919000000006', ...keycloak });
  });

  it('names the row template ids for the worker', async () => {
    vi.resetModules();
    process.env.MSG91_TEMPLATE_AGGREGATOR_SIGNIN_OTP = otpRow('aggregator_signin_otp');
    try {
      const { smsProvider: provider } = await import('../msg91');
      expect(provider.templates.aggregator_signin_otp).toBe('flow-aggregator_signin_otp');
    } finally {
      delete process.env.MSG91_TEMPLATE_AGGREGATOR_SIGNIN_OTP;
    }
  });
});
