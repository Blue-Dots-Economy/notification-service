import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { deferJob, pushDLQ, pushToPriorityWithMarker, scheduleRetryWithMarker } from './queue';
import { acquireSendToken, bucketsFor, rateLimitDeferMs } from './rate_limit';
import { providerTimeoutMs } from './providers/http';
import { poolConfig, startPools, type Deferred } from './pools';
import { providers } from './providers';
import * as metrics from './metrics';
import { Job } from 'src/types';
import type { ProviderDefinition, ProviderSendResult } from 'src/types/provider';
import type { PlannedDelivery } from './send/plan';
import { loadSecrets } from './auth/secrets';
import { stamp } from './audit/stamp';
import { attemptMarker, markAttempt } from './audit/marker';
import { isExpired, isRedacted, urgentDefaultDeadlineS, wouldExpire } from './deadline';

const MAX_RETRIES = 5;

/** Past its deadline: never sent. Terminal, and never dead-lettered. */
async function expire(job: Job, attemptNo: number, cause?: string) {
  await metrics.incr('ns_job_expired_total', { channel: job.channel });
  await markAttempt(job, 'expired', attemptNo);
  await stamp(job, { status: 'expired', attemptNo, error: cause ? `deadline passed: ${cause}` : 'deadline passed' });
}

/**
 * Put a job back without counting an attempt and tell the pool loop how long
 * it waits: the bucket (or Redis) said no, so popping again at once would only
 * spin on the same denial.
 */
async function defer(job: Job, wait: number): Promise<Deferred> {
  await deferJob(job, wait);
  return { deferredMs: wait };
}

/** Log wording that matches what dropOrDeadLetter will do with the job. */
function fate(job: Job): string {
  return isRedacted(job) ? 'dropped (redacted, no DLQ)' : '→ DLQ';
}

/**
 * Where a job goes when it cannot be sent. Redacted (OTP) jobs are never put in
 * the DLQ: a dead-letter entry would keep a live code at rest. They end
 * `failed` and are counted as dropped instead.
 */
async function dropOrDeadLetter(job: Job, reason: string, error?: string) {
  const attemptNo = job.attempt ?? 1;
  await markAttempt(job, 'failed', attemptNo);
  await stamp(job, { status: 'failed', attemptNo, error: error ?? reason });
  if (isRedacted(job)) {
    await metrics.incr('ns_job_dropped_total', { channel: job.channel, reason });
    return;
  }
  await metrics.incr('ns_job_dlq_total', { channel: job.channel, reason });
  return pushDLQ(job);
}

/**
 * Take a vendor token before the attempt is counted. Returns `{ result }` when
 * the job must not be attempted now — deferred (the token was denied, or the
 * check itself failed) or expired because the deferral would pass its
 * deadline — and undefined when the send may go ahead. No provider, no token:
 * the caller fails the job on its own terms.
 */
async function holdForToken(
  job: Job,
  channel: string,
  provider: ProviderDefinition | undefined,
): Promise<{ result: Deferred | void } | undefined> {
  if (!provider) return undefined;
  let granted: boolean;
  try {
    granted = await acquireSendToken(channel, provider.vendor, job.priority);
  } catch (err) {
    // The job is already popped: losing it to a Redis hiccup is worse than a
    // short deferral. If this defer fails too, the throw propagates.
    console.error(
      `rate limit check failed for ${job.job_id}, deferring:`,
      err instanceof Error ? err.message : String(err),
    );
    const wait = rateLimitDeferMs();
    if (wouldExpire(job, wait)) return { result: await expire(job, (job.attempt ?? 0) + 1) };
    return { result: await defer(job, wait) };
  }
  if (granted) return undefined;
  await metrics.incr('ns_rate_limited_total', { channel, priority: job.priority });
  const wait = rateLimitDeferMs();
  if (wouldExpire(job, wait)) return { result: await expire(job, (job.attempt ?? 0) + 1) };
  return { result: await defer(job, wait) };
}

/**
 * Runs one job through its provider, then decides its fate: delivered, scheduled
 * for another attempt with exponential backoff, or moved to the dead-letter queue.
 *
 * Exported for tests. The worker pools are the only production caller.
 * Returns `{ deferredMs }` when the job was deferred (rate limit or a failed
 * token check) so the pool loop backs off; other outcomes return as before.
 *
 * @param job - The job to attempt. Its `attempt` counter is incremented in place.
 */
export async function processJob(job: Job) {
  if (job.v1) return processV1Job(job);
  if (isExpired(job)) return expire(job, (job.attempt ?? 0) + 1);

  const provider = providers[job.channel];

  // Before the attempt is counted: a rate-limited job has not been tried, so it
  // is deferred, not failed, and uses none of its retry budget.
  const held = await holdForToken(job, job.channel, provider);
  if (held) return held.result;

  job.attempt = (job.attempt ?? 0) + 1;

  if (!provider) {
    console.log(`Unknown provider, ${fate(job)}:`, job.job_id, job.channel);
    return dropOrDeadLetter(job, 'unknown_channel');
  }

  // Resolve a known template name to its provider-side id; when the provider
  // owns raw ids (SMS, #532/#535) an unknown id is passed through verbatim.
  const named = provider.templates[job.template_id];
  const namedBody = provider.bodies?.[job.template_id];

  // A template the provider NAMES but has no id — or no body, where it owns one
  // — is the placeholder case: the vendor's DLT approval has not landed yet.
  //
  // The body half is the security-relevant one. `bodies` and `templates` are
  // both declarations that THIS service owns the template, so a blank body must
  // not silently fall back to the caller's `body`: that would put arbitrary
  // caller text on the wire under a DLT-approved template id, which is both a
  // compliance break and a phishing primitive. Declared-but-blank is a
  // configuration gap, never an invitation for the caller to fill it.
  if (named === '' || namedBody === '') {
    console.log(
      `Template '${job.template_id}' is named but not fully configured for the active provider ` +
        `(id=${named === '' ? 'missing' : 'ok'}, body=${namedBody === '' ? 'missing' : 'ok'}), ${fate(job)}:`,
      job.job_id
    );
    return dropOrDeadLetter(job, 'template_not_configured');
  }

  const templateId = named ?? (provider.allowRawTemplateId ? job.template_id : undefined);
  if (!templateId) {
    console.log(`Unknown provider template, ${fate(job)}:`, job.job_id);
    return dropOrDeadLetter(job, 'unknown_template');
  }

  console.log(`Processing ${job.job_id} (attempt ${job.attempt})`);

  // `??`, never `||`: a provider that NAMES the template owns its body, and the
  // blank case was already dead-lettered above. Only a template this service
  // does not name — a raw pass-through id — falls back to the caller's body.
  const body = namedBody ?? job.body;

  await stamp(job, { status: 'dispatching', attemptNo: job.attempt });

  let res: ProviderSendResult;
  try {
    res = await provider.send({
      to: job.to,
      template_id: templateId,
      variables: job.variables,
      body,
      job_id: job.job_id,
    });
  } catch (err) {
    // The job is already popped and not yet in the DLQ, so an unexpected throw
    // from a provider would drop the notification silently. Treat it as a
    // retryable failure and let the normal ladder below decide its fate.
    console.log(
      `Provider threw for ${job.job_id}:`,
      err instanceof Error ? err.message : String(err)
    );
    res = { ok: false, error: 'provider threw', retryable: true };
  }

  if (!res.ok) {
    // A failure the provider knows is permanent — an unregistered template, a
    // rejected sender id — will fail identically four more times. Retrying it
    // only delays the diagnosis and buries the cause under "max retries".
    if (res.retryable === false) {
      console.log(`Permanent failure ${fate(job)}: ${job.job_id}${res.error ? ` (${res.error})` : ''}`);
      return dropOrDeadLetter(job, 'permanent_failure', res.error);
    }

    if (job.attempt >= MAX_RETRIES) {
      console.log(
        `Max retries reached ${fate(job)}: ${job.job_id}${res.error ? ` (${res.error})` : ''}`
      );
      return dropOrDeadLetter(job, 'max_retries', res.error);
    }

    const delay = 5 * Math.pow(2, job.attempt - 1);
    if (wouldExpire(job, delay * 1000)) return expire(job, job.attempt, res.error);
    console.log(`Retry scheduled in ${delay}s:`, job.job_id);

    // The retry ZADD and the `retry` marker in one MULTI, THEN the `queued`
    // stamp. The marker exists iff the retry is scheduled, and the row stays
    // `dispatching` until it is, so the stale-dispatch sweep covers every crash
    // here: before (or a failed) MULTI → no marker → re-queued; after it → the
    // marker says the job is in the retry set → left alone, whether or not the
    // `queued` stamp landed. Stamping `queued` first would strand the row: the
    // sweep only re-queues stale `dispatching` rows. A late `queued` stamp can
    // never overwrite the retry's own stamps (monotonic on attempt_no, rank).
    await scheduleRetryWithMarker(job, delay, attemptMarker(job, 'retry', job.attempt + 1));
    await stamp(job, { status: 'queued', attemptNo: job.attempt + 1, error: res.error });
    return;
  }

  // Marker before stamp: a failed `sent` stamp must not let recovery re-send.
  await markAttempt(job, 'sent', job.attempt);
  await stamp(job, { status: 'sent', attemptNo: job.attempt, providerMessageId: res.provider_message_id });
  console.log('Delivered:', job.job_id);
}

/** The delivery at `index`, or undefined when the job's plan is missing or malformed. */
function deliveryAt(v1: Job['v1'], index: number | undefined): PlannedDelivery | undefined {
  if (!v1 || !Array.isArray(v1.deliveries) || !Number.isInteger(index)) return undefined;
  const d = v1.deliveries[index!];
  return d && typeof d === 'object' && typeof d.channel === 'string' ? d : undefined;
}

/** The delivery a first_available job falls through to, if one remains. */
function nextDelivery(job: Job): PlannedDelivery | undefined {
  const v1 = job.v1;
  if (!v1 || v1.mode !== 'first_available' || !deliveryAt(v1, v1.index)) return undefined;
  return deliveryAt(v1, v1.index + 1);
}

/**
 * Close attempt a1 (`job`) as failed and start the next delivery as a new
 * attempt a2: fresh attemptId, attempt counter reset, channel/to/template from
 * that delivery, the rest of `audit` kept. a2's `queued` stamp writes its row,
 * whose job copy is the ADVANCED job (index + 1), so recovery resends the right
 * delivery. Order, like scheduleRetryWithMarker: stamp a2 `queued` → one
 * MULTI {LPUSH a2, SET a1 marker failed:n} → stamp a1 `failed`. The a1 marker
 * therefore exists iff a2 is queued: a crash before the MULTI leaves a1 open
 * with no marker, so recovery re-queues a1 rather than losing the event.
 */
async function fallThrough(job: Job, next: PlannedDelivery, attemptNo: number, error: string): Promise<void> {
  const v1 = job.v1!;
  const from = job.channel;
  const advanced: Job = {
    ...job,
    channel: next.channel,
    to: next.to,
    template_id: next.templateKey,
    attempt: 0,
    v1: { ...v1, index: v1.index + 1 },
    audit: { ...job.audit!, attemptId: randomUUID() },
  };
  // Record before queue, as on /notify: the row exists before the job can be popped.
  await stamp(advanced, { status: 'queued', attemptNo: 1 });
  try {
    await pushToPriorityWithMarker(advanced, attemptMarker(job, 'failed', attemptNo));
  } catch (err) {
    // Close both attempts so neither is left open with nothing behind it.
    await markAttempt(advanced, 'failed', 1);
    await stamp(advanced, { status: 'failed', attemptNo: 1, error: 'enqueue failed' });
    await markAttempt(job, 'failed', attemptNo);
    await stamp(job, { status: 'failed', attemptNo, error });
    throw err;
  }
  await stamp(job, { status: 'failed', attemptNo, error });
  await metrics.incr('ns_send_fallthrough_total', { from, to: next.channel });
  console.log(`Falling through ${job.job_id}: ${from} → ${next.channel}`);
}

/**
 * A v1 delivery that cannot succeed (permanent failure or retries exhausted).
 * first_available with a delivery left: close this attempt `failed` and fall
 * through — unless the deadline has passed, when the event expires instead of
 * starting a delivery that could only arrive late. Otherwise the job takes the
 * same fate as a legacy job: dropOrDeadLetter, which closes the attempt itself.
 */
async function failDelivery(job: Job, reason: string, error?: string) {
  const next = nextDelivery(job);
  if (!next) {
    console.log(`v1 delivery failed (${reason}) ${fate(job)}: ${job.job_id}`);
    return dropOrDeadLetter(job, reason, error);
  }
  const attemptNo = job.attempt ?? 1;
  if (isExpired(job)) return expire(job, attemptNo, error ?? reason);
  return fallThrough(job, next, attemptNo, error ?? reason);
}

/**
 * Send API v1: content was rendered and validated at accept, so the worker
 * only sends it (`sendRendered`) and decides its fate. Deadline, vendor token,
 * retry ladder and redaction rules are the legacy path's; the difference is
 * what happens when a delivery cannot succeed (see failDelivery).
 */
async function processV1Job(job: Job) {
  if (isExpired(job)) return expire(job, (job.attempt ?? 0) + 1);

  const d = deliveryAt(job.v1, job.v1?.index);
  const provider = d ? providers[d.channel] : undefined;

  const held = await holdForToken(job, d?.channel ?? job.channel, provider);
  if (held) return held.result;

  job.attempt = (job.attempt ?? 0) + 1;

  if (!d) return failDelivery(job, 'invalid_delivery', 'no planned delivery at index');
  if (!provider) return failDelivery(job, 'unknown_channel');
  if (!provider.sendRendered) return failDelivery(job, 'rendered_send_unsupported', 'rendered send unsupported');
  // Templates are registered per vendor: a DLT or Meta id from another vendor is meaningless.
  if (provider.vendor !== d.provider) return failDelivery(job, 'vendor_changed', 'vendor changed since accept');

  console.log(`Processing ${job.job_id} (v1 ${d.channel}, attempt ${job.attempt})`);
  await stamp(job, { status: 'dispatching', attemptNo: job.attempt });

  let res: ProviderSendResult;
  try {
    res = await provider.sendRendered({
      to: d.to,
      rendered: d.rendered,
      providerTemplateId: d.providerTemplateId,
      dlt: d.dlt,
      email: d.channel === 'email' ? job.v1!.email : undefined,
      job_id: job.job_id,
    });
  } catch (err) {
    console.log(`Provider threw for ${job.job_id}:`, err instanceof Error ? err.message : String(err));
    res = { ok: false, error: 'provider threw', retryable: true };
  }

  if (res.ok) {
    // Marker before stamp: a failed `sent` stamp must not let recovery re-send.
    await markAttempt(job, 'sent', job.attempt);
    await stamp(job, { status: 'sent', attemptNo: job.attempt, providerMessageId: res.provider_message_id });
    console.log('Delivered:', job.job_id);
    return;
  }
  if (res.retryable === false) return failDelivery(job, 'permanent_failure', res.error);
  if (job.attempt >= MAX_RETRIES) return failDelivery(job, 'max_retries', res.error);

  const delay = 5 * Math.pow(2, job.attempt - 1);
  if (wouldExpire(job, delay * 1000)) return expire(job, job.attempt, res.error);
  console.log(`Retry scheduled in ${delay}s:`, job.job_id);
  // MULTI first, then the `queued` stamp, as on the legacy path (see processJob):
  // the row stays `dispatching` until the retry is in Redis, so the stale sweep covers a crash.
  await scheduleRetryWithMarker(job, delay, attemptMarker(job, 'retry', job.attempt + 1));
  await stamp(job, { status: 'queued', attemptNo: job.attempt + 1, error: res.error });
}

/**
 * Parse every env value processJob reads per job. A bad value would otherwise
 * throw after the job was popped and drop it, so the worker checks at boot and
 * exits instead, like an invalid pool config.
 */
export function validateWorkerConfig(env: NodeJS.ProcessEnv = process.env): void {
  for (const channel of Object.keys(providers)) bucketsFor(channel, env);
  rateLimitDeferMs(env);
  providerTimeoutMs(env);
  urgentDefaultDeadlineS(env);
}

/**
 * Keep the provider balance gauge fresh. Insufficient balance fails every send
 * permanently and looks exactly like a bad template from the outside, so it
 * needs its own signal rather than being inferred from the error stream. Runs
 * on the worker because the worker is the process that holds provider
 * credentials; the interval is long because balance moves slowly.
 */
const BALANCE_POLL_INTERVAL_MS = Number(process.env.BALANCE_POLL_INTERVAL_MS) || 15 * 60 * 1000;

function startBalancePolling() {
  if ((process.env.SMS_PROVIDER || '').trim().toLowerCase() !== 'pinnacle') return;
  const { pollPinnacleBalance } = require('./providers/sms/pinnacle');
  const poll = () => {
    pollPinnacleBalance().catch(() => {
      /* best-effort: a failed poll must never take the worker down */
    });
  };
  poll();
  setInterval(poll, BALANCE_POLL_INTERVAL_MS).unref();
}

if (process.argv.includes('worker')) {
  loadSecrets();
  console.log('Worker started:', process.pid);
  startBalancePolling();
  // Fail fast on bad config: a worker that cannot size its pools or parse its
  // rate limits must not start half-configured. The API validated the same
  // values before listen, so this only fires if they differ between processes;
  // the exit then takes the API down too (see spawnWorker).
  validateWorkerConfig();
  startPools(poolConfig());
}

/**
 * Fork the worker. If it exits for any reason the API exits with it: the worker
 * is the only process that sends, so an API left running without it would stay
 * healthy and keep queueing work nothing drains. Exiting hands the restart to
 * the orchestrator.
 */
export function spawnWorker(exit: (code: number) => never = process.exit) {
  const child = fork(__filename, ['worker']);
  child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    console.error(`Worker exited (code=${code ?? 'none'}, signal=${signal ?? 'none'}); exiting so the pod restarts`);
    exit(code ?? 1);
  });
  return child;
}
