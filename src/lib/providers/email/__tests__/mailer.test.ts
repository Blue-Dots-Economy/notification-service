import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const { emailProvider } = await import('../mailer');
const { serializeProvider } = await import('../../../utils/provider-docs');

const base = {
  fromName: 'Signals Support',
  fromEmail: 'hello@example.com',
  subject: 'Complaint from Asha',
  html: '<p>details</p>',
};

const attachment = (bytes: number, over: Record<string, unknown> = {}) => ({
  filename: 'evidence.png',
  contentType: 'image/png',
  data: Buffer.alloc(bytes, 1).toString('base64'),
  ...over,
});

beforeEach(() => {
  sendMailSpy.mockClear();
});

afterEach(() => {
  delete process.env.NOTIFY_ATTACHMENT_MAX_TOTAL_BYTES;
  delete process.env.NOTIFY_ATTACHMENT_MAX_FILES;
});

describe('emailProvider.schema', () => {
  it('accepts variables with no attachments (every existing caller)', () => {
    expect(emailProvider.schema.safeParse(base).success).toBe(true);
  });

  it('accepts attachments within both limits', () => {
    const parsed = emailProvider.schema.safeParse({
      ...base,
      attachments: [attachment(1024), attachment(2048)],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects more files than the configured maximum', () => {
    const four = [attachment(16), attachment(16), attachment(16), attachment(16)];
    const parsed = emailProvider.schema.safeParse({ ...base, attachments: four });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error)).toContain('at most 3 attachments');
  });

  it('rejects a total size over the configured budget', () => {
    process.env.NOTIFY_ATTACHMENT_MAX_TOTAL_BYTES = '2048';
    const parsed = emailProvider.schema.safeParse({
      ...base,
      attachments: [attachment(1500), attachment(1500)],
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error)).toContain('2048 byte total limit');
  });

  it('re-reads the limits per request, so an env change needs no redeploy of callers', () => {
    process.env.NOTIFY_ATTACHMENT_MAX_FILES = '1';
    const two = [attachment(16), attachment(16)];
    expect(emailProvider.schema.safeParse({ ...base, attachments: two }).success).toBe(false);
    delete process.env.NOTIFY_ATTACHMENT_MAX_FILES;
    expect(emailProvider.schema.safeParse({ ...base, attachments: two }).success).toBe(true);
  });

  it('rejects a structurally invalid attachment', () => {
    for (const bad of [
      { filename: '', contentType: 'image/png', data: 'eA==' },
      { filename: 'a.png', contentType: '', data: 'eA==' },
      { filename: 'a.png', contentType: 'image/png', data: '' },
      { filename: 'a.png', contentType: 'image/png' },
    ]) {
      expect(emailProvider.schema.safeParse({ ...base, attachments: [bad] }).success).toBe(false);
    }
  });

  it('still serialises to JSON Schema for the /providers docs route', () => {
    // The size/count bounds are env-driven refinements; z.toJSONSchema throws on
    // constructs it cannot represent, so this guards the docs route.
    const serialised = serializeProvider(emailProvider);
    expect(JSON.stringify(serialised)).toContain('attachments');
  });

  it('rejects a data value that is not base64', () => {
    // The decoder ignores characters outside the alphabet, so without this an
    // unvalidated payload is accepted at the 400 boundary and delivered as
    // garbage bytes — no crash, no DLQ loop, just a corrupt file.
    for (const bad of ['data:image/png;base64,aGVsbG8=', 'nope!!', 'aGVsbG8=tail', 'aGVs bG8=']) {
      const parsed = emailProvider.schema.safeParse({
        ...base,
        attachments: [{ filename: 'a.png', contentType: 'image/png', data: bad }],
      });
      expect(parsed.success).toBe(false);
    }
  });
});

describe('emailProvider.send', () => {
  // The text/plain alternative is derived from `html` by stripping tags. Two
  // properties matter and pull in opposite directions, so both are pinned here:
  // no `<script` may survive an unterminated tag (CodeQL
  // js/incomplete-multi-character-sanitization), and legitimate `>` in visible
  // copy must NOT be eaten — a blanket /[<>]/ strip turned "Score > 90" into
  // "Score  90" in review.
  it.each([
    ['<p>Hello <b>Asha</b></p>', 'Hello Asha'],
    ['<p>Score > 90</p>', 'Score > 90'],
    ['<p>Use A => B</p>', 'Use A => B'],
    ['<p>x<script', 'xscript'],
  ])('derives the text/plain body from %j as %j', async (html, expected) => {
    await emailProvider.send({
      to: 'support@example.com',
      template_id: 'BASIC_EMAIL',
      variables: { ...base, html },
    });
    const sent = sendMailSpy.mock.calls[0][0] as { text: string };
    expect(sent.text).toBe(expected);
    expect(sent.text).not.toContain('<script');
  });

  it('decodes attachments into nodemailer buffers', async () => {
    const content = Buffer.from('a tiny png');
    await emailProvider.send({
      to: 'support@example.com',
      template_id: 'BASIC_EMAIL',
      variables: {
        ...base,
        attachments: [
          { filename: 'evidence.png', contentType: 'image/png', data: content.toString('base64') },
        ],
      },
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
    await emailProvider.send({
      to: 'support@example.com',
      template_id: 'BASIC_EMAIL',
      variables: base,
    });
    expect(sendMailSpy.mock.calls[0][0]).not.toHaveProperty('attachments');
  });
});
