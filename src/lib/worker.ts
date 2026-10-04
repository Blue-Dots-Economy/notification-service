import { pushDLQ, scheduleRetryWithMarker } from './queue';
import { poolConfig, startPools } from './pools';
import { providers } from './providers';
import * as metrics from './metrics';
import { Job } from 'src/types';
import { ProviderSendResult } from 'src/types/provider';
import { loadSecrets } from './auth/secrets';
import { stamp } from './audit/stamp';
import { attemptMarker, markAttempt } from './audit/marker';

const MAX_RETRIES = 5;

/**
 * Runs one job through its provider, then decides its fate: delivered, scheduled
 * for another attempt with exponential backoff, or moved to the dead-letter queue.
 *
 * Exported for tests. The worker pools are the only production caller.
 *
 * @param job - The job to attempt. Its `attempt` counter is incremented in place.
 */
export async function processJob(job: Job) {
  const provider = providers[job.channel];
  job.attempt = (job.attempt ?? 0) + 1;

  if (!provider) {
    await metrics.incr('ns_job_dlq_total', { channel: job.channel, reason: 'unknown_channel' });
    console.log('Unknown provider, sending to DLQ:', job.job_id, job.channel);
    await markAttempt(job, 'failed', job.attempt);
    await stamp(job, { status: 'failed', attemptNo: job.attempt, error: 'unknown_channel' });
    return pushDLQ(job);
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
    await metrics.incr('ns_job_dlq_total', { channel: job.channel, reason: 'template_not_configured' });
    console.log(
      `Template '${job.template_id}' is named but not fully configured for the active provider ` +
        `(id=${named === '' ? 'missing' : 'ok'}, body=${namedBody === '' ? 'missing' : 'ok'}), sending to DLQ:`,
      job.job_id
    );
    await markAttempt(job, 'failed', job.attempt);
    await stamp(job, { status: 'failed', attemptNo: job.attempt, error: 'template_not_configured' });
    return pushDLQ(job);
  }

  const templateId = named ?? (provider.allowRawTemplateId ? job.template_id : undefined);
  if (!templateId) {
    await metrics.incr('ns_job_dlq_total', { channel: job.channel, reason: 'unknown_template' });
    console.log('Unknown provider template, sending to DLQ:', job.job_id);
    await markAttempt(job, 'failed', job.attempt);
    await stamp(job, { status: 'failed', attemptNo: job.attempt, error: 'unknown_template' });
    return pushDLQ(job);
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
      await metrics.incr('ns_job_dlq_total', { channel: job.channel, reason: 'permanent_failure' });
      console.log(`Permanent failure → DLQ: ${job.job_id}${res.error ? ` (${res.error})` : ''}`);
      await markAttempt(job, 'failed', job.attempt);
      await stamp(job, { status: 'failed', attemptNo: job.attempt, error: res.error ?? 'permanent_failure' });
      return pushDLQ(job);
    }

    if (job.attempt >= MAX_RETRIES) {
      await metrics.incr('ns_job_dlq_total', { channel: job.channel, reason: 'max_retries' });
      console.log(
        `Max retries reached → DLQ: ${job.job_id}${res.error ? ` (${res.error})` : ''}`
      );
      await markAttempt(job, 'failed', job.attempt);
      await stamp(job, { status: 'failed', attemptNo: job.attempt, error: res.error ?? 'max_retries' });
      return pushDLQ(job);
    }

    const delay = 5 * Math.pow(2, job.attempt - 1);
    console.log(`Retry scheduled in ${delay}s:`, job.job_id);

    // Stamp, then the retry ZADD and the `retry` marker in one MULTI: the
    // marker exists iff the retry is scheduled, so if the stamp failed and the
    // row stays `dispatching`, recovery leaves it to the retry set — and if the
    // process dies before the MULTI, there is no marker and recovery re-queues.
    await stamp(job, { status: 'queued', attemptNo: job.attempt + 1, error: res.error });
    return scheduleRetryWithMarker(job, delay, attemptMarker(job, 'retry', job.attempt + 1));
  }

  // Marker before stamp: a failed `sent` stamp must not let recovery re-send.
  await markAttempt(job, 'sent', job.attempt);
  await stamp(job, { status: 'sent', attemptNo: job.attempt, providerMessageId: res.provider_message_id });
  console.log('Delivered:', job.job_id);
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
  // An unhandled rejection here would kill the only process that sends
  // anything, while the API stays healthy and keeps accepting jobs into a queue
  // nothing drains. Crash loudly instead so the orchestrator restarts it.
  // Fail fast on bad pool config: a worker that cannot size its pools must not
  // start half-configured.
  startPools(poolConfig());
}

export function spawnWorker() {
  const { fork } = require('child_process');
  fork(__filename, ['worker']);
}
