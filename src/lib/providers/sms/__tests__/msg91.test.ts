import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sendSmsWithMsg91, smsProvider } from '../msg91';

function mockFetchOk() {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => ({}) });
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

  it('returns ok:false on a non-2xx MSG91 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: () => ({}) }));
    expect((await sendSmsWithMsg91('9100', 'flow', { name: 'X' })).ok).toBe(false);
  });

  it('allows raw template ids and accepts named-variable payloads', () => {
    expect(smsProvider.allowRawTemplateId).toBe(true);
    expect(smsProvider.schema.safeParse({ name: 'Asha', link: 'https://x' }).success).toBe(true);
    expect(smsProvider.schema.safeParse({ message: '123' }).success).toBe(true);
  });
});
