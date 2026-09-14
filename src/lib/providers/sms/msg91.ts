import { z } from 'zod';
import { ProviderDefinition, ProviderSendResult } from '../../../types/provider';
import * as metrics from '../../metrics';

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
    // 4xx is our request (bad flow id, bad key) and will not improve on retry.
    return { ok: false, error: `msg91 http ${resp.status}`, retryable: resp.status >= 500 };
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
