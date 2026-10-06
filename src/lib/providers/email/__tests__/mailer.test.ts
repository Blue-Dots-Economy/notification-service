import { beforeEach, describe, expect, it, vi } from 'vitest';

// SMTP_HOST is read at module load by sendMailCore, so it has to be set before
// the dynamic import below — and nodemailer mocked so no transport is opened.
process.env.SMTP_HOST = 'smtp.example.com';
process.env.SMTP_USER = 'relay@example.com';
process.env.SMTP_PASS = 'secret';

const sendMailSpy = vi.fn(async () => ({ messageId: 'msg-1' }));
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail: sendMailSpy }) },
  createTransport: () => ({ sendMail: sendMailSpy }),
}));

process.env.EMAIL_FROM_ADDRESS = 'no-reply@example.com';

const { EmailAttachmentSchema, emailProvider } = await import('../mailer');

const attachment = (bytes: number, over: Record<string, unknown> = {}) => ({
  filename: 'evidence.png',
  contentType: 'image/png',
  data: Buffer.alloc(bytes, 1).toString('base64'),
  ...over,
});

/** A v1 email rendered at accept. `text: null` is an html-only template. */
const rendered = (html: string | null, text: string | null = null) =>
  ({ mode: 'ns', channel: 'email', subject: 'Complaint from Asha', html, text }) as const;

const send = (html: string | null, text: string | null = null, email?: Parameters<typeof emailProvider.sendRendered>[0]['email']) =>
  emailProvider.sendRendered({ to: 'support@example.com', providerTemplateId: null, rendered: rendered(html, text), email });

beforeEach(() => {
  sendMailSpy.mockClear();
});

describe('EmailAttachmentSchema', () => {
  it('accepts a well-formed attachment', () => {
    expect(EmailAttachmentSchema.safeParse(attachment(1024)).success).toBe(true);
  });

  it('rejects a structurally invalid attachment', () => {
    for (const bad of [
      { filename: '', contentType: 'image/png', data: 'eA==' },
      { filename: 'a.png', contentType: '', data: 'eA==' },
      { filename: 'a.png', contentType: 'image/png', data: '' },
      { filename: 'a.png', contentType: 'image/png' },
    ]) {
      expect(EmailAttachmentSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('rejects a data value that is not base64', () => {
    // The decoder ignores characters outside the alphabet, so without this an
    // unvalidated payload is accepted at the 400 boundary and delivered as
    // garbage bytes — no crash, no DLQ loop, just a corrupt file.
    for (const bad of ['data:image/png;base64,aGVsbG8=', 'nope!!', 'aGVsbG8=tail', 'aGVs bG8=']) {
      expect(EmailAttachmentSchema.safeParse({ filename: 'a.png', contentType: 'image/png', data: bad }).success).toBe(false);
    }
  });
});

describe('emailProvider.sendRendered', () => {
  // An html-only template gets a text/plain alternative derived from `html` by
  // stripping tags. Two properties matter and pull in opposite directions, so
  // both are pinned here: no `<script` may survive an unterminated tag (CodeQL
  // js/incomplete-multi-character-sanitization), and legitimate `>` in visible
  // copy must NOT be eaten — a blanket /[<>]/ strip turned "Score > 90" into
  // "Score  90" in review.
  it.each([
    ['<p>Hello <b>Asha</b></p>', 'Hello Asha'],
    ['<p>Score > 90</p>', 'Score > 90'],
    ['<p>Use A => B</p>', 'Use A => B'],
    ['<p>x<script', 'xscript'],
  ])('derives the text/plain body of an html-only email from %j as %j', async (html, expected) => {
    await send(html);
    const sent = sendMailSpy.mock.calls[0][0] as { text: string; html: string };
    expect(sent.text).toBe(expected);
    expect(sent.text).not.toContain('<script');
    expect(sent.html).toBe(html);
  });

  it('sends the rendered text as given when the template has one', async () => {
    await send('<p>Hello</p>', 'Hello there');
    expect(sendMailSpy.mock.calls[0][0]).toMatchObject({ text: 'Hello there', html: '<p>Hello</p>' });
  });

  it('decodes attachments into nodemailer buffers', async () => {
    const content = Buffer.from('a tiny png');
    await send('<p>details</p>', null, {
      attachments: [{ filename: 'evidence.png', contentType: 'image/png', data: content.toString('base64') }],
    });

    const sent = sendMailSpy.mock.calls[0][0] as {
      attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
    };
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments?.[0].filename).toBe('evidence.png');
    expect(sent.attachments?.[0].contentType).toBe('image/png');
    expect(sent.attachments?.[0].content.equals(content)).toBe(true);
  });

  it('omits the attachments key entirely when there are none', async () => {
    await send('<p>details</p>');
    expect(sendMailSpy.mock.calls[0][0]).not.toHaveProperty('attachments');
  });
});
