import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../metrics', () => ({ incr: vi.fn(async () => {}), setGauge: vi.fn(async () => {}) }));
const sendMail = vi.hoisted(() => vi.fn(async () => ({ messageId: 'm' })));
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail }) },
  createTransport: () => ({ sendMail }),
}));

process.env.SMTP_HOST = 'smtp.example.com';
process.env.SMTP_USER = 'u';
process.env.SMTP_PASS = 'p';
process.env.PINNACLE_API_KEY = 'k';
process.env.PINNACLE_SENDER_ID = 'ENVSND';
process.env.PINNACLE_DLT_ENTITY_ID = 'ENVENT';

const { emailProvider } = await import('../email/mailer');
const { pinnacleSmsProvider } = await import('../sms/pinnacle');
const { smsProvider: msg91Provider } = await import('../sms/msg91');

beforeEach(() => {
  sendMail.mockClear();
  process.env.EMAIL_FROM_ADDRESS = 'no-reply@blue-dots.org';
  process.env.EMAIL_FROM_NAME = 'Blue Dots';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ status: 'success', code: '200', data: [{ uniqueid: 'u1' }] }), { status: 200 })),
  );
});

describe('sendRendered', () => {
  it('email sends the rendered subject/html/text from the configured sender', async () => {
    const res = await emailProvider.sendRendered!({
      to: 'a@b.c', providerTemplateId: null,
      rendered: { mode: 'ns', channel: 'email', subject: 'Hi', html: '<p>x</p>', text: 'x' },
      email: { cc: ['c@d.e'], replyTo: 'r@b.c' },
    });
    expect(res.ok).toBe(true);
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'a@b.c', subject: 'Hi', html: '<p>x</p>', text: 'x', replyTo: 'r@b.c', cc: 'c@d.e',
    }));
    expect(JSON.stringify(sendMail.mock.calls[0])).toContain('no-reply@blue-dots.org');
  });

  it('email without a configured sender fails permanently', async () => {
    delete process.env.EMAIL_FROM_ADDRESS;
    const res = await emailProvider.sendRendered!({
      to: 'a@b.c', providerTemplateId: null,
      rendered: { mode: 'ns', channel: 'email', subject: 'Hi', html: '<p>x</p>', text: null },
    });
    expect(res).toMatchObject({ ok: false, retryable: false, error: 'email sender not configured' });
  });

  it('email refuses provider-mode content', async () => {
    const res = await emailProvider.sendRendered!({
      to: 'a@b.c', providerTemplateId: 'x',
      rendered: { mode: 'provider', channel: 'email', providerTemplateId: 'x', variables: {} },
    });
    expect(res).toMatchObject({ ok: false, retryable: false });
  });

  it('pinnacle sendRendered sends the text verbatim with per-template DLT overrides', async () => {
    const res = await pinnacleSmsProvider.sendRendered!({
      to: '+919999999999', providerTemplateId: '1107',
      rendered: { mode: 'ns', channel: 'sms', text: 'OTP 12{{message}}34', messageType: 'TXT' },
      dlt: { senderId: 'TPLSND', dltEntityId: null },
    });
    expect(res.ok).toBe(true);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.message[0].text).toBe('OTP 12{{message}}34');
    expect(body.dlttempid).toBe('1107');
    expect(body.sender).toBe('TPLSND');
    expect(body.dltentityid).toBe('ENVENT');
  });

  it('refuses a rendered mode the vendor cannot send', async () => {
    const res = await msg91Provider.sendRendered!({
      to: '+919999999999', providerTemplateId: 'f',
      rendered: { mode: 'ns', channel: 'sms', text: 'x', messageType: 'TXT' },
    });
    expect(res).toMatchObject({ ok: false, retryable: false });
  });

  it('msg91 sends flow id + variables', async () => {
    const res = await msg91Provider.sendRendered!({
      to: '+919999999999', providerTemplateId: 'flow-1',
      rendered: { mode: 'provider', channel: 'sms', providerTemplateId: 'flow-1', variables: { message: '42' } },
    });
    expect(res.ok).toBe(true);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.template_id).toBe('flow-1');
    expect(body.recipients[0]).toMatchObject({ var: '42' });
  });
});
