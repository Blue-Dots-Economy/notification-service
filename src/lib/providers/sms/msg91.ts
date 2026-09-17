import { z } from 'zod';
import { ProviderDefinition, ProviderSendResult } from '../../../types/provider';
import * as metrics from '../../metrics';
import { isRetryableHttpStatus } from './http_status';

export async function sendSmsWithMsg91(
  to: string,
  template_id: string,
  variables: Record<string, string>
): Promise<ProviderSendResult> {
  const phone = to.startsWith('+') ? to.slice(1) : to;

  // MSG91 Flow renders the DLT-approved template from named variables carried
  // per recipient (`{ mobiles, name, link, ... }`). Backward-compat: the legacy
  // single-variable OTP template uses `##var##`, and its callers still send
  // `{ message }` — map that lone key to `var` so login/guardian OTPs are
  // byte-for-byte unchanged. Any other shape is spread as named vars.
  const keys = Object.keys(variables);
  const recipientVars =
    keys.length === 1 && keys[0] === 'message'
      ? { var: variables.message }
      : variables;

  let resp: Response;
  try {
    resp = await fetch('https://control.msg91.com/api/v5/flow', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authkey: process.env.MSG91_AUTH_KEY!,
      },
      body: JSON.stringify({
        template_id,
        short_url: 0,
        // `mobiles` spread LAST: a caller variable named `mobiles` must never be
        // able to override the resolved recipient phone (SMS-redirect guard).
        recipients: [{ ...recipientVars, mobiles: phone }],
      }),
    });
  } catch (err) {
    await metrics.incr('ns_sms_send_total', { provider: 'msg91', result: 'failed' });
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'msg91 request failed',
      retryable: true,
    };
  }

  if (!resp.ok) {
    // `resp.json()` returns a Promise, so the previous `console.log` of it
    // printed `Promise { <pending> }` and every MSG91 failure was undiagnosable.
    const detail = await resp.text().catch(() => '');
    console.log(`msg91 error ${resp.status}: ${detail.slice(0, 500)}`);
    await metrics.incr('ns_sms_send_total', { provider: 'msg91', result: 'failed' });
    await metrics.incr('ns_sms_provider_error_total', {
      provider: 'msg91',
      code: `HTTP_${resp.status}`,
    });
    return {
      ok: false,
      error: `msg91 http ${resp.status}`,
      retryable: isRetryableHttpStatus(resp.status),
    };
  }

  // MSG91 answers 200 with `{"type":"error"}` for business rejections, so the
  // HTTP status alone says nothing — the same trap this adapter's Pinnacle
  // sibling exists to handle. Treating every 2xx as delivered is what made a
  // bad flow id look like a successful send on the current production vendor.
  const payload = await resp.json().catch(() => null);
  const type = String((payload as { type?: unknown } | null)?.type ?? '').toLowerCase();
  if (type === 'error') {
    const detail = String((payload as { message?: unknown } | null)?.message ?? '');
    console.log(`msg91 error (HTTP 200): ${detail.slice(0, 500)}`);
    await metrics.incr('ns_sms_send_total', { provider: 'msg91', result: 'failed' });
    await metrics.incr('ns_sms_provider_error_total', { provider: 'msg91', code: 'BUSINESS' });
    // The vendor understood the request and refused it; retrying sends the same
    // rejected payload four more times.
    return { ok: false, error: `msg91 rejected: ${detail}`, retryable: false };
  }

  await metrics.incr('ns_sms_send_total', { provider: 'msg91', result: 'ok' });
  return { ok: true };
}

export const smsProvider: ProviderDefinition = {
  name: 'sms',

  // Only the legacy single-var OTP is named here; per-event DLT flow ids are
  // sent raw by signalstack (allowRawTemplateId), so they need no entry. The
  // OTP flow id is deployment-specific (per MSG91 account) — read from env,
  // never hardcoded. The literal is a backward-compat default so existing
  // deploys don't break; set SMS_LOGIN_OTP_TEMPLATE_ID to override.
  templates: {
    login_otp: process.env.SMS_LOGIN_OTP_TEMPLATE_ID ?? '6896c26d6eb66c66340e1242',
  },
  allowRawTemplateId: true,

  // Named variables — the DLT template's placeholders. Values are strings
  // (numbers/OTPs are sent as strings on the wire).
  schema: z.record(z.string(), z.string()),

  async send({ to, template_id, variables }) {
    return await sendSmsWithMsg91(to, template_id, variables);
  },
};
