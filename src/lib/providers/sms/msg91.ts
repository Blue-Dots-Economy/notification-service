import { z } from 'zod';
import { ProviderDefinition, ProviderSendResult } from '../../../types/provider';
import * as metrics from '../../metrics';
import { isRetryableHttpStatus } from './http_status';
import { isTimeoutError, providerTimeoutMs } from '../http';

export async function sendSmsWithMsg91(
  to: string,
  template_id: string,
  variables: Record<string, string>
): Promise<ProviderSendResult> {
  const phone = to.startsWith('+') ? to.slice(1) : to;

  // MSG91 Flow renders the DLT-approved template from named variables carried
  // per recipient (`{ mobiles, name, link, ... }`). The single-variable OTP
  // template uses `##var##` and its callers send `{ message }`, so that lone key
  // maps to `var`. Any other shape is spread as named vars.
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
        // `mobiles` last: a caller variable named `mobiles` must never override
        // the resolved recipient phone.
        recipients: [{ ...recipientVars, mobiles: phone }],
      }),
      signal: AbortSignal.timeout(providerTimeoutMs()),
    });
  } catch (err) {
    await metrics.incr('ns_sms_send_total', { provider: 'msg91', result: 'failed' });
    return {
      ok: false,
      error: isTimeoutError(err) ? 'provider timeout' : err instanceof Error ? err.message : 'msg91 request failed',
      retryable: true,
    };
  }

  if (!resp.ok) {
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

  // MSG91 answers 200 with `{"type":"error"}` for business rejections (e.g. a
  // bad flow id), so a 2xx alone does not mean the send was accepted.
  const payload = await resp.json().catch(() => null);
  const type = String((payload as { type?: unknown } | null)?.type ?? '').toLowerCase();
  if (type === 'error') {
    const detail = String((payload as { message?: unknown } | null)?.message ?? '');
    console.log(`msg91 error (HTTP 200): ${detail.slice(0, 500)}`);
    await metrics.incr('ns_sms_send_total', { provider: 'msg91', result: 'failed' });
    await metrics.incr('ns_sms_provider_error_total', { provider: 'msg91', code: 'BUSINESS' });
    // The vendor understood the request and refused it; a retry would not change that.
    return { ok: false, error: `msg91 rejected: ${detail}`, retryable: false };
  }

  await metrics.incr('ns_sms_send_total', { provider: 'msg91', result: 'ok' });
  return { ok: true };
}

export const smsProvider: ProviderDefinition = {
  name: 'sms',
  vendor: 'msg91',
  renders: 'provider',

  // Only the single-variable OTP is named here; other DLT flow ids are sent raw
  // (allowRawTemplateId). The OTP flow id is per MSG91 account and comes from
  // SMS_LOGIN_OTP_TEMPLATE_ID; the literal is a fallback for deployments that
  // do not set it (boot seeding never uses it).
  templates: {
    login_otp: process.env.SMS_LOGIN_OTP_TEMPLATE_ID ?? '6896c26d6eb66c66340e1242',
  },
  allowRawTemplateId: true,

  // Named variables (the DLT template's placeholders), sent as strings.
  schema: z.record(z.string(), z.string()),

  async send({ to, template_id, variables }) {
    return await sendSmsWithMsg91(to, template_id, variables);
  },

  async sendRendered({ to, rendered, providerTemplateId }) {
    if (rendered.mode !== 'provider' || !providerTemplateId) {
      return { ok: false, retryable: false, error: 'rendered mode not supported by msg91' };
    }
    return sendSmsWithMsg91(to, providerTemplateId, rendered.variables);
  },
};
