import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import nodemailer from 'nodemailer';
import SMTPTransport from 'nodemailer/lib/smtp-transport';

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
  html: string;
  activationUrl?: string;
  cc?: string;
  attachments?: Email_attachment[];
}

const {
  MAIL_LOG,
  SMTP_AWS_SES,
  SMTP_GMAIL,
  AWS_REGION,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  GMAIL_USER,
  GMAIL_PASS,
} = process.env;

async function initTransporter() {
  if (transporter) return;

  if (String(SMTP_AWS_SES).toLowerCase() === 'true') {
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
  } else if (String(SMTP_GMAIL).toLowerCase() === 'true') {
    try {
      transporter = nodemailer.createTransport({
        service: 'gmail',
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: {
          user: GMAIL_USER!,
          pass: GMAIL_PASS!,
        },
      });
    } catch (err) {
      console.log('GMAIL TRANSPORTER ERROR: ', err);
    }
  } else {
    throw new Error('No valid mail transport configuration found.');
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

  await initTransporter();

  try {
    const result = await transporter.sendMail({
      from: `${fromName} <${SMTP_GMAIL === 'true' ? GMAIL_USER : fromEmail}>`,
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
      text: html.replace(/<[^>]+>/g, '').replace(/</g, ''),
      html,
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
