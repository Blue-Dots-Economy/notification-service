import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { CONTENT_KEY } from '../templates/contract';
import type { ContentProvider, ContentSnapshot } from './types';

const LOCALE = /^[a-z]{2,3}(-[A-Z]{2})?$/;
const Value = z.string().min(1).max(2000).refine((v) => v.trim() !== '', 'blank value');

const ContentDocument = z
  .object({
    version: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    entries: z.record(z.string(), z.record(z.string(), Value)),
  })
  .strict();

/**
 * Validate a content document into a snapshot. Errors name the failing path
 * (key and locale), never a value: content can be long and is not log data.
 */
const MAX_ENTRIES = 500;
const MAX_FILE_BYTES = 1_048_576;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Key and locale rules, run on the raw input: zod's record drops an own
 * `__proto__` key before any later check could see it. Messages never carry
 * key text or values.
 */
function checkRawShape(raw: unknown): void {
  if (!isPlainObject(raw) || !isPlainObject(raw.entries)) return; // zod reports the shape
  const keys = Object.keys(raw.entries);
  if (keys.length > MAX_ENTRIES) throw new Error('content document is invalid at: entries (more than 500 keys)');
  for (const key of keys) {
    if (!CONTENT_KEY.test(key)) throw new Error('content document is invalid at: entries (a key is malformed)');
    const byLocale = raw.entries[key];
    if (!isPlainObject(byLocale)) continue;
    for (const locale of Object.keys(byLocale)) {
      if (!LOCALE.test(locale)) throw new Error('content document is invalid at: entries (a locale code is malformed)');
    }
  }
}

export function parseContentDocument(raw: unknown): ContentSnapshot {
  checkRawShape(raw);
  const parsed = ContentDocument.safeParse(raw);
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
    throw new Error(`content document is invalid at: ${where}`);
  }
  const { version, entries } = parsed.data;
  const table = new Map<string, Map<string, string>>(
    Object.entries(entries).map(([k, byLocale]) => [k, new Map(Object.entries(byLocale))]),
  );
  return {
    version,
    keys: new Set(table.keys()),
    get: (key, locale) => table.get(key)?.get(locale),
  };
}

/** Reads one dedicated, mounted JSON file: never env, secrets or other config. */
export function configmapProvider(file: string): ContentProvider {
  return {
    name: 'configmap',
    async load() {
      const { size } = await fs.stat(file);
      if (size > MAX_FILE_BYTES) throw new Error(`content file is too large (${size} bytes, limit ${MAX_FILE_BYTES})`);
      const text = await fs.readFile(file, 'utf8');
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new Error('content file is not valid JSON');
      }
      const fingerprint = createHash('sha256').update(text).digest('hex');
      return { ...parseContentDocument(raw), fingerprint };
    },
  };
}
