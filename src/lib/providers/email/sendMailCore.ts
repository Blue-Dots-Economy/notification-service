import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import nodemailer from 'nodemailer';
import SMTPTransport from 'nodemailer/lib/smtp-transport';
import { providerTimeoutMs } from '../http';

let transporter: nodemailer.Transporter<SMTPTransport.SentMessageInfo>;

export interface Email_attachment {
  filename: string;
  contentType: string;
  /** Base64-encoded content, no `data:` prefix. */
  data: string;
}

interface Email_request {
  fromName: string;
  fromEmail: string;
  replyTo?: string;
  to: string;
  subject: string;
  /** At least one of `html` / `text` is required. */
  html?: string;
  text?: string;
  activationUrl?: string;
  cc?: string;
  attachments?: Email_attachment[];
}

const {
  MAIL_LOG,
  SMTP_AWS_SES,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM,
  AWS_REGION,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
} = process.env;

const isTrue = (v?: string) => String(v).toLowerCase() === 'true';

/** Special-cased only for the From address below; otherwise Gmail is just a relay. */
const GMAIL_HOST = 'smtp.gmail.com';

/** The SMTP connection, resolved from the environment. `SMTP_HOST` selects it (#112). */
function resolveSmtp(): SMTPTransport.Options | undefined {
  if (!SMTP_HOST) return undefined;
  const timeout = providerTimeoutMs();

  // 587 + STARTTLS is the common third-party default, so never assume 465.
  const port = Number(SMTP_PORT) || 587;
  // `secure` = implicit TLS (465); on 587 nodemailer upgrades via STARTTLS itself.
  // Empty counts as unset: the chart omits the key, but compose expands an unset var to "".
  const secure = SMTP_SECURE ? isTrue(SMTP_SECURE) : port === 465;

  return {
    host: SMTP_HOST,
    port,
    secure,
    // Bound every phase so a silent relay cannot hold the worker loop; a timeout
    // fails the send, which the worker retries.
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout,
    // An `auth` with undefined members still attempts AUTH, so omit it entirely.
    ...(SMTP_USER && SMTP_PASS ? { auth: { user: SMTP_USER, pass: SMTP_PASS } } : {}),
  };
}

const smtp = resolveSmtp();
const useSes = isTrue(SMTP_AWS_SES);

/**
 * Sender override, or `undefined` to use the caller's `fromEmail`.
 *
 * Gmail rewrites a From that is not the authenticated account, so it overrides the
 * caller. Other relays keep it — their username is often not a mailbox at all.
 */
const envelopeFrom = useSes
  ? undefined
  : SMTP_FROM || (SMTP_HOST === GMAIL_HOST ? SMTP_USER : undefined);

async function initTransporter() {
  if (transporter) return;

  if (useSes) {
    try {
      const timeout = providerTimeoutMs();
      const sesClient = new SESv2Client({
        region: AWS_REGION!,
        requestHandler: { requestTimeout: timeout, connectionTimeout: timeout },
        credentials: {
          accessKeyId: AWS_ACCESS_KEY_ID!,
          secretAccessKey: AWS_SECRET_ACCESS_KEY!,
        },
      });

      transporter = nodemailer.createTransport({
        SES: { sesClient, SendEmailCommand },
      });
    } catch (err) {
      console.log('AWS TRANSPORTER ERROR: ', err);
    }
  } else if (smtp) {
    try {
      transporter = nodemailer.createTransport(smtp);
    } catch (err) {
      console.log('SMTP TRANSPORTER ERROR: ', err);
    }
  } else {
    // Thrown on the first send, so name what is missing rather than just saying no.
    throw new Error(
      'No valid mail transport configuration found. Set SMTP_HOST (with SMTP_PORT, ' +
        'SMTP_SECURE and SMTP_USER/SMTP_PASS), or SMTP_AWS_SES=true with AWS_REGION ' +
        'and AWS credentials.'
    );
  }
}

export async function sendMail({
  fromName,
  fromEmail,
  replyTo,
  to,
  subject,
  html,
  text,
  activationUrl,
  cc,
  attachments,
}: Email_request): Promise<{ ok: boolean }> {
  if (MAIL_LOG === 'true') {
    console.log('📧 Sending mail to:', to);
    if (activationUrl) console.log('🔗 Activation URL/OTP:', activationUrl);
    // Names and sizes only — never the base64 content, which would dump
    // megabytes of a user's file into the service logs.
    if (attachments?.length) {
      console.log(
        '📎 Attachments:',
        attachments.map((a) => `${a.filename} (${a.contentType}, ${a.data.length}B base64)`).join(', ')
      );
    }
  }

  if (!html && !text) throw new Error('sendMail needs html or text');

  await initTransporter();

  try {
    const result = await transporter.sendMail({
      from: `${fromName} <${envelopeFrom ?? fromEmail}>`,
      to,
      replyTo,
      cc,
      subject,
      // The plain-text alternative. The trailing `<`-strip is not redundant: the
      // tag regex is a single pass, so an UNTERMINATED tag leaves its `<` behind
      // ("<p>x<script" -> "x<script") — CodeQL
      // js/incomplete-multi-character-sanitization. Nothing executes in a
      // text/plain part, so this was never exploitable, but removing any residual
      // `<` makes a surviving `<script` impossible for one linear pass.
      //
      // Only `<` is stripped, deliberately NOT `>`. A blanket /[<>]/ also deletes
      // legitimate unescaped `>` from visible copy — "Score > 90" became
      // "Score  90" and "A => B" became "A = B" — which silently corrupts the
      // plain-text body of ordinary mail. See the mailer test.
      text: text ?? (html ? html.replace(/<[^>]+>/g, '').replace(/</g, '') : undefined),
      ...(html ? { html } : {}),
      // Decoded here rather than passing `encoding: 'base64'` so nodemailer
      // handles the transfer encoding itself for whatever transport is active
      // (the SES transport re-encodes into raw MIME).
      ...(attachments?.length
        ? {
            attachments: attachments.map((a) => ({
              filename: a.filename,
              content: Buffer.from(a.data, 'base64'),
              contentType: a.contentType,
            })),
          }
        : {}),
    });

    if (MAIL_LOG === 'true') {
      console.log('✅ Email sent:', result.messageId);
    }

    return { ok: true };
  } catch (err) {
    console.error('❌ Email sending error:', err);
    return { ok: false };
  }
}
