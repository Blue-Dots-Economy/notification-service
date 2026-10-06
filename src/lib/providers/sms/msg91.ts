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
  // flow uses `##var##`, and its template contract names one variable,
  // `message` — map that lone key to `var` so login/guardian OTPs are
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
  vendor: 'msg91',
  renders: 'provider',

  async sendRendered({ to, rendered, providerTemplateId }) {
    if (rendered.mode !== 'provider' || !providerTemplateId) {
      return { ok: false, retryable: false, error: 'rendered mode not supported by msg91' };
    }
    return sendSmsWithMsg91(to, providerTemplateId, rendered.variables);
  },
};
