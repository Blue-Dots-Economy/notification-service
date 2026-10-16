import type { PolicyRow, TemplateRow } from '../db/schema';
import { describeDbError } from '../db/errors';
import { currentNetwork } from '../network';
import { resolvePolicy } from '../policies/repo';
import { TemplateError } from '../templates/errors';
import { resolveTemplate } from '../templates/repo';
import { StoreUnavailable } from './errors';

/**
 * In-process stale-while-revalidate cache in front of resolveTemplate and
 * resolvePolicy, so a send for a known template or policy never waits on
 * Postgres.
 *
 * - Only positive results are cached. A missing policy or a TemplateError
 *   (not_found, vendor_mismatch, ...) always re-queries.
 * - A cached entry is returned immediately. Once it is older than the TTL
 *   (`NS_RESOLVE_CACHE_TTL_MS`, default 60 s) one background refresh per key
 *   runs. A refresh that fails on the database keeps the stale entry; a refresh
 *   that finds nothing active drops it.
 * - A cold miss queries the database; if that query fails the caller gets
 *   `StoreUnavailable` (the route answers 503).
 * - Bounded to MAX_ENTRIES keys; the oldest insertion is dropped first.
 * - Admin publish/retire in this process clears the cache; other pods converge
 *   within the TTL.
 */

const DEFAULT_TTL_MS = 60_000;
export const MAX_ENTRIES = 1000;

export function resolveCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.NS_RESOLVE_CACHE_TTL_MS;
  if (raw === undefined || raw === '') return DEFAULT_TTL_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`NS_RESOLVE_CACHE_TTL_MS must be a positive integer, got '${raw}'`);
  return n;
}

interface Entry {
  value: unknown;
  storedAt: number;
}

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
// Bumped by clearResolveCache so a refresh that started before a clear never
// writes its (possibly pre-publish) result back.
let generation = 0;

export function clearResolveCache(): void {
  entries.clear();
  inflight.clear();
  generation += 1;
}

function store(key: string, value: unknown, now: number): void {
  entries.delete(key);
  entries.set(key, { value, storedAt: now });
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

/**
 * Single-flight load for `key`. Resolves to the fresh value, or `null` when the
 * resolver found nothing active; the entry is updated accordingly. Database
 * errors reject.
 */
function load<T>(key: string, query: () => Promise<T | null>): Promise<T | null> {
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T | null>;
  const gen = generation;
  const p: Promise<T | null> = Promise.resolve()
    .then(query)
    .then(
      (value) => {
        if (gen === generation) {
          if (value === null) entries.delete(key);
          else store(key, value, Date.now());
        }
        return value;
      },
      (err: unknown) => {
        if (err instanceof TemplateError && gen === generation) entries.delete(key);
        throw err;
      },
    )
    .finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

async function cached<T>(key: string, query: () => Promise<T | null>): Promise<T | null> {
  const hit = entries.get(key);
  if (hit) {
    if (Date.now() - hit.storedAt >= resolveCacheTtlMs()) {
      load(key, query).catch((err) => {
        if (err instanceof TemplateError) return;
        console.error(`resolver cache refresh failed; serving the cached entry: ${describeDbError(err)}`);
      });
    }
    return hit.value as T;
  }
  try {
    return await load(key, query);
  } catch (err) {
    if (err instanceof TemplateError) throw err;
    console.error(`resolver lookup failed with nothing cached: ${describeDbError(err)}`);
    throw new StoreUnavailable();
  }
}

const k = (...parts: (string | undefined)[]) => JSON.stringify(parts.map((p) => p ?? null));

export async function cachedResolveTemplate(
  channel: string,
  templateKey: string,
  locale?: string,
): Promise<{ template: TemplateRow; renders: 'ns' | 'provider' }> {
  const key = k('template', currentNetwork(), channel, templateKey, locale);
  return (await cached(key, () => resolveTemplate(channel, templateKey, locale)))!;
}

export async function cachedResolvePolicy(domain: string | undefined, eventType: string | undefined): Promise<PolicyRow | null> {
  const key = k('policy', currentNetwork(), domain, eventType);
  return cached(key, () => resolvePolicy(domain, eventType));
}

/** Test hook: number of cached keys. */
export function resolveCacheSize(): number {
  return entries.size;
}
