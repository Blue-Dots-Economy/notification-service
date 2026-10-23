import { z } from 'zod';
import { ProviderDefinition, ProviderSendResult } from '../../../types/provider';
import * as metrics from '../../metrics';
import { isRetryableHttpStatus } from './http_status';
import { MAX_LENGTH, messageType, renderBody, UnresolvedTemplateVariables } from './render';

/**
 * Pinnacle Teleservices SMS provider — the JSON endpoint (`/index.php/sms/json`).
 *
 * The shape difference from MSG91 is the whole reason this file is interesting.
 * MSG91's Flow API takes a flow id plus named variables and renders the
 * DLT-approved body itself. Pinnacle renders NOTHING: it takes final `text` and
 * carries the DLT identifiers alongside, for the operator to match against the
 * registered template. So this adapter renders the body (see `./render`) and
 * attaches the DLT metadata from config.
 *
 * DLT ids are issued by the DLT platform against the sending *principal entity*
 * — the adopter — so `sender`/`dltentityid` are deployment-wide config, while
 * `dlttempid` varies per template and arrives as the `template_id`.
 */

const DEFAULT_BASE_URL = 'https://api.pinnacle.in';
const DEFAULT_TIMEOUT_MS = 10_000;

function requestTimeoutMs(env: NodeJS.ProcessEnv): number {
  const configured = Number(env.PINNACLE_TIMEOUT_MS);
  return configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
}

const OTP_TEMPLATE_ENV_VARS: Record<string, string> = {
  signals_signin_otp: 'PINNACLE_TEMPLATE_SIGNALS_SIGNIN_OTP',
  signals_signup_otp: 'PINNACLE_TEMPLATE_SIGNALS_SIGNUP_OTP',
  aggregator_signin_otp: 'PINNACLE_TEMPLATE_AGGREGATOR_SIGNIN_OTP',
  aggregator_signup_otp: 'PINNACLE_TEMPLATE_AGGREGATOR_SIGNUP_OTP',
};

const VariableSpecSchema = z.looseObject({
  name: z.string().min(1),
  required: z.boolean().optional(),
  type: z.string().optional(),
  sensitive: z.boolean().optional(),
  raw: z.boolean().optional(),
  urlHosts: z.array(z.string().min(1)).optional(),
});

const OtpTemplateRowSchema = z.looseObject({
  template_key: z.string().min(1),
  network: z.string().min(1),
  channel: z.literal('sms'),
  locale: z.string().min(1),
  provider: z.literal('pinnacle'),
  provider_template_id: z.string().trim().min(1),
  body_text: z.string().min(1),
  variables: z.array(VariableSpecSchema),
  version: z.number().int().optional(),
  approval_ref: z.string().optional(),
});

export type OtpTemplateRow = z.infer<typeof OtpTemplateRowSchema>;

export function parseOtpTemplateRow(raw: string, expectedKey: string): OtpTemplateRow | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { error: 'not valid JSON' };
  }
  const parsed = OtpTemplateRowSchema.safeParse(json);
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i) => i.path.join('.') || 'row').join(', ') + ' invalid or missing' };
  }
  const row = parsed.data;
  if (row.template_key !== expectedKey) {
    return { error: `template_key is '${row.template_key}', expected '${expectedKey}'` };
  }
  const placeholders = [...row.body_text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
  const declared = row.variables.map((v) => v.name);
  const undeclaredPlaceholders = placeholders.filter((v) => !declared.includes(v));
  if (undeclaredPlaceholders.length) return { error: `body_text uses undeclared variables: ${undeclaredPlaceholders.join(', ')}` };
  return row;
}

/**
 * Allowed link hosts per url variable, keyed by template key. Not by DLT id:
 * several templates can share one DLT registration (ALIMCO's Signals and
 * Aggregator rows do) while allowing different hosts.
 */
type UrlHosts = Record<string, Record<string, string[]>>;

export function loadOtpTemplates(env = process.env): {
  templates: Record<string, string>;
  bodies: Record<string, string>;
  urlHosts: UrlHosts;
} {
  const templates: Record<string, string> = {};
  const bodies: Record<string, string> = {};
  const urlHosts: UrlHosts = {};
  for (const [key, setting] of Object.entries(OTP_TEMPLATE_ENV_VARS)) {
    const raw = env[setting];
    if (!raw) continue;
    const row = parseOtpTemplateRow(raw, key);
    if ('error' in row) {
      // A broken row would otherwise fall through to raw pass-through and fail
      // only at send time, so refuse to start while Pinnacle is the vendor.
      if (env.SMS_PROVIDER === 'pinnacle') throw new Error(`pinnacle: ${setting} is invalid (${row.error})`);
      console.log(`pinnacle: ${setting} skipped (${row.error}); template ${key} not configured`);
      continue;
    }
    templates[key] = row.provider_template_id;
    bodies[key] = row.body_text;
    const hosts = Object.fromEntries(
      row.variables.filter((v) => v.type === 'url' && v.urlHosts).map((v) => [v.name, v.urlHosts!])
    );
    if (Object.keys(hosts).length) urlHosts[key] = hosts;
  }
  return { templates, bodies, urlHosts };
}

/** Why a url variable may not be sent, or undefined when every link is on its allowed hosts. */
export function linkNotAllowed(
  hostsByVariable: Record<string, string[]> | undefined,
  variables: Record<string, string>
): string | undefined {
  for (const [name, hosts] of Object.entries(hostsByVariable ?? {})) {
    const value = variables[name];
    if (value === undefined) continue;
    let host = '';
    try {
      host = new URL(value).host;
    } catch {
      // not a URL; reported below like any other disallowed host
    }
    if (!hosts.includes(host)) return `${name} host '${host || value}' not in urlHosts`;
  }
  return undefined;
}

interface PinnacleConfig {
  baseUrl: string;
  apiKey: string;
  sender: string;
  dltEntityId?: string;
  dltHeaderId?: string;
  dltTagId?: string;
  tmid?: string;
}

/**
 * The only two codes the vendor documents as transient: EC1009 ("unable to
 * process request") and EC1010 ("submission exceeded time limit").
 *
 * The classification is deliberately an allowlist of RETRYABLE codes rather
 * than a list of permanent ones. An enumeration of permanent codes has to track
 * the vendor's table exactly, and that table has holes — EC1018 and EC1020 do
 * not exist in it at all, and EC1024/EC1025/EC1029/EC1030 are reseller and
 * account-management errors that a send can never produce. Listing permanents
 * meant those six looked like deliberate retry decisions when they were just
 * gaps, and each one silently cost five attempts.
 *
 * Inverting it also fails safe: an `EC` code we do not recognise is the vendor
 * telling us it understood the request and refused it, which does not improve
 * on retry. Genuinely transient conditions arrive as HTTP 5xx, 408, 429 or a
 * socket error, all handled separately.
 */
const RETRYABLE_ERROR_CODES = new Set(['EC1009', 'EC1010']);

export function loadPinnacleConfig(env = process.env): PinnacleConfig | { error: string } {
  const missing = ['PINNACLE_API_KEY', 'PINNACLE_SENDER_ID'].filter((k) => !env[k]);
  if (missing.length) return { error: `pinnacle not configured: missing ${missing.join(', ')}` };

  return {
    // Forced to https even if overridden: the vendor doc lists the status
    // endpoint as http, and an API key in a cleartext header is not acceptable.
    baseUrl: (env.PINNACLE_BASE_URL || DEFAULT_BASE_URL).replace(/^http:/, 'https:'),
    apiKey: env.PINNACLE_API_KEY!,
    sender: env.PINNACLE_SENDER_ID!,
    dltEntityId: env.PINNACLE_DLT_ENTITY_ID || undefined,
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
 * Pinnacle answers 200 for business errors too, so the HTTP status alone says
 * nothing. Success is `status: success` AND `code: 200`; anything else carries
 * an `EC1xxx` in `code`.
 */
/**
 * Only `EC1xxx` and `HTTP_nnn` become metric labels; anything else collapses to
 * `OTHER`. The code comes from a vendor response, so left unbounded it is both
 * a cardinality leak into a Redis hash with no TTL and — since the value is
 * interpolated into the exposition — a way for a malformed vendor payload to
 * break the entire scrape document.
 */
export function errorCodeLabel(code: string): string {
  return /^EC1\d{3}$/.test(code) || /^HTTP_\d{3}$/.test(code) ? code : 'OTHER';
}

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
  _job_id: string | undefined,
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
    sender: config.sender,
    messagetype,
    ...(config.dltEntityId ? { dltentityid: config.dltEntityId } : {}),
    dlttempid: template_id,
    ...(config.dltHeaderId ? { dltheaderid: config.dltHeaderId } : {}),
    ...(config.dltTagId ? { dlttagid: config.dltTagId } : {}),
    ...(config.tmid ? { tmid: config.tmid } : {}),
    message: [
      {
        number: normalisePhone(to),
        text,
        // No clientuid: Pinnacle rejects a job id there (EC1036 Invalid Client
        // UID). Delivery receipts will need one in a format Pinnacle accepts.
      },
    ],
  };

  let parsed: ReturnType<typeof readResponse>;
  try {
    const resp = await fetch(`${config.baseUrl}/index.php/sms/json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: config.apiKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(requestTimeoutMs(env)),
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

    // A vendor that answers 200 with a non-JSON body would otherwise throw out
    // of `json()` and be reported as a network error. It is a bad response, not
    // a bad connection, and retrying it is still right — but it should say so.
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
    // Network-level failure — genuinely transient, and the message is logged
    // rather than the error object, which can carry the request (phone, text).
    await metrics.incr('ns_sms_send_total', { provider: 'pinnacle', result: 'failed' });
    return {
      ok: false,
      error: requestErrorMessage(err),
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
 * Poll the account balance into a gauge. `EC1003 Insufficient Balance` is
 * otherwise a silent killer — every send fails permanently and nothing else in
 * the system can distinguish that from a bad template. Called on an interval by
 * the worker, never on the send path.
 */
export async function pollPinnacleBalance(env = process.env): Promise<number | null> {
  const config = loadPinnacleConfig(env);
  if ('error' in config) return await failPoll('not_configured', config.error);

  try {
    const resp = await fetch(`${config.baseUrl}/index.php/checkbalance`, {
      headers: { apikey: config.apiKey },
    });
    if (!resp.ok) return await failPoll('http_error', `HTTP ${resp.status}`);

    const payload = (await resp.json()) as { data?: { balance?: unknown } };
    const balance = Number(payload?.data?.balance);
    if (!Number.isFinite(balance)) return await failPoll('unparseable', 'no numeric balance in response');

    await metrics.setGauge('ns_provider_balance', balance, { provider: 'pinnacle' });
    // Freshness is published alongside the value because the value alone cannot
    // distinguish "balance is healthy" from "the poller died an hour ago and
    // this number is stale" — and those two look identical right up until every
    // send starts failing on EC1003.
    await metrics.setGauge('ns_provider_balance_updated_at', Math.floor(Date.now() / 1000), {
      provider: 'pinnacle',
    });
    return balance;
  } catch (err) {
    return await failPoll('request_failed', err instanceof Error ? err.message : 'unknown');
  }
}

/**
 * A balance poll that fails silently is worse than no poll at all: the gauge
 * keeps reporting the last healthy number forever. Every exit records why.
 */
async function failPoll(reason: string, detail: string): Promise<null> {
  console.log(`pinnacle balance poll failed (${reason}): ${detail}`);
  await metrics.incr('ns_provider_balance_poll_failures_total', {
    provider: 'pinnacle',
    reason,
  });
  return null;
}

function requestErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return 'pinnacle request failed';
  return err.name === 'TimeoutError' ? 'pinnacle request timed out' : err.message;
}

const otpTemplates = loadOtpTemplates();

export const pinnacleSmsProvider: ProviderDefinition = {
  // Deliberately `sms`, not `pinnacle-sms`: the provider registry keys on this
  // name and it is the `channel` every caller sends. Swapping vendors must not
  // change the channel.
  name: 'sms',

  // Pinnacle's `dlttempid` IS the DLT template id, so unlike MSG91 there is no
  // vendor-internal indirection — a raw pass-through id needs no entry here.
  // Only the templates this service NAMES need a mapping, and they need a body
  // to go with it, since Pinnacle renders nothing.
  templates: {
    login_otp: process.env.PINNACLE_LOGIN_OTP_TEMPLATE_ID ?? '',
    ...otpTemplates.templates,
  },
  bodies: {
    login_otp: process.env.SMS_LOGIN_OTP_BODY ?? '',
    ...otpTemplates.bodies,
  },
  allowRawTemplateId: true,

  schema: z.record(z.string(), z.string()),

  async send({ to, template_id, template_key, variables, body, job_id }) {
    const notAllowed = linkNotAllowed(template_key ? otpTemplates.urlHosts[template_key] : undefined, variables ?? {});
    if (notAllowed) return { ok: false, error: notAllowed, retryable: false };
    return await sendSmsWithPinnacle(to, template_id, variables, body, job_id);
  },
};
