import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../metrics', () => ({ incr: vi.fn(async () => {}), setGauge: vi.fn(async () => {}) }));
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail: vi.fn() }) },
  createTransport: () => ({ sendMail: vi.fn() }),
}));

const { emailProvider } = await import('../email/mailer');
const { pinnacleSmsProvider } = await import('../sms/pinnacle');
const { smsProvider: msg91Provider } = await import('../sms/msg91');
const { whatsappProvider } = await import('../whatsapp/twilio');

// Providers send content rendered at accept (Send API v1) and nothing else: the
// legacy template map, bodies, raw-id pass-through, variables schema and
// send() are gone with legacy /notify.
describe('provider definitions', () => {
  it.each([
    ['email', emailProvider, 'smtp', 'ns'],
    ['msg91', msg91Provider, 'msg91', 'provider'],
    ['pinnacle', pinnacleSmsProvider, 'pinnacle', 'ns'],
    ['twilio', whatsappProvider, 'twilio', 'provider'],
  ])('%s is {name, vendor, renders, sendRendered} only', (_label, def, vendor, renders) => {
    expect(Object.keys(def).sort()).toEqual(['name', 'renders', 'sendRendered', 'vendor']);
    expect(def).toMatchObject({ vendor, renders });
    expect(typeof def.sendRendered).toBe('function');
  });
});

describe('twilio sendRendered', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sid: 'SM1', status: 'queued', error_code: null, error_message: null }), { status: 201 })));
  });

  it('sends the approved content sid with the validated variables', async () => {
    const res = await whatsappProvider.sendRendered({
      to: '+919999999999', providerTemplateId: 'HX1',
      rendered: { mode: 'provider', channel: 'whatsapp', providerTemplateId: 'HX1', variables: { name: 'A' } },
    });
    expect(res.ok).toBe(true);
    const params = new URLSearchParams((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(params.get('ContentSid')).toBe('HX1');
    expect(JSON.parse(params.get('ContentVariables')!)).toEqual({ name: 'A' });
  });

  it('refuses content with no provider template id', async () => {
    const res = await whatsappProvider.sendRendered({
      to: '+919999999999', providerTemplateId: null,
      rendered: { mode: 'provider', channel: 'whatsapp', providerTemplateId: 'other', variables: {} } as never,
    });
    expect(res).toMatchObject({ ok: false, retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});
