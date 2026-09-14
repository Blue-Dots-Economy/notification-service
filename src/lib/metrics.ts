import redis from './redis';

/**
 * Prometheus counters for the send path.
 *
 * These live in Redis rather than in process memory because the worker that
 * performs every send runs in a SEPARATE process from the API server that
 * serves `/metrics` (see `src/server.ts`). An in-process registry — prom-client
 * or hand-rolled — would expose an API process that has sent nothing, and the
 * counters that matter would be invisible. Redis is already the shared state
 * for everything else here, so it is the natural place.
 *
 * Counters only. Queue depths are read live from `getQueueMetrics()` at scrape
 * time, so they are never stale, and `setGauge` covers the one value nothing
 * else observes (provider balance).
 */

const COUNTERS_KEY = 'metrics:counters';
const GAUGES_KEY = 'metrics:gauges';

export type Labels = Record<string, string>;

/** `name|k=v,k=v` — label keys sorted so one series has exactly one field. */
function field(name: string, labels: Labels): string {
  const pairs = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
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
 * Metrics must never be able to fail a send. Every write is best-effort: a
 * Redis hiccup while recording that an SMS went out must not turn a delivered
 * message into a retry.
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
  ns_provider_balance: ['gauge', 'Provider account balance, where the provider exposes one.'],
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
  const [counters, gauges] = await Promise.all([
    redis.hgetall(COUNTERS_KEY).catch(() => ({}) as Record<string, string>),
    redis.hgetall(GAUGES_KEY).catch(() => ({}) as Record<string, string>),
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
  for (const q of ['realtime', 'other', 'retry_count', 'dlq'] as const) {
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
