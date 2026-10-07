import { createHash } from 'node:crypto';
import * as metrics from '../metrics';
import { TemplateError } from '../templates/errors';
import { configmapProvider } from './configmap';
import type { ContentProvider, ContentRef, ContentSnapshot } from './types';

export interface ContentConfig {
  provider: 'configmap';
  file: string;
  reloadMs: number;
}

/**
 * Content is off (every content_ref is unavailable) unless NS_CONTENT_FILE is set.
 * The other settings are validated either way: validateBootConfig calls this,
 * so an invalid NS_CONTENT_PROVIDER or NS_CONTENT_RELOAD_MS fails boot like any
 * other config error. A missing or broken content file never does.
 */
export function contentConfig(env: NodeJS.ProcessEnv = process.env): ContentConfig | null {
  const file = env.NS_CONTENT_FILE?.trim();
  const provider = (env.NS_CONTENT_PROVIDER?.trim() || 'configmap').toLowerCase();
  if (provider !== 'configmap') throw new Error(`NS_CONTENT_PROVIDER must be configmap, got "${provider}"`);
  const raw = env.NS_CONTENT_RELOAD_MS?.trim();
  const reloadMs = raw === undefined || raw === '' ? 30_000 : Number(raw);
  if (!Number.isInteger(reloadMs) || reloadMs < 1 || reloadMs > 3_600_000) {
    throw new Error('NS_CONTENT_RELOAD_MS must be an integer from 1 to 3600000');
  }
  if (!file) return null;
  return { provider: 'configmap', file, reloadMs };
}

let active: ContentSnapshot | null = null;
let memo = new Map<string, { value: string; ref: ContentRef }>();
let timer: NodeJS.Timeout | undefined;

function install(next: ContentSnapshot | null): void {
  // Every successful load drops the memo: an edit that keeps the version string
  // must not leave stale values cached until restart.
  if (
    next &&
    active &&
    next.version === active.version &&
    next.fingerprint !== undefined &&
    active.fingerprint !== undefined &&
    next.fingerprint !== active.fingerprint
  ) {
    console.warn(`content version ${next.version} was reloaded with different content; bump the version on edits`);
  }
  memo = new Map();
  active = next;
}

export function currentContent(): ContentSnapshot | null {
  return active;
}

/** Test seam. */
export function setContentForTests(snapshot: ContentSnapshot | null): void {
  memo = new Map();
  active = snapshot;
}

/** First 12 hex of a sha256: short enough for a label or audit ref, long enough to tell edits apart. */
export function shortFingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/**
 * Best-effort, never awaited on the load path. `ns_content_loaded` is the unix
 * time of the latest successful load of that exact content by any pod: the
 * series still advancing is what is being served; one that stops advancing is
 * content no pod loads any more.
 */
function recordLoaded(provider: string, snap: ContentSnapshot): void {
  void metrics.setGauge('ns_content_loaded', Math.floor(Date.now() / 1000), {
    provider,
    version: snap.version,
    fingerprint: snap.fingerprint ? snap.fingerprint.slice(0, 12) : 'none',
  });
}

let loading = false;
// Bumped by stopContent. A load started under an older generation neither
// installs its snapshot nor touches the current run's `loading` flag.
let generation = 0;

async function loadOnce(provider: ContentProvider, gen: number): Promise<void> {
  if (loading) return; // a slow load must not overlap the next tick
  loading = true;
  try {
    const next = await provider.load();
    if (gen === generation) {
      install(next);
      recordLoaded(provider.name, next);
    }
  } catch (err) {
    // Keep the last good snapshot. The message names the problem, never content.
    if (gen === generation) {
      void metrics.incr('ns_content_load_failures_total', { provider: provider.name });
      console.error(`content (${provider.name}) not loaded; keeping version ${active?.version ?? 'none'}: ${(err as Error).message}`);
    }
  } finally {
    if (gen === generation) loading = false;
  }
}

/**
 * First load, then reload every NS_CONTENT_RELOAD_MS. Never throws: a broken
 * content file must not stop the service or affect sends that use no content.
 * Invalid settings are rejected by validateBootConfig; here they only leave
 * content off.
 */
export async function startContent(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  stopContent();
  let cfg: ContentConfig | null;
  try {
    cfg = contentConfig(env);
  } catch (err) {
    console.error(`content not started: ${(err as Error).message}`);
    return;
  }
  if (!cfg) return;
  await startWithProvider(configmapProvider(cfg.file), cfg.reloadMs);
}

/** Internal seam: the load-then-reload loop for any provider. */
export async function startWithProvider(provider: ContentProvider, reloadMs: number): Promise<void> {
  stopContent();
  const gen = generation;
  await loadOnce(provider, gen);
  if (gen !== generation) return; // stopped or restarted during the first load
  timer = setInterval(() => void loadOnce(provider, gen), reloadMs);
  timer.unref();
}

export function stopContent(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  generation++;
  loading = false;
}

/**
 * The value for `key` in the first locale of `locales` that has one, memoised
 * per (key, locale, version) and dropped on every reload. The ref carries a
 * fingerprint of the value, so it pins the exact text even when an edit kept
 * the version. Every failure is a configuration error: a send
 * never goes out with a blank or stale-missing reference.
 */
export function resolveContent(key: string, locales: string[]): { value: string; ref: ContentRef } {
  const snap = active;
  if (!snap) throw new TemplateError('content_unavailable', 'no content is loaded', { key });
  if (!snap.keys.has(key)) throw new TemplateError('unknown_content_key', `content key ${key} is not defined`, { key });
  for (const locale of locales) {
    const id = `${snap.version}\u0000${key}\u0000${locale}`;
    const hit = memo.get(id);
    if (hit) return hit;
    const value = snap.get(key, locale);
    if (value !== undefined) {
      const out = { value, ref: { key, version: snap.version, locale, fingerprint: shortFingerprint(value) } };
      memo.set(id, out);
      return out;
    }
  }
  throw new TemplateError('content_unresolved', `content key ${key} has no value for locales ${locales.join(', ')}`, {
    key,
    locales,
  });
}
