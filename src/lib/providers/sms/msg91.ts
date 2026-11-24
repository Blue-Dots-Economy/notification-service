import { z } from 'zod';
import { ProviderDefinition, ProviderSendResult } from '../../../types/provider';
import * as metrics from '../../metrics';
import { isRetryableHttpStatus } from './http_status';
import { linkNotAllowed, parseTemplateConfig, TemplateConfigFor, urlHostsOf } from './template_config';

type TemplateConfig = TemplateConfigFor<'msg91'>;

// Sign-in and sign-up OTP keys Keycloak sends (SMS_HTTP_CLIENT_APPS), plus login_otp (Signals guardian
// OTP, and Keycloak's fallback). Each env var holds one JSON template config (see ./template_config),
// with provider "msg91". A login_otp config replaces SMS_LOGIN_OTP_TEMPLATE_ID.
const OTP_TEMPLATE_ENV_VARS: Record<string, string> = {
  login_otp: 'MSG91_TEMPLATE_LOGIN_OTP',
  signals_signin_otp: 'MSG91_TEMPLATE_SIGNALS_SIGNIN_OTP',
  signals_signup_otp: 'MSG91_TEMPLATE_SIGNALS_SIGNUP_OTP',
  aggregator_signin_otp: 'MSG91_TEMPLATE_AGGREGATOR_SIGNIN_OTP',
  aggregator_signup_otp: 'MSG91_TEMPLATE_AGGREGATOR_SIGNUP_OTP',
};

function parseOtpTemplateConfig(raw: string, expectedKey: string): TemplateConfig | string {
  const row = parseTemplateConfig(raw, expectedKey, 'msg91');
  if ('error' in row) return String(row.error);
  const names = row.variables.map((v) => v.name);
  return new Set(names).size === names.length ? row : 'variables has a duplicate name';
}

/** The set OTP template configs by key. A broken one would only fail at send time, so it stops startup while MSG91 is the vendor. */
export function loadOtpTemplateConfigs(env: NodeJS.ProcessEnv = process.env): Record<string, TemplateConfig> {
  const templates: Record<string, TemplateConfig> = {};
  const isActive = (env.SMS_PROVIDER || 'msg91').trim().toLowerCase() === 'msg91';
  for (const [key, setting] of Object.entries(OTP_TEMPLATE_ENV_VARS)) {
    const raw = env[setting]?.trim();
    if (!raw) continue;
    const row = parseOtpTemplateConfig(raw, key);
    if (typeof row === 'string') {
      if (isActive) throw new Error(`msg91: ${setting} is invalid (${row})`);
      console.log(`msg91: ${setting} skipped (${row})`);
      continue;
    }
    templates[key] = row;
  }
  return templates;
}

const OTP_TEMPLATES = loadOtpTemplateConfigs();

/** Exactly the template's variables: a fixed `value`, else the caller's `from` (or same-named) variable. Optional ones may be absent. */
function templateVariables(row: TemplateConfig, variables: Record<string, string>) {
  const vars: Record<string, string> = {};
  const missing: string[] = [];
  for (const spec of row.variables) {
    const value = spec.value ?? variables[spec.from ?? spec.name];
    if (value) vars[spec.name] = value;
    else if (spec.required !== false) missing.push(spec.name);
  }
  return { vars, missing };
}

export async function sendSmsWithMsg91(
  to: string,
  template_id: string,
  variables: Record<string, string>,
  asDeclared = false
): Promise<ProviderSendResult> {
  const phone = to.startsWith('+') ? to.slice(1) : to;

  // MSG91 Flow renders the DLT-approved template from named variables carried
  // per recipient (`{ mobiles, name, link, ... }`). Backward-compat: the legacy
  // single-variable OTP template uses `##var##`, and its callers still send
  // `{ message }` — map that lone key to `var` so login/guardian OTPs are
  // byte-for-byte unchanged. Any other shape is spread as named vars.
  const keys = Object.keys(variables);
  const recipientVars =
    !asDeclared && keys.length === 1 && keys[0] === 'message'
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
    ...Object.fromEntries(Object.entries(OTP_TEMPLATES).map(([key, row]) => [key, row.provider_template_id])),
  },
  allowRawTemplateId: true,

  // Named variables — the DLT template's placeholders. Values are strings
  // (numbers/OTPs are sent as strings on the wire).
  schema: z.record(z.string(), z.string()),

  async send({ to, template_id, template_key, variables }) {
    // A configured OTP template sends exactly its declared variables. Event templates, and login_otp
    // while MSG91_TEMPLATE_LOGIN_OTP is unset, keep the caller's variables (a lone message is ##var##).
    const row =
      template_key && Object.prototype.hasOwnProperty.call(OTP_TEMPLATES, template_key) ? OTP_TEMPLATES[template_key] : undefined;
    if (!row) return await sendSmsWithMsg91(to, template_id, variables);
    const { vars, missing } = templateVariables(row, variables);
    if (missing.length) {
      // MSG91 still sends a template with an empty slot, so refuse rather than deliver an SMS without the OTP.
      return { ok: false, error: `msg91: ${template_key} is missing ${missing.join(', ')}`, retryable: false };
    }
    const notAllowed = linkNotAllowed(urlHostsOf(row), vars);
    if (notAllowed) return { ok: false, error: `msg91: ${template_key}: ${notAllowed}`, retryable: false };
    return await sendSmsWithMsg91(to, template_id, vars, true);
  },
};
