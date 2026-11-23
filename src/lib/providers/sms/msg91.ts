import { z } from 'zod';
import { ProviderDefinition, ProviderSendResult } from '../../../types/provider';
import * as metrics from '../../metrics';
import { isRetryableHttpStatus } from './http_status';

// Sign-in and sign-up OTP keys Keycloak sends (SMS_HTTP_CLIENT_APPS), each mapped to an MSG91 flow id.
const OTP_TEMPLATE_ENV_VARS: Record<string, string> = {
  signals_signin_otp: 'MSG91_TEMPLATE_SIGNALS_SIGNIN_OTP',
  signals_signup_otp: 'MSG91_TEMPLATE_SIGNALS_SIGNUP_OTP',
  aggregator_signin_otp: 'MSG91_TEMPLATE_AGGREGATOR_SIGNIN_OTP',
  aggregator_signup_otp: 'MSG91_TEMPLATE_AGGREGATOR_SIGNUP_OTP',
};

/** Names only the OTP keys whose env var is set, so a deployment without them is unchanged. */
export function otpTemplateIdsFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const templates: Record<string, string> = {};
  for (const [key, envVar] of Object.entries(OTP_TEMPLATE_ENV_VARS)) {
    const flowId = env[envVar]?.trim();
    if (flowId) templates[key] = flowId;
  }
  return templates;
}

// MSG91_OTP_VAR_NAMES=message:num,url:urg renames Keycloak's OTP variables to the template's placeholders.
// A Map, not an object: unset must be a strict no-op, and `{}['constructor']` is not undefined.
const OTP_VAR_NAMES = new Map(
  (process.env.MSG91_OTP_VAR_NAMES ?? '')
    .split(',')
    .filter((pair) => pair.includes(':'))
    .map((pair) => pair.split(':').map((name) => name.trim()) as [string, string])
);

// MSG91_OTP_URL replaces Keycloak's per-portal link with one fixed URL, so DLT needs one whitelist entry.
const OTP_URL = process.env.MSG91_OTP_URL?.trim();

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

  // Only the OTP templates are named here; per-event DLT flow ids are
  // sent raw by signalstack (allowRawTemplateId), so they need no entry. The
  // OTP flow id is deployment-specific (per MSG91 account) — read from env,
  // never hardcoded. The literal is a backward-compat default so existing
  // deploys don't break; set SMS_LOGIN_OTP_TEMPLATE_ID to override.
  templates: {
    login_otp: process.env.SMS_LOGIN_OTP_TEMPLATE_ID ?? '6896c26d6eb66c66340e1242',
    ...otpTemplateIdsFromEnv(),
  },
  allowRawTemplateId: true,

  // Named variables — the DLT template's placeholders. Values are strings
  // (numbers/OTPs are sent as strings on the wire).
  schema: z.record(z.string(), z.string()),

  async send({ to, template_id, template_key, variables }) {
    // Only the sign-in/sign-up OTP keys are changed; login_otp and event templates are untouched.
    const otpVars = OTP_URL ? { ...variables, url: OTP_URL } : variables;
    const vars =
      template_key && template_key in OTP_TEMPLATE_ENV_VARS
        ? Object.fromEntries(Object.entries(otpVars).map(([k, v]) => [OTP_VAR_NAMES.get(k) ?? k, v]))
        : variables;
    return await sendSmsWithMsg91(to, template_id, vars);
  },
};
