import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import nodemailer from 'nodemailer';
import SMTPTransport from 'nodemailer/lib/smtp-transport';

let transporter: nodemailer.Transporter<SMTPTransport.SentMessageInfo>;

interface Email_request {
  fromName: string;
  fromEmail: string;
  replyTo?: string;
  to: string;
  subject: string;
  html: string;
  activationUrl?: string;
  cc?: string;
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

  // 587 + STARTTLS is the common third-party default, so never assume 465.
  const port = Number(SMTP_PORT) || 587;
  // `secure` = implicit TLS (465); on 587 nodemailer upgrades via STARTTLS itself.
  // Empty string counts as unset, since the chart renders unset values as "".
  const secure = SMTP_SECURE ? isTrue(SMTP_SECURE) : port === 465;

  return {
    host: SMTP_HOST,
    port,
    secure,
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
      const sesClient = new SESv2Client({
        region: AWS_REGION!,
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
  activationUrl,
  cc,
}: Email_request): Promise<{ ok: boolean }> {
  if (MAIL_LOG === 'true') {
    console.log('📧 Sending mail to:', to);
    if (activationUrl) console.log('🔗 Activation URL/OTP:', activationUrl);
  }

  await initTransporter();

  try {
    const result = await transporter.sendMail({
      from: `${fromName} <${envelopeFrom ?? fromEmail}>`,
      to,
      replyTo,
      cc,
      subject,
      text: html.replace(/<[^>]+>/g, ''),
      html,
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
