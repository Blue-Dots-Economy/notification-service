import redis from './redis';

/**
 * Prometheus counters and gauges, stored in Redis because the worker that
 * performs every send runs in a separate process from the API server that
 * serves `/metrics` (see `src/server.ts`). An in-process registry would expose
 * an API process that has sent nothing.
 *
 * Queue depths are not stored: they are read live from `getQueueMetrics()` at
 * scrape time. `setGauge` holds values nothing else observes (provider balance,
 * partition default rows, content load time).
 */

const COUNTERS_KEY = 'metrics:counters';
const GAUGES_KEY = 'metrics:gauges';

export type Labels = Record<string, string>;

/**
 * `|`, `,` and `=` are the field encoding's own delimiters, so a label value
 * containing one would round-trip through `parseField` as a different series,
 * or as a malformed name, which makes Prometheus reject the whole scrape
 * document. Values can come from provider responses, so they are untrusted.
 */
function sanitiseLabelValue(value: string): string {
  return value.replace(/[|,=]/g, '_');
}

/** `name|k=v,k=v` — label keys sorted so one series has exactly one field. */
function field(name: string, labels: Labels): string {
  const pairs = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${sanitiseLabelValue(labels[k]!)}`)
    .join(',');
  return pairs ? `${name}|${pairs}` : name;
}

function parseField(raw: string): { name: string; labels: Labels } {
  const sep = raw.indexOf('|');
  if (sep === -1) return { name: raw, labels: {} };
  const labels: Labels = {};
  for (const pair of raw.slice(sep + 1).split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) labels[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return { name: raw.slice(0, sep), labels };
}

/**
 * Best-effort, never throws: a Redis hiccup while recording a send must not
 * turn a delivered message into a retry.
 */
export async function incr(name: string, labels: Labels = {}, by = 1): Promise<void> {
  try {
    await redis.hincrby(COUNTERS_KEY, field(name, labels), by);
  } catch {
    /* best-effort */
  }
}

export async function setGauge(name: string, value: number, labels: Labels = {}): Promise<void> {
  try {
    await redis.hset(GAUGES_KEY, field(name, labels), String(value));
  } catch {
    /* best-effort */
  }
}

/** Prometheus label values may not carry a raw `\`, `"` or newline. */
function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatSeries(name: string, labels: Labels, value: string | number): string {
  const keys = Object.keys(labels).sort();
  const rendered = keys.length
    ? `{${keys.map((k) => `${k}="${escapeLabelValue(labels[k]!)}"`).join(',')}}`
    : '';
  return `${name}${rendered} ${value}`;
}

const HELP: Record<string, [type: string, help: string]> = {
  ns_sms_send_total: ['counter', 'SMS sends attempted, by provider and outcome.'],
  ns_sms_provider_error_total: ['counter', 'SMS provider error responses, by provider and code.'],
  ns_job_dlq_total: ['counter', 'Jobs dead-lettered, by channel and reason.'],
  ns_job_expired_total: ['counter', 'Jobs that passed their deadline and were never sent, by channel.'],
  ns_job_dropped_total: [
    'counter',
    'Redacted (OTP) jobs that failed and were deliberately not dead-lettered, by channel and reason.',
  ],
  ns_rate_limited_total: ['counter', 'Sends deferred because no vendor token was available, by channel and priority.'],
  ns_send_rejected_total: ['counter', 'POST /v1/notify sends refused at planning, by kind and code.'],
  ns_send_fallthrough_total: [
    'counter',
    'first_available sends that moved to their next channel after a delivery failed, by from and to channel.',
  ],
  ns_audit_write_failures_total: [
    'counter',
    'Best-effort audit status writes that failed, by stage (the status being written).',
  ],
  ns_recovery_abandoned_total: [
    'counter',
    'Open recoverable attempts older than RECOVERY_MAX_AGE_HOURS marked failed by recovery instead of re-sent.',
  ],
  ns_partition_default_rows: [
    'gauge',
    '1 when a partitioned table\'s default partition is non-empty, 0 otherwise, by parent. Non-empty blocks partition pre-making for that range.',
  ],
  ns_provider_balance: ['gauge', 'Provider account balance, where the provider exposes one.'],
  ns_provider_balance_updated_at: [
    'gauge',
    'Unix time of the last successful balance poll. Alert on staleness: without it a broken poller reports a healthy balance forever.',
  ],
  ns_provider_balance_poll_failures_total: [
    'counter',
    'Balance polls that failed, by provider and reason.',
  ],
  ns_content_load_failures_total: [
    'counter',
    'Content loads (boot or reload) that failed, by provider. The last good content keeps being served.',
  ],
  ns_content_loaded: [
    'gauge',
    'Unix time of the latest successful load of this content (version, fingerprint = first 12 hex of the file sha256), by provider. Alert on staleness.',
  ],
  ns_queue_depth: ['gauge', 'Jobs currently in each queue.'],
  ns_retry_eta_seconds: ['gauge', 'Seconds until the oldest scheduled retry is due.'],
};

function block(name: string, lines: string[]): string[] {
  const meta = HELP[name];
  if (!meta) return lines;
  return [`# HELP ${name} ${meta[1]}`, `# TYPE ${name} ${meta[0]}`, ...lines];
}

/**
 * Render the Prometheus text exposition. Groups series by metric name so each
 * name carries exactly one HELP/TYPE pair, which the parser requires.
 */
export async function renderPrometheus(
  // Values arrive as `unknown` from the queue's MULTI pipeline; each is narrowed
  // at the point of use, so a shape change cannot emit a NaN series.
  queue: Record<string, unknown>
): Promise<string> {
  // Not caught: serving 200 without the counters looks like a healthy service
  // with no traffic, so no alert could fire. A failed scrape surfaces as `up == 0`.
  const [counters, gauges] = await Promise.all([
    redis.hgetall(COUNTERS_KEY),
    redis.hgetall(GAUGES_KEY),
  ]);

  const byName = new Map<string, string[]>();
  const push = (name: string, line: string) => {
    const existing = byName.get(name);
    if (existing) existing.push(line);
    else byName.set(name, [line]);
  };

  for (const [raw, value] of Object.entries({ ...counters, ...gauges })) {
    const { name, labels } = parseField(raw);
    push(name, formatSeries(name, labels, value));
  }

  // Queue depths are read live, so a scrape always reflects the real backlog.
  for (const q of ['realtime', 'other', 'bulk', 'retry_count', 'dlq'] as const) {
    const value = queue[q];
    if (typeof value === 'number') {
      push('ns_queue_depth', formatSeries('ns_queue_depth', { queue: q }, value));
    }
  }
  if (typeof queue.retry_eta_seconds === 'number') {
    push('ns_retry_eta_seconds', formatSeries('ns_retry_eta_seconds', {}, queue.retry_eta_seconds));
  }

  const out: string[] = [];
  for (const [name, lines] of [...byName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out.push(...block(name, lines));
  }
  return out.join('\n') + '\n';
}
