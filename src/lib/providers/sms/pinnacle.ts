import { z } from 'zod';
import { ProviderDefinition, ProviderSendResult } from '../../../types/provider';
import * as metrics from '../../metrics';
import { isRetryableHttpStatus } from './http_status';
import { isTimeoutError, providerTimeoutMs } from '../http';
import { MAX_LENGTH, messageType, renderBody, UnresolvedTemplateVariables } from './render';

/**
 * Pinnacle Teleservices SMS provider, JSON endpoint (`/index.php/sms/json`).
 *
 * Unlike MSG91 Flow, Pinnacle renders nothing: it takes the final `text` plus
 * DLT identifiers, which the operator matches against the registered template.
 * This adapter renders the body (see `./render`) and attaches the DLT metadata.
 *
 * DLT ids are issued against the sending principal entity (the adopter), so
 * `sender`/`dltentityid` are deployment-wide config, while `dlttempid` varies
 * per template and arrives as the `template_id`.
 * Design: docs/superpowers/specs/2026-09-14-pinnacle-sms-provider-design.md
 */

const DEFAULT_BASE_URL = 'https://api.pinnacle.in';

interface PinnacleConfig {
  baseUrl: string;
  apiKey: string;
  sender: string;
  dltEntityId: string;
  dltHeaderId?: string;
  dltTagId?: string;
  tmid?: string;
}

/**
 * The only two codes the vendor documents as transient: EC1009 ("unable to
 * process request") and EC1010 ("submission exceeded time limit").
 *
 * An allowlist of retryable codes, not a list of permanent ones: the vendor's
 * code table has gaps, and an unrecognised `EC` code means the vendor
 * understood the request and refused it, which a retry does not change.
 * Transient conditions arrive as HTTP 5xx, 408, 429 or a socket error, handled
 * separately.
 */
const RETRYABLE_ERROR_CODES = new Set(['EC1009', 'EC1010']);

export function loadPinnacleConfig(env = process.env): PinnacleConfig | { error: string } {
  const missing = ['PINNACLE_API_KEY', 'PINNACLE_SENDER_ID', 'PINNACLE_DLT_ENTITY_ID'].filter(
    (k) => !env[k]
  );
  if (missing.length) return { error: `pinnacle not configured: missing ${missing.join(', ')}` };

  return {
    // Forced to https even if overridden: the vendor doc lists the status
    // endpoint as http, and an API key in a cleartext header is not acceptable.
    baseUrl: (env.PINNACLE_BASE_URL || DEFAULT_BASE_URL).replace(/^http:/, 'https:'),
    apiKey: env.PINNACLE_API_KEY!,
    sender: env.PINNACLE_SENDER_ID!,
    dltEntityId: env.PINNACLE_DLT_ENTITY_ID!,
    dltHeaderId: env.PINNACLE_DLT_HEADER_ID || undefined,
    dltTagId: env.PINNACLE_DLT_TAG_ID || undefined,
    tmid: env.PINNACLE_TMID || undefined,
  };
}

/** Pinnacle wants bare international digits (`918123456789`), never `+`. */
function normalisePhone(to: string): string {
  return to.replace(/[^\d]/g, '');
}

/**
 * Only `EC1xxx` and `HTTP_nnn` become metric labels; anything else collapses to
 * `OTHER`. The code comes from a vendor response: unbounded, it would grow a
 * Redis hash with no TTL and could break the scrape document.
 */
export function errorCodeLabel(code: string): string {
  return /^EC1\d{3}$/.test(code) || /^HTTP_\d{3}$/.test(code) ? code : 'OTHER';
}

/**
 * Pinnacle answers 200 for business errors too. Success is `status: success`
 * with `code: 200` (or no code); anything else carries an `EC1xxx` in `code`.
 */
function readResponse(payload: any): { ok: boolean; code: string; message?: string; uniqueid?: string } {
  const code = String(payload?.code ?? '');
  const status = String(payload?.status ?? '').toLowerCase();
  const ok = status === 'success' && (code === '200' || code === '');
  return {
    ok,
    code: ok ? '200' : code || 'UNKNOWN',
    message: payload?.msg ?? payload?.message ?? payload?.description,
    uniqueid: Array.isArray(payload?.data) ? payload.data[0]?.uniqueid : undefined,
  };
}

export async function sendSmsWithPinnacle(
  to: string,
  template_id: string,
  variables: Record<string, string>,
  body: string | undefined,
  job_id: string | undefined,
  env = process.env
): Promise<ProviderSendResult> {
  const config = loadPinnacleConfig(env);
  if ('error' in config) {
    await metrics.incr('ns_sms_send_total', { provider: 'pinnacle', result: 'failed' });
    return { ok: false, error: config.error, retryable: false };
  }

  if (!body) {
    // Pinnacle cannot render, so a template with no configured body cannot be
    // sent at all. Permanent: no number of retries produces a body.
    await metrics.incr('ns_sms_send_total', { provider: 'pinnacle', result: 'failed' });
    return {
      ok: false,
      error: `no body configured for template_id=${template_id}; pinnacle renders no templates`,
      retryable: false,
    };
  }

  let text: string;
  try {
    text = renderBody(body, variables ?? {});
  } catch (err) {
    await metrics.incr('ns_sms_send_total', { provider: 'pinnacle', result: 'failed' });
    return {
      ok: false,
      error:
        err instanceof UnresolvedTemplateVariables
          ? `missing template variables: ${err.missing.join(', ')}`
          : 'body render failed',
      retryable: false,
    };
  }

  return sendPinnacleText(to, template_id, text, {}, job_id, env);
}

export interface PinnacleDltOverrides {
  senderId?: string | null;
  dltEntityId?: string | null;
  dltHeaderId?: string | null;
  dltTagId?: string | null;
}

/** The post-render half of a Pinnacle send: `text` goes out verbatim. */
export async function sendPinnacleText(
  to: string,
  dltTemplateId: string,
  text: string,
  overrides: PinnacleDltOverrides,
  job_id: string | undefined,
  env = process.env
): Promise<ProviderSendResult> {
  const config = loadPinnacleConfig(env);
  if ('error' in config) {
    await metrics.incr('ns_sms_send_total', { provider: 'pinnacle', result: 'failed' });
    return { ok: false, error: config.error, retryable: false };
  }

  // Blank or whitespace-only overrides count as absent: only a real value wins.
  const pick = (v: string | null | undefined, fallback: string | undefined) =>
    v && v.trim() ? v.trim() : fallback;
  const sender = pick(overrides.senderId, config.sender)!;
  const dltEntityId = pick(overrides.dltEntityId, config.dltEntityId)!;
  const dltHeaderId = pick(overrides.dltHeaderId, config.dltHeaderId);
  const dltTagId = pick(overrides.dltTagId, config.dltTagId);

  const messagetype = messageType(text);
  if (text.length > MAX_LENGTH[messagetype]) {
    await metrics.incr('ns_sms_send_total', { provider: 'pinnacle', result: 'failed' });
    return {
      ok: false,
      error: `rendered body is ${text.length} chars, over the ${MAX_LENGTH[messagetype]} limit for ${messagetype}`,
      retryable: false,
    };
  }

  const payload = {
    sender,
    messagetype,
    dltentityid: dltEntityId,
    dlttempid: dltTemplateId,
    ...(dltHeaderId ? { dltheaderid: dltHeaderId } : {}),
    ...(dltTagId ? { dlttagid: dltTagId } : {}),
    ...(config.tmid ? { tmid: config.tmid } : {}),
    message: [
      {
        number: normalisePhone(to),
        text,
        ...(job_id ? { clientuid: job_id } : {}),
      },
    ],
  };

  let parsed: ReturnType<typeof readResponse>;
  try {
    const resp = await fetch(`${config.baseUrl}/index.php/sms/json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: config.apiKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(providerTimeoutMs(env)),
    });

    if (!resp.ok) {
      await metrics.incr('ns_sms_send_total', { provider: 'pinnacle', result: 'failed' });
      await metrics.incr('ns_sms_provider_error_total', {
        provider: 'pinnacle',
        code: errorCodeLabel(`HTTP_${resp.status}`),
      });
      return {
        ok: false,
        error: `pinnacle http ${resp.status}`,
        retryable: isRetryableHttpStatus(resp.status),
      };
    }

    // A 200 with a non-JSON body is reported as a bad response, not a network
    // error. It is still retried.
    let responsePayload: unknown;
    try {
      responsePayload = await resp.json();
    } catch {
      await metrics.incr('ns_sms_send_total', { provider: 'pinnacle', result: 'failed' });
      await metrics.incr('ns_sms_provider_error_total', { provider: 'pinnacle', code: 'OTHER' });
      return { ok: false, error: 'pinnacle returned a non-JSON body', retryable: true };
    }
    parsed = readResponse(responsePayload);
  } catch (err) {
    // Network-level failure: transient. Only the message is returned, never the
    // error object, which can carry the request (phone, text).
    await metrics.incr('ns_sms_send_total', { provider: 'pinnacle', result: 'failed' });
    return {
      ok: false,
      error: isTimeoutError(err) ? 'provider timeout' : err instanceof Error ? err.message : 'pinnacle request failed',
      retryable: true,
    };
  }

  if (!parsed.ok) {
    await metrics.incr('ns_sms_send_total', { provider: 'pinnacle', result: 'failed' });
    await metrics.incr('ns_sms_provider_error_total', {
      provider: 'pinnacle',
      code: errorCodeLabel(parsed.code),
    });
    return {
      ok: false,
      error: `pinnacle ${parsed.code}${parsed.message ? `: ${parsed.message}` : ''}`,
      retryable: RETRYABLE_ERROR_CODES.has(parsed.code),
    };
  }

  await metrics.incr('ns_sms_send_total', { provider: 'pinnacle', result: 'ok' });
  return { ok: true, provider_message_id: parsed.uniqueid };
}

/**
 * Poll the account balance into a gauge. Without it, `EC1003 Insufficient
 * Balance` fails every send permanently and looks like a bad template. Called on
 * an interval by the worker, never on the send path.
 */
export async function pollPinnacleBalance(env = process.env): Promise<number | null> {
  const config = loadPinnacleConfig(env);
  if ('error' in config) return await failPoll('not_configured', config.error);

  try {
    const resp = await fetch(`${config.baseUrl}/index.php/checkbalance`, {
      headers: { apikey: config.apiKey },
      signal: AbortSignal.timeout(providerTimeoutMs(env)),
    });
    if (!resp.ok) return await failPoll('http_error', `HTTP ${resp.status}`);

    const payload = (await resp.json()) as { data?: { balance?: unknown } };
    const balance = Number(payload?.data?.balance);
    if (!Number.isFinite(balance)) return await failPoll('unparseable', 'no numeric balance in response');

    await metrics.setGauge('ns_provider_balance', balance, { provider: 'pinnacle' });
    // Freshness is published alongside the value: the value alone cannot tell a
    // healthy balance from a stale one left by a dead poller.
    await metrics.setGauge('ns_provider_balance_updated_at', Math.floor(Date.now() / 1000), {
      provider: 'pinnacle',
    });
    return balance;
  } catch (err) {
    return await failPoll('request_failed', err instanceof Error ? err.message : 'unknown');
  }
}

/**
 * Every failed poll is logged and counted: otherwise the gauge would keep
 * reporting the last healthy number with no sign of trouble.
 */
async function failPoll(reason: string, detail: string): Promise<null> {
  console.log(`pinnacle balance poll failed (${reason}): ${detail}`);
  await metrics.incr('ns_provider_balance_poll_failures_total', {
    provider: 'pinnacle',
    reason,
  });
  return null;
}

export const pinnacleSmsProvider: ProviderDefinition = {
  // `sms`, not `pinnacle-sms`: the registry keys on this name and it is the
  // `channel` every caller sends, so swapping vendors does not change it.
  name: 'sms',
  vendor: 'pinnacle',
  renders: 'ns',

  // Pinnacle's `dlttempid` is the DLT template id itself, so a raw pass-through
  // id needs no entry here. Only templates this service names need a mapping,
  // plus a body, since Pinnacle renders nothing.
  templates: {
    login_otp: process.env.PINNACLE_LOGIN_OTP_TEMPLATE_ID ?? '',
  },
  bodies: {
    login_otp: process.env.SMS_LOGIN_OTP_BODY ?? '',
  },
  allowRawTemplateId: true,

  schema: z.record(z.string(), z.string()),

  async send({ to, template_id, variables, body, job_id }) {
    return await sendSmsWithPinnacle(to, template_id, variables, body, job_id);
  },

  async sendRendered({ to, rendered, providerTemplateId, dlt, job_id }) {
    if (rendered.mode !== 'ns' || rendered.channel !== 'sms' || !providerTemplateId) {
      return { ok: false, retryable: false, error: 'rendered mode not supported by pinnacle' };
    }
    return sendPinnacleText(to, providerTemplateId, rendered.text, dlt ?? {}, job_id);
  },
};
