import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// MAIL_LOG and SMTP_HOST are read at module load by sendMailCore, so they are
// set before the dynamic import below. The deployed chart sets MAIL_LOG=true,
// so these tests stand in for a deployed environment.
process.env.MAIL_LOG = 'true';
process.env.SMTP_HOST = 'smtp.example.com';
process.env.SMTP_USER = 'relay@example.com';
process.env.SMTP_PASS = 'secret';

const sendMailSpy = vi.fn(async (_opts: unknown): Promise<{ messageId: string }> => ({ messageId: 'msg-1' }));
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail: sendMailSpy }) },
  createTransport: () => ({ sendMail: sendMailSpy }),
}));

const { sendMail, maskEmail } = await import('../sendMailCore');

const OTP = '493817';
const LINK = 'https://app.example.org/activate?token=tok_SECRET123';

const request = {
  fromName: 'Signals',
  fromEmail: 'hello@example.com',
  to: 'asha.k@example.org',
  subject: 'Your code',
  html: `<p>Your code is ${OTP}. Or open ${LINK}</p>`,
  activationUrl: LINK,
};

let logged: () => string;

beforeEach(() => {
  sendMailSpy.mockClear();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  logged = () =>
    [log, error, warn]
      .flatMap((s) => s.mock.calls.flat())
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join('\n');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MAIL_LOG=true', () => {
  it('never logs the activation link or OTP, and masks the recipient', async () => {
    await sendMail({ ...request, activationUrl: OTP });
    await sendMail(request);

    const out = logged();
    expect(sendMailSpy).toHaveBeenCalledTimes(2);
    expect(out).not.toContain(OTP);
    expect(out).not.toContain('tok_SECRET123');
    expect(out).not.toContain('asha.k@example.org');
    expect(out).toContain('a***@example.org');
    expect(out).toMatch(/activation link: present/i);
  });

  it('logs only safe fields of a failed send, not the whole error object', async () => {
    const err = Object.assign(new Error(`Message failed: 550 mailbox asha.k@example.org rejected content ${LINK} code ${OTP}`), {
      code: 'EMESSAGE',
      responseCode: 550,
      response: `550 rejected: ${LINK} ${OTP}`,
      command: 'DATA',
      rejected: ['asha.k@example.org'],
    });
    sendMailSpy.mockRejectedValueOnce(err);

    await expect(sendMail(request)).resolves.toEqual({ ok: false });

    const out = logged();
    expect(out).toContain('EMESSAGE');
    expect(out).toContain('550');
    expect(out).not.toContain(OTP);
    expect(out).not.toContain('tok_SECRET123');
    expect(out).not.toContain('asha.k@example.org');
  });
});

describe('maskEmail', () => {
  it.each([
    ['asha.k@example.org', 'a***@example.org'],
    ['a@b.co', 'a***@b.co'],
    ['not-an-email', '***'],
    ['@example.org', '***'],
    ['', '***'],
  ])('%s -> %s', (input, expected) => {
    expect(maskEmail(input)).toBe(expected);
  });
});
