# NS Stage 1 Plan E — Content Resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a template variable take its value from shared, versioned content, such as a T&C link (`tnc.in_force.url`) or statement (`tnc.on_offer.text`), resolved per locale from an operator-controlled file. An unresolved reference fails the send instead of rendering empty.

**Architecture:**
- **Variable source.** A variable spec gains `source: 'content_ref'` and a `contentKey`.
- **Provider and snapshot.** A pluggable `ContentProvider` loads a validated, versioned snapshot. The `configmap` provider reads a mounted JSON file and reloads it when it changes, keeping the last good snapshot on any error. Lookups are memoised per `(key, locale, version)`.
- **When content resolves.** Content is resolved in the planning step, before a send is accepted. Content values are validated against the variable's type (URL scheme and host rules apply) and merged into the render input. A caller can never supply or override them.
- **Allowlist.** The set of keys in the loaded snapshot is the only thing a template can reference. Publish checks every referenced key, and so does every send.

**Tech Stack:** Fastify 5, TypeScript 7 (CommonJS, `module`/`moduleResolution: Node16`), Zod 4, Drizzle (no schema migration: the contract is jsonb), vitest 4, pnpm 10. Helm in bluedots-automation.

**Spec:** `docs/superpowers/specs/2026-06-26-event-platform-design.md` (rev 2026-10-04), §Consent boundary and §Security ("The content resolver"). Issue: notification-service#59.

## Global Constraints

- **Declaration.** A template variable declares `source: content_ref` with a key such as `tnc.in_force.url` or `tnc.on_offer.text`, resolved per locale by a **pluggable provider**. The provider is `configmap` today, from a mounted file; `db` and `http` come later, as a configuration change rather than a rewrite.
- **`in_force` vs `on_offer` is part of the key.** A re-consent broadcast needs the offered version; an acceptance receipt needs the in-force one. NS does not interpret the key segments.
- **Cache keyed by `(key, locale, version)`.**
- **`content_ref` keys resolve against an allowlist.** The allowlist is the set of keys in the loaded content snapshot, and keys must match `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,7}$`. The provider reads only its dedicated content file, never environment variables, secrets or other config.
- **Resolution failure fails the send.** A missing key, a missing locale, an unavailable provider or an invalid content value refuses the send with a **configuration** error (`422`). It never renders empty.
- **Callers cannot supply or override content.** A request naming a `content_ref` variable is `422 unknown_variable` (a caller error).
- **Contract rules for `content_ref` variables.** They are always required. They cannot be `sensitive`, because shared public content has nothing to redact. They may be `raw`, under the same email-only rule as other variables.
- **Content values.** Each value is a non-empty string of at most 2000 characters. A value for a `url` variable passes the same checks as a caller URL: http(s), no userinfo, and `urlHosts` when declared.
- **Locale.** The locale chain is the **resolved template's** locale, then its language, then `NS_DEFAULT_LOCALE`.
- **NS enforces nothing about consent.** It only renders the content.
- **Hot-path isolation.** A broken or missing content file must never affect sends that use no `content_ref` variable, including OTPs. The process never fails to boot because of the content file.
- Plans A–D global constraints still apply:
  - CommonJS, with extensionless imports in `src/lib`.
  - Log database errors through `describeDbError`.
  - Never log or persist variable values for redacted sends.
  - Public-repo wording: no vulnerability narratives in code, docs, commits or PR text.
  - Never run `vitest --root /`.
  - End every commit with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Branches.** notification-service uses `feat/ns-content-resolver` off `feat/ns-service-auth` (PR #151). bluedots-automation uses `feat/ns-content-resolver` off `feat/ns-service-auth` (PR #262). Nothing is pushed without explicit approval.

### Rulings made while writing this plan (review these)

- **E1 — the content file's own keys are the allowlist.** There is no second list of permitted prefixes.
  - The keyspace is already confined in three ways. The file is dedicated and operator-controlled, it holds only content, and keys come from template contracts, which only `templates:admin` can write, never from requests.
  - A second allowlist would double the places an operator must edit to publish a T&C link.
- **E2 — content resolves at plan time (accept), not in the worker.** Every send is already rendered before it is accepted (Plan C2). This makes resolution failure a synchronous `422` the caller sees. A queued message also carries the T&C version that was current when the request was accepted.
- **E3 — the event payload records `content_refs: [{ key, version, locale }]`.** These are references, not values, and are recorded for redacted sends too. This lets an audit answer "which T&C version did this message carry".
- **E4 — an invalid or unreadable content file never stops the boot.**
  - The provider logs the error (no values) and stays *unavailable* until a valid file appears, while `content_ref` sends answer `422 content_unavailable`.
  - On reload, a bad file keeps the last good snapshot.
  - OTP and every other send are unaffected.

## Review Focus

1. **A live edit to the content ConfigMap leaves invalid JSON.** Sends keep using the last good version, nothing crashes, and the log names the problem without content values. → Task 2 test "a bad reload keeps the last good snapshot".
2. **A key exists, but not for the template's locale or the default locale.** The send gets `422 content_unresolved`; it is never rendered with an empty link. → Task 2 test "missing locale throws" and Task 3 plan test "unresolved content refuses the send".
3. **A caller passes a variable named like the content variable**, to replace the T&C link. The response is `422 unknown_variable`, and the content value is what gets rendered. → Task 3 test "caller cannot override content".
4. **A content URL is not http(s), or its host is not in the variable's `urlHosts`.** This is a configuration error (`invalid_content`), not a caller error, and the message names the key, never the value. → Task 3 test "invalid content value is a configuration error".
5. **A published template's key is later removed from the file.** Sends fail `422 unknown_content_key`. Publishing a template that references an absent key fails, and publishing with no content file configured fails with `content_unavailable`. → Task 3 publish tests and plan test.

---

## File Structure

**notification-service** (worktree `.worktrees/ns-plan-e/notification-service`, branch `feat/ns-content-resolver`):

| File | Responsibility |
|---|---|
| `src/lib/db/schema.ts` | `VariableSpec` gains `source?`, `contentKey?` |
| `src/lib/templates/contract.ts` | Contract schema rules for `content_ref`; `CONTENT_KEY` grammar; `callerVariables()` |
| `src/lib/templates/errors.ts` | New codes `unknown_content_key`, `content_unavailable`, `content_unresolved`, `invalid_content` |
| `src/lib/content/types.ts` (new) | `ContentProvider`, `ContentSnapshot`, `ContentRef` |
| `src/lib/content/configmap.ts` (new) | File provider: parse and validate a snapshot from JSON |
| `src/lib/content/resolver.ts` (new) | Active snapshot, reload loop, memoised `resolveContent`, `contentConfig`, test seam |
| `src/lib/content/inject.ts` (new) | `withContent(template, input)`: resolve, validate and merge content values; refs |
| `src/lib/templates/validate.ts` | Publish checks `content_ref` keys against the snapshot |
| `src/lib/send/plan.ts`, `src/routes/admin-templates.ts` (preview), `src/routes/v1-notify.ts`, `src/lib/audit/{store,redact}.ts` | Wire content into planning, preview and audit |
| `src/server.ts`, `src/lib/boot-config.ts` | Start the provider at boot (API process only); validate env |
| `src/lib/utils/openapi.ts`, `CLAUDE.md`, `README.md`, `example.env` | Docs |

**bluedots-automation** (worktree `.worktrees/ns-plan-e/bluedots-automation`, branch `feat/ns-content-resolver`): the NS chart gets an optional content ConfigMap, mounted as a **directory** (not `subPath`, which never receives updates), and `NS_CONTENT_FILE` when content is set.

---

### Task 1: The content variable model

**Files:**
- Modify:
  - `src/lib/db/schema.ts` (`VariableSpec`)
  - `src/lib/templates/contract.ts`
  - `src/lib/templates/errors.ts`
  - `src/lib/send/errors.ts`: classification only; the new codes are configuration errors by default
- Test: `src/lib/templates/__tests__/contract.test.ts` (extend)

**Interfaces:**
- Produces:
  - `VariableSpec` gains `source?: 'request' | 'content_ref'` and `contentKey?: string`. Absent `source` means `'request'`, so existing rows are unchanged.
  - `CONTENT_KEY: RegExp`
  - `isContentVariable(s: VariableSpec): boolean`
  - `callerVariables(contract: VariableSpec[]): VariableSpec[]`, the specs a request may supply
  - `TemplateErrorCode` adds `'unknown_content_key' | 'content_unavailable' | 'content_unresolved' | 'invalid_content'`

- [ ] **Step 1: Write the failing tests.** Append the following to `src/lib/templates/__tests__/contract.test.ts`:

```ts
import { CONTENT_KEY, callerVariables, isContentVariable, VariableContractSchema } from '../contract';

describe('content_ref variables', () => {
  const ok = { name: 'tnc_url', type: 'url', source: 'content_ref', contentKey: 'tnc.in_force.url' };

  it('accepts a content_ref spec and forces required', () => {
    const [s] = VariableContractSchema.parse([{ ...ok, required: false }]);
    expect(s).toMatchObject({ source: 'content_ref', contentKey: 'tnc.in_force.url', required: true });
  });

  it('defaults source to request', () => {
    const [s] = VariableContractSchema.parse([{ name: 'name' }]);
    expect(s.source).toBe('request');
    expect(isContentVariable(s)).toBe(false);
  });

  it.each([
    [{ ...ok, contentKey: undefined }, 'contentKey'],
    [{ name: 'x', contentKey: 'tnc.in_force.url' }, 'contentKey'],
    [{ ...ok, sensitive: true }, 'sensitive'],
    [{ ...ok, contentKey: 'TNC.url' }, 'contentKey'],
    [{ ...ok, contentKey: 'tnc' }, 'contentKey'],
    [{ ...ok, contentKey: 'tnc..url' }, 'contentKey'],
    [{ ...ok, contentKey: '__proto__.x' }, 'contentKey'],
  ])('rejects %j', (spec, path) => {
    const r = VariableContractSchema.safeParse([spec]);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain(path);
  });

  it('callerVariables excludes content variables', () => {
    const c = VariableContractSchema.parse([{ name: 'name' }, ok]);
    expect(callerVariables(c).map((s) => s.name)).toEqual(['name']);
  });

  it.each(['tnc.in_force.url', 'tnc.on_offer.text', 'a.b', 'a1.b_2.c'])('key grammar accepts %s', (k) => expect(CONTENT_KEY.test(k)).toBe(true));
  it.each(['tnc', '.tnc.url', 'tnc.url.', 'Tnc.url', 'tnc.1url', 'a.b.c.d.e.f.g.h.i'])('key grammar rejects %s', (k) => expect(CONTENT_KEY.test(k)).toBe(false));
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**
Run: `pnpm vitest run src/lib/templates/__tests__/contract.test.ts`
Expected: FAIL, with the exports not found.

- [ ] **Step 3: Implement.**

In `src/lib/db/schema.ts`, `VariableSpec`, add:

```ts
  /** `content_ref`: the value comes from the content resolver, never the caller. Absent = `request`. */
  source?: 'request' | 'content_ref';
  /** content_ref only: the content key, e.g. `tnc.in_force.url`. */
  contentKey?: string;
```

In `src/lib/templates/contract.ts`:
- Export `CONTENT_KEY`.
- Extend `VariableSpecSchema` with `source: z.enum(['request', 'content_ref']).default('request')` and `contentKey: z.string().max(128).optional()`.
- Add the refinements below, after the existing ones.
- Add a `.transform` that forces `required: true` for content variables.
- Add the helpers.

```ts
/** `<segment>(.<segment>){1,7}`, lowercase; e.g. `tnc.in_force.url`. */
export const CONTENT_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,7}$/;
```

```ts
  .refine((s) => (s.source === 'content_ref') === (s.contentKey !== undefined), {
    message: 'contentKey is required for, and only for, content_ref variables',
    path: ['contentKey'],
  })
  .refine((s) => s.contentKey === undefined || CONTENT_KEY.test(s.contentKey), {
    message: 'contentKey must be dotted lowercase segments, e.g. tnc.in_force.url',
    path: ['contentKey'],
  })
  .refine((s) => !(s.source === 'content_ref' && s.sensitive), {
    message: 'content_ref variables hold shared content and cannot be sensitive',
    path: ['sensitive'],
  })
  .transform((s) => (s.source === 'content_ref' ? { ...s, required: true } : s));
```

```ts
export function isContentVariable(s: VariableSpec): boolean {
  return s.source === 'content_ref';
}

/** The variables a request may supply: everything except content_ref variables. */
export function callerVariables(contract: VariableSpec[]): VariableSpec[] {
  return contract.filter((s) => !isContentVariable(s));
}
```

The `__proto__.x` case is rejected by the grammar, because `_` cannot start a segment. Keep the existing `name in Object.prototype` refinement.

In `src/lib/templates/errors.ts`, add the four codes to `TemplateErrorCode`. In `src/lib/send/errors.ts`, confirm `CALLER` does not include them, so they classify as `configuration`. Add a one-line test in `src/lib/send/__tests__/` (plan or errors test) asserting `classify('content_unresolved') === 'configuration'`, and the same for the other three codes.

- [ ] **Step 4: Run the tests.**
Run: `pnpm vitest run src/lib/templates src/lib/send` then `pnpm build`
Expected: PASS and a clean build. Existing contract tests still pass, because `source` defaults to `request`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/schema.ts src/lib/templates src/lib/send
git commit -m "feat(templates): content_ref variables in the template contract

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The content provider and resolver

**Files:**
- Create: `src/lib/content/types.ts`, `src/lib/content/configmap.ts`, `src/lib/content/resolver.ts`
- Test: `src/lib/content/__tests__/configmap.test.ts`, `src/lib/content/__tests__/resolver.test.ts`
- Modify: `src/lib/boot-config.ts`, `src/server.ts`

**Interfaces:**
- Consumes: `CONTENT_KEY` (Task 1), `defaultLocale()` (`src/lib/network.ts`), and `TemplateError`.
- Produces:
  - `interface ContentSnapshot { version: string; keys: ReadonlySet<string>; get(key: string, locale: string): string | undefined }`
  - `interface ContentProvider { name: string; load(): Promise<ContentSnapshot> }`
  - `interface ContentRef { key: string; version: string; locale: string }`
  - `parseContentDocument(raw: unknown): ContentSnapshot` (throws `Error` with a message naming the problem, never a value)
  - `configmapProvider(file: string): ContentProvider`
  - `contentConfig(env?): { provider: 'configmap'; file: string; reloadMs: number } | null`
  - `startContent(env?): Promise<void>`: the first load plus the reload timer, `.unref()`. It never throws.
  - `stopContent(): void`
  - `currentContent(): ContentSnapshot | null`
  - `resolveContent(key: string, locales: string[]): { value: string; ref: ContentRef }`. It throws `TemplateError` with `content_unavailable`, `unknown_content_key` or `content_unresolved`.
  - Test seam: `setContentForTests(snapshot: ContentSnapshot | null): void`

**Content file format** (`NS_CONTENT_FILE`):

```json
{
  "version": "2026-09-01",
  "entries": {
    "tnc.in_force.url": { "en": "https://example.org/tnc/v3", "hi": "https://example.org/hi/tnc/v3" },
    "tnc.on_offer.text": { "en": "Our terms change on 1 October." }
  }
}
```

The rules:
- `version` is 1–64 characters of `[A-Za-z0-9._-]`.
- `entries` holds at most 500 keys, each matching `CONTENT_KEY`.
- Each locale code matches `^[a-z]{2,3}(-[A-Z]{2})?$`.
- Each value is a non-empty string of at most 2000 characters, not whitespace-only.
- Unknown top-level fields are rejected.

Environment:
- `NS_CONTENT_PROVIDER` defaults to `configmap`, the only accepted value. Any other value fails `validateBootConfig`.
- `NS_CONTENT_FILE` is the path. When unset, content is off, so every `content_ref` resolution answers `content_unavailable`.
- `NS_CONTENT_RELOAD_MS` defaults to 30000 and must be a positive integer, validated at boot.

- [ ] **Step 1: Write the failing tests**

`src/lib/content/__tests__/configmap.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { configmapProvider, parseContentDocument } from '../configmap';

const doc = {
  version: '2026-09-01',
  entries: { 'tnc.in_force.url': { en: 'https://example.org/tnc/v3', hi: 'https://example.org/hi/tnc/v3' } },
};

describe('parseContentDocument', () => {
  it('builds a snapshot', () => {
    const s = parseContentDocument(doc);
    expect(s.version).toBe('2026-09-01');
    expect([...s.keys]).toEqual(['tnc.in_force.url']);
    expect(s.get('tnc.in_force.url', 'hi')).toBe('https://example.org/hi/tnc/v3');
    expect(s.get('tnc.in_force.url', 'ta')).toBeUndefined();
    expect(s.get('constructor', 'en')).toBeUndefined();
  });

  it.each([
    [{ ...doc, version: '' }],
    [{ ...doc, version: 'a b' }],
    [{ version: 'v', entries: { TNC: { en: 'x' } } }],
    [{ version: 'v', entries: { 'tnc.url': { english: 'x' } } }],
    [{ version: 'v', entries: { 'tnc.url': { en: '' } } }],
    [{ version: 'v', entries: { 'tnc.url': { en: '   ' } } }],
    [{ version: 'v', entries: { 'tnc.url': { en: 'x'.repeat(2001) } } }],
    [{ version: 'v', entries: {}, extra: 1 }],
    [[]],
    [null],
  ])('rejects %j without echoing values', (raw) => {
    expect(() => parseContentDocument(raw)).toThrow();
    try { parseContentDocument(raw); } catch (e) { expect(String((e as Error).message)).not.toContain('xxxxxxxxxx'); }
  });
});

describe('configmapProvider', () => {
  it('loads the file', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ns-content-')), 'content.json');
    fs.writeFileSync(file, JSON.stringify(doc));
    expect((await configmapProvider(file).load()).version).toBe('2026-09-01');
  });

  it('fails on unreadable or non-JSON files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-content-'));
    await expect(configmapProvider(path.join(dir, 'missing.json')).load()).rejects.toThrow();
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json');
    await expect(configmapProvider(path.join(dir, 'bad.json')).load()).rejects.toThrow();
  });
});
```

`src/lib/content/__tests__/resolver.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseContentDocument } from '../configmap';
import { contentConfig, currentContent, resolveContent, setContentForTests, startContent, stopContent } from '../resolver';

const snap = (version: string, url = 'https://example.org/tnc') =>
  parseContentDocument({ version, entries: { 'tnc.in_force.url': { en: url, 'hi-IN': 'https://example.org/hi' } } });

afterEach(() => { stopContent(); setContentForTests(null); vi.useRealTimers(); });

describe('resolveContent', () => {
  it('walks the locale chain and reports the ref', () => {
    setContentForTests(snap('v1'));
    expect(resolveContent('tnc.in_force.url', ['hi-IN', 'hi', 'en'])).toEqual({
      value: 'https://example.org/hi', ref: { key: 'tnc.in_force.url', version: 'v1', locale: 'hi-IN' },
    });
    expect(resolveContent('tnc.in_force.url', ['ta', 'en']).ref.locale).toBe('en');
  });

  it('throws content_unavailable with no snapshot', () => {
    expect(() => resolveContent('tnc.in_force.url', ['en'])).toThrow(expect.objectContaining({ code: 'content_unavailable' }));
  });

  it('throws unknown_content_key for a key outside the snapshot', () => {
    setContentForTests(snap('v1'));
    expect(() => resolveContent('tnc.on_offer.url', ['en'])).toThrow(expect.objectContaining({ code: 'unknown_content_key' }));
  });

  it('throws content_unresolved when no locale in the chain has a value', () => {
    setContentForTests(snap('v1'));
    expect(() => resolveContent('tnc.in_force.url', ['ta', 'kn'])).toThrow(expect.objectContaining({ code: 'content_unresolved' }));
  });

  it('memoises per (key, locale, version) and drops the memo on a new version', () => {
    const s1 = snap('v1');
    const get = vi.spyOn(s1, 'get');
    setContentForTests(s1);
    resolveContent('tnc.in_force.url', ['en']);
    resolveContent('tnc.in_force.url', ['en']);
    expect(get).toHaveBeenCalledTimes(1);
    setContentForTests(snap('v2', 'https://example.org/tnc/v2'));
    expect(resolveContent('tnc.in_force.url', ['en']).value).toBe('https://example.org/tnc/v2');
  });
});

describe('startContent (configmap reload)', () => {
  // Real timers on purpose: the reload does real file I/O, which fake timers do not wait for.
  it('loads at start, picks up a new version, and keeps the last good snapshot on a bad reload', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ns-content-')), 'content.json');
    fs.writeFileSync(file, JSON.stringify({ version: 'v1', entries: { 'tnc.in_force.url': { en: 'https://a.example/1' } } }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await startContent({ NS_CONTENT_FILE: file, NS_CONTENT_RELOAD_MS: '20' });
    expect(currentContent()?.version).toBe('v1');

    fs.writeFileSync(file, '{ broken');
    await vi.waitFor(() => expect(error).toHaveBeenCalled(), { timeout: 2000 });
    expect(currentContent()?.version).toBe('v1');
    expect(error.mock.calls.flat().join(' ')).not.toContain('https://a.example');

    fs.writeFileSync(file, JSON.stringify({ version: 'v2', entries: { 'tnc.in_force.url': { en: 'https://a.example/2' } } }));
    await vi.waitFor(() => expect(currentContent()?.version).toBe('v2'), { timeout: 2000 });
  });

  it('never throws when the file is missing at start; content stays unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(startContent({ NS_CONTENT_FILE: '/nonexistent/content.json' })).resolves.toBeUndefined();
    expect(currentContent()).toBeNull();
  });
});

describe('contentConfig', () => {
  it('is off without a file', () => expect(contentConfig({})).toBeNull());
  it('defaults provider and reload', () =>
    expect(contentConfig({ NS_CONTENT_FILE: '/x.json' })).toEqual({ provider: 'configmap', file: '/x.json', reloadMs: 30000 }));
  it.each([{ NS_CONTENT_FILE: '/x', NS_CONTENT_PROVIDER: 'db' }, { NS_CONTENT_FILE: '/x', NS_CONTENT_RELOAD_MS: '0' }, { NS_CONTENT_FILE: '/x', NS_CONTENT_RELOAD_MS: 'abc' }])(
    'rejects %j', (env) => expect(() => contentConfig(env)).toThrow(),
  );
});
```

- [ ] **Step 2: Run the tests and confirm they fail.**
Run: `pnpm vitest run src/lib/content`
Expected: FAIL, because the modules don't exist yet.

- [ ] **Step 3: Implement**

`src/lib/content/types.ts`:

```ts
/** A loaded, validated, immutable view of the shared content. */
export interface ContentSnapshot {
  version: string;
  /** The allowlist: the only keys a template may reference. */
  keys: ReadonlySet<string>;
  get(key: string, locale: string): string | undefined;
}

/** Where content comes from. `configmap` today; `db`/`http` later, as configuration. */
export interface ContentProvider {
  name: string;
  load(): Promise<ContentSnapshot>;
}

/** What a send carried: recorded on the event for audit, never the value. */
export interface ContentRef {
  key: string;
  version: string;
  locale: string;
}
```

`src/lib/content/configmap.ts`:

```ts
import fs from 'node:fs/promises';
import { z } from 'zod';
import { CONTENT_KEY } from '../templates/contract';
import type { ContentProvider, ContentSnapshot } from './types';

const LOCALE = /^[a-z]{2,3}(-[A-Z]{2})?$/;
const Value = z.string().min(1).max(2000).refine((v) => v.trim() !== '', 'blank value');

const ContentDocument = z
  .object({
    version: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    entries: z
      .record(z.string().regex(CONTENT_KEY), z.record(z.string().regex(LOCALE), Value))
      .refine((e) => Object.keys(e).length <= 500, 'at most 500 entries'),
  })
  .strict();

/**
 * Validate a content document into a snapshot. Errors name the failing path
 * (key and locale), never a value: content can be long and is not log data.
 */
export function parseContentDocument(raw: unknown): ContentSnapshot {
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

/** Reads one dedicated, mounted JSON file — never env, secrets or other config. */
export function configmapProvider(file: string): ContentProvider {
  return {
    name: 'configmap',
    async load() {
      const text = await fs.readFile(file, 'utf8');
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new Error('content file is not valid JSON');
      }
      return parseContentDocument(raw);
    },
  };
}
```

The zod error path for an entry includes the key and locale (for example `entries.tnc.url.en`). That is fine: keys and locales are not content values. If `z.record` with a key regex reports the offending key text, that is still a key, not a value.

`src/lib/content/resolver.ts`:

```ts
import { TemplateError } from '../templates/errors';
import { configmapProvider } from './configmap';
import type { ContentProvider, ContentRef, ContentSnapshot } from './types';

export interface ContentConfig {
  provider: 'configmap';
  file: string;
  reloadMs: number;
}

/** Content is off (every content_ref is unavailable) unless NS_CONTENT_FILE is set. */
export function contentConfig(env: NodeJS.ProcessEnv = process.env): ContentConfig | null {
  const file = env.NS_CONTENT_FILE?.trim();
  if (!file) return null;
  const provider = (env.NS_CONTENT_PROVIDER?.trim() || 'configmap').toLowerCase();
  if (provider !== 'configmap') throw new Error(`NS_CONTENT_PROVIDER must be configmap, got "${provider}"`);
  const raw = env.NS_CONTENT_RELOAD_MS?.trim();
  const reloadMs = raw === undefined || raw === '' ? 30_000 : Number(raw);
  if (!Number.isInteger(reloadMs) || reloadMs <= 0) throw new Error('NS_CONTENT_RELOAD_MS must be a positive integer');
  return { provider: 'configmap', file, reloadMs };
}

let active: ContentSnapshot | null = null;
let memo = new Map<string, { value: string; ref: ContentRef }>();
let timer: NodeJS.Timeout | undefined;

function install(next: ContentSnapshot | null): void {
  if (next?.version !== active?.version || next === null) memo = new Map();
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

async function loadOnce(provider: ContentProvider): Promise<void> {
  try {
    install(await provider.load());
  } catch (err) {
    // Keep the last good snapshot. The message names the problem, never content.
    console.error(`content (${provider.name}) not loaded; keeping version ${active?.version ?? 'none'}: ${(err as Error).message}`);
  }
}

/**
 * First load, then reload every NS_CONTENT_RELOAD_MS. Never throws: a broken
 * content file must not stop the service or affect sends that use no content.
 */
export async function startContent(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  stopContent();
  const cfg = contentConfig(env);
  if (!cfg) return;
  const provider = configmapProvider(cfg.file);
  await loadOnce(provider);
  timer = setInterval(() => void loadOnce(provider), cfg.reloadMs);
  timer.unref();
}

export function stopContent(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

/**
 * The value for `key` in the first locale of `locales` that has one, memoised
 * per (key, locale, version). Every failure is a configuration error: a send
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
      const out = { value, ref: { key, version: snap.version, locale } };
      memo.set(id, out);
      return out;
    }
  }
  throw new TemplateError('content_unresolved', `content key ${key} has no value for locales ${locales.join(', ')}`, {
    key,
    locales,
  });
}
```

`src/lib/boot-config.ts`: add `contentConfig(env);`.

`src/server.ts`: call `await startContent();` in the API process after `loadSecrets()` and before `listen`. It never throws. Do not start it in the forked worker, which never renders.

- [ ] **Step 4: Run the tests.**
Run: `pnpm vitest run src/lib/content` then `pnpm build` then `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/content src/lib/boot-config.ts src/server.ts
git commit -m "feat(content): configmap content provider with versioned, memoised resolution

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Resolve content at publish, plan, preview and audit

**Files:**
- Create: `src/lib/content/inject.ts`, `src/lib/content/__tests__/inject.test.ts`
- Modify:
  - `src/lib/templates/validate.ts`
  - `src/lib/send/plan.ts`
  - `src/routes/admin-templates.ts` (preview)
  - `src/routes/v1-notify.ts`
  - `src/lib/audit/store.ts` (`AuditIds.contentRefs`)
  - `src/lib/audit/redact.ts`
  - tests: `src/lib/send/__tests__/plan.test.ts`, `src/lib/templates/__tests__/validate.test.ts`, `src/routes/__tests__/admin-templates.test.ts`, `src/routes/__tests__/v1-notify.test.ts`, `src/lib/audit/__tests__/redact.test.ts`

**Interfaces:**
- Consumes: `callerVariables` and `isContentVariable` (Task 1); `resolveContent`, `currentContent` and `ContentRef` (Task 2); `defaultLocale()`.
- Produces:
  - `templateLocaleChain(locale: string): string[]` returns the locale, then its language, then `defaultLocale()`, de-duplicated.
  - `withContent(t: TemplateRow, input: Record<string, unknown>): { input: Record<string, unknown>; refs: ContentRef[] }`. It throws `TemplateError` (configuration codes only) on resolution or content-validation failure, and it never echoes a value.
  - `SendPlan.contentRefs: ContentRef[]`
  - `AuditIds.contentRefs?: ContentRef[]`
  - The event payload carries `content_refs` when non-empty, for both redacted and non-redacted sends.

Behaviour:
- **`withContent`.**
  - For each content variable, it resolves `spec.contentKey` over `templateLocaleChain(t.locale)`.
  - It validates the value through `validateVariables([{ ...spec, source: 'request' }], { [name]: value })`. A `TemplateError` from that is rethrown as `invalid_content` with `{ key, variable }`; the message names the variable and key, never the value.
  - It writes the value into a copy of the input.
  - If the caller's input already holds a content variable's name, it throws `unknown_variable`, a caller error with `{ variables: [name] }`. Normally planning catches this earlier.
- **`planSend`.**
  - The union check uses `callerVariables(...)` names only, so a caller naming a content variable gets `422 unknown_variable`.
  - Each template is rendered with `withContent(r.template, pick(req.variables, own)).input`, where `own` is the template's caller variable names.
  - A content error follows the existing skip-or-fail rule. It is a configuration error: it fails a `single` send, and in `first_available`/`all` it skips the candidate and is remembered.
  - `contentRefs` collects the refs of rendered deliveries only.
- **`validateForPublish`.** For every content variable:
  - no snapshot → `content_unavailable`
  - key not in `snapshot.keys` → `unknown_content_key`
  - Both are thrown before the token checks. `validateForPublish` stays synchronous; it reads `currentContent()`.
- **Preview** renders through `withContent`, so admins see the real content.
- **`v1-notify.ts`** puts `contentRefs: plan.contentRefs` on every job's `audit` when the list is non-empty.
- **`toAcceptedRecord`** adds `content_refs: job.audit.contentRefs` to both payload shapes when present.

- [ ] **Step 1: Write the failing tests**

`src/lib/content/__tests__/inject.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { parseContentDocument } from '../configmap';
import { setContentForTests } from '../resolver';
import { templateLocaleChain, withContent } from '../inject';

const t = (variables: any[], locale = 'hi-IN') => ({ locale, variables }) as any;
const tnc = { name: 'tnc_url', required: true, type: 'url', sensitive: false, raw: false, source: 'content_ref', contentKey: 'tnc.in_force.url', urlHosts: ['example.org'] };
const name = { name: 'name', required: true, type: 'string', sensitive: false, raw: false };

afterEach(() => setContentForTests(null));
const load = (entries: Record<string, Record<string, string>>, version = 'v3') =>
  setContentForTests(parseContentDocument({ version, entries }));

describe('withContent', () => {
  it('fills content variables from the template locale chain and reports refs', () => {
    load({ 'tnc.in_force.url': { hi: 'https://example.org/hi/tnc', en: 'https://example.org/tnc' } });
    const out = withContent(t([name, tnc]), { name: 'Asha' });
    expect(out.input).toEqual({ name: 'Asha', tnc_url: 'https://example.org/hi/tnc' });
    expect(out.refs).toEqual([{ key: 'tnc.in_force.url', version: 'v3', locale: 'hi' }]);
  });

  it('caller cannot override content', () => {
    load({ 'tnc.in_force.url': { en: 'https://example.org/tnc' } });
    expect(() => withContent(t([tnc], 'en'), { tnc_url: 'https://evil.example/x' })).toThrow(
      expect.objectContaining({ code: 'unknown_variable' }),
    );
  });

  it.each([
    ['https://other.example/tnc'],
    ['javascript:alert(1)'],
    ['ftp://example.org/tnc'],
  ])('invalid content value %s is a configuration error naming no value', (bad) => {
    load({ 'tnc.in_force.url': { en: bad } });
    try {
      withContent(t([tnc], 'en'), {});
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe('invalid_content');
      expect(e.details).toEqual({ key: 'tnc.in_force.url', variable: 'tnc_url' });
      expect(e.message).not.toContain(bad);
    }
  });

  it('propagates unavailable / unknown / unresolved', () => {
    expect(() => withContent(t([tnc], 'en'), {})).toThrow(expect.objectContaining({ code: 'content_unavailable' }));
    load({ 'tnc.on_offer.url': { en: 'https://example.org/x' } });
    expect(() => withContent(t([tnc], 'en'), {})).toThrow(expect.objectContaining({ code: 'unknown_content_key' }));
    load({ 'tnc.in_force.url': { ta: 'https://example.org/ta' } });
    expect(() => withContent(t([tnc], 'kn'), {})).toThrow(expect.objectContaining({ code: 'content_unresolved' }));
  });

  it('a template with no content variables passes input through untouched', () => {
    const input = { name: 'Asha' };
    expect(withContent(t([name]), input)).toEqual({ input, refs: [] });
  });
});

describe('templateLocaleChain', () => {
  it('locale, language, default — de-duplicated', () => {
    expect(templateLocaleChain('hi-IN')).toEqual(['hi-IN', 'hi', 'en']);
    expect(templateLocaleChain('en')).toEqual(['en']);
  });
});
```

Add to the following test files, following each file's existing mocking style:

- **`plan.test.ts`** (mock `../../content/resolver`, or set content through `setContentForTests` and the real resolver):
  - "unresolved content refuses the send": a `single` send with a content template and no snapshot is rejected with `SendError` `content_unavailable`, `kind: 'configuration'`.
  - "a caller naming a content variable is unknown_variable": `kind: 'caller'`.
  - "content renders into the delivery and contentRefs is set".
  - "first_available skips a candidate whose content is unresolved and uses the next".
- **`validate.test.ts`:**
  - "publish refuses content_unavailable when no content is loaded".
  - "publish refuses unknown_content_key".
  - "publish passes when the key exists".
- **`admin-templates.test.ts`:** "preview renders resolved content".
- **`v1-notify.test.ts`:** "jobs carry audit.contentRefs when the plan has them".
- **`redact.test.ts`:** "payload includes content_refs for redacted and non-redacted jobs".

- [ ] **Step 2: Run the tests and confirm they fail.** Run: `pnpm vitest run src/lib/content src/lib/send src/lib/templates src/routes src/lib/audit`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/lib/content/inject.ts`:

```ts
import type { TemplateRow } from '../db/schema';
import { defaultLocale } from '../network';
import { isContentVariable, validateVariables } from '../templates/contract';
import { TemplateError } from '../templates/errors';
import { resolveContent } from './resolver';
import type { ContentRef } from './types';

/** The resolved template's locale, its language, then NS_DEFAULT_LOCALE. */
export function templateLocaleChain(locale: string): string[] {
  const base = locale.split('-')[0]!;
  return [...new Set([locale, base, defaultLocale()])];
}

/**
 * Fill a template's content_ref variables from the content resolver.
 * Content is never caller input: a caller value under a content variable's
 * name is refused. Content values pass the same type checks as caller values,
 * and a failure is a configuration error that names the key, never the value.
 */
export function withContent(
  t: Pick<TemplateRow, 'locale' | 'variables'>,
  input: Record<string, unknown>,
): { input: Record<string, unknown>; refs: ContentRef[] } {
  const specs = t.variables.filter(isContentVariable);
  if (specs.length === 0) return { input, refs: [] };

  const supplied = specs.filter((s) => Object.prototype.hasOwnProperty.call(input, s.name)).map((s) => s.name);
  if (supplied.length) {
    throw new TemplateError('unknown_variable', `unknown variables: ${supplied.join(', ')}`, { variables: supplied });
  }

  const chain = templateLocaleChain(t.locale);
  const out: Record<string, unknown> = { ...input };
  const refs: ContentRef[] = [];
  for (const spec of specs) {
    const key = spec.contentKey!;
    const { value, ref } = resolveContent(key, chain);
    try {
      validateVariables([{ ...spec, source: 'request' }], { [spec.name]: value });
    } catch (e) {
      if (!(e instanceof TemplateError)) throw e;
      throw new TemplateError('invalid_content', `content ${key} is not a valid value for ${spec.name}`, {
        key,
        variable: spec.name,
      });
    }
    out[spec.name] = value;
    refs.push(ref);
  }
  return { input: out, refs };
}
```

`validateVariables` is in `contract.ts`. Import it from there.

In `src/lib/send/plan.ts`:
- Import `callerVariables` and `withContent`, and the `ContentRef` type.
- Change `union` to `new Set(resolved.flatMap((r) => callerVariables(r.template.variables).map((s) => s.name)))`.
- In the render loop, change `own` to the template's caller variable names. Then call `const content = withContent(r.template, pick(req.variables, own));`, then `renderWithValues(r.template, r.renders, content.input)`. All of this sits inside the existing `try`, so content errors follow the skip/fail rule.
- After a delivery is pushed, append `content.refs` to a `contentRefs` array. Return `contentRefs` on `SendPlan`, and add `contentRefs: ContentRef[]` to the interface.

In `src/lib/templates/validate.ts`, inside `validateForPublish`, after the contract parse succeeds, add:

```ts
  const contentSpecs = contract.filter(isContentVariable);
  if (contentSpecs.length) {
    const snap = currentContent();
    if (!snap) throw new TemplateError('content_unavailable', 'no content is loaded; cannot publish content_ref variables');
    const missing = contentSpecs.map((s) => s.contentKey!).filter((k) => !snap.keys.has(k));
    if (missing.length) throw new TemplateError('unknown_content_key', `content keys not defined: ${missing.join(', ')}`, { keys: missing });
  }
```

In `src/routes/admin-templates.ts` preview, replace `renderTemplate(t, vendor.renders, b.data.variables)` with `renderTemplate(t, vendor.renders, withContent(t, b.data.variables).input)`. `sendAdminError` already maps `TemplateError` to `422`. Verify that it maps every new code to `422`.

In `src/lib/audit/store.ts` `AuditIds`, add:

```ts
  /** Shared content this send rendered (key, version, locale) — references, never values. */
  contentRefs?: ContentRef[];
```

In `src/lib/audit/redact.ts`, add `...(job.audit.contentRefs?.length ? { content_refs: job.audit.contentRefs } : {})` to **both** payload object literals.

In `src/routes/v1-notify.ts`, add `...(plan.contentRefs.length ? { contentRefs: plan.contentRefs } : {})` to the shared `audit` object. Fallthrough (`worker.ts`) spreads `audit`, so the refs carry over unchanged.

- [ ] **Step 4: Run the tests.** Run `pnpm build`, then `pnpm test`, then the full integration suite per global-constraints. Remove the containers afterwards.
Expected: everything passes. Existing plan, route and redact tests are unchanged, apart from the added `contentRefs: []` where a test compares the whole plan object.

- [ ] **Step 5: Commit**

```bash
git add -A src
git commit -m "feat(content): resolve content_ref variables at publish, plan and preview; record refs on the event

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: OpenAPI and documentation (notification-service)

**Files:**
- Modify: `src/lib/utils/openapi.ts`, `src/lib/utils/__tests__/openapi.test.ts`, `CLAUDE.md`, `README.md`, `example.env`

- [ ] **Step 1: Write the failing test.** In `openapi.test.ts`, assert the following:
  - The template variable-spec schema used by the admin template create/patch bodies has `source` with enum `['request', 'content_ref']` and `contentKey` with the `CONTENT_KEY` pattern string.
  - The admin `422` description lists `content_unavailable`, `unknown_content_key`, `content_unresolved` and `invalid_content`.
  - The `/v1/notify` `422` description lists those codes under `configuration`.

- [ ] **Step 2: Run it and confirm it fails.** Run: `pnpm vitest run src/lib/utils`
Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **openapi.ts:** add the fields and codes. Use `CONTENT_KEY.source` for the pattern so the two cannot drift.
  - **CLAUDE.md:** add a **Content resolver** subsection under "Templates and policies" covering:
    - the variable fields and rules
    - the file format
    - the env vars (`NS_CONTENT_PROVIDER`, `NS_CONTENT_FILE`, `NS_CONTENT_RELOAD_MS`)
    - the allowlist (E1)
    - resolution at accept (E2)
    - `content_refs` on the event (E3)
    - reload behaviour and never failing boot (E4)
    - the locale chain
    - the four error codes and that they are configuration errors
    - that callers cannot supply content variables
    - that a ConfigMap must be mounted as a directory, not `subPath`, to receive updates
    
    Update the test counts.
  - **README.md:** add a short example: a variable spec with `source: content_ref`, the content file, and the rendered result. Update the env table.
  - **example.env:** add `NS_CONTENT_FILE=` with a comment ("unset = content_ref variables unavailable") and `NS_CONTENT_RELOAD_MS=30000`.

- [ ] **Step 4: Run.** Run: `pnpm build && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/utils CLAUDE.md README.md example.env
git commit -m "docs(content): content resolver contract, file format and configuration

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Mount the content ConfigMap (bluedots-automation)

**Files** (worktree `.worktrees/ns-plan-e/bluedots-automation`, branch `feat/ns-content-resolver` off `origin/feat/ns-service-auth`):
- Modify: `helm/signals/charts/notification-service/values.yaml`, its deployment template, a new `templates/configmap-content.yaml`, and `helm/CLAUDE.md`

Read `bluedots-automation/CLAUDE.md` and `helm/CLAUDE.md` first.

**Interfaces:** the chart value is `content: {}`, a map holding the content document (`version`, `entries`). It is empty by default.

- [ ] **Step 1: Write the failing check.** Run `helm template` on the NS chart with values that set `content`, and run it again with `content` empty. The two cases expect:
  - **content set:** a ConfigMap `<fullname>-content` with key `content.json` (the document as JSON); a volume mounting it as a **directory** at `/app/config/content` (no `subPath`); and env `NS_CONTENT_FILE=/app/config/content/content.json`.
  - **content empty:** no ConfigMap, no volume, no `NS_CONTENT_FILE`.

  Before implementing, capture both renders and confirm the "content set" case lacks those resources.

- [ ] **Step 2: Implement.**
  - **`templates/configmap-content.yaml`:** guarded by `{{- if .Values.content }}`, renders `content.json: {{ .Values.content | toJson | quote }}`.
  - **Deployment template:** under the same guard, add a `content` volume (configMap) and a volumeMount at `/app/config/content`, `readOnly: true`. Set `NS_CONTENT_FILE` in the env block the chart already renders for NS.
  - **Rollout annotation:** add `checksum/content` with the sha256 of the content ConfigMap to the pod template, but only if the chart already uses checksum annotations for its other ConfigMaps. NS reloads the file live, so a rollout is not required. Follow the chart's existing convention.
  - **`values.yaml`:** add `content: {}` with a comment showing the document shape and stating the rule: keys are dotted lowercase, for example `tnc.in_force.url`, and locales look like `en` or `hi-IN`.
  - **`helm/CLAUDE.md`:** add one paragraph: how to publish T&C content for NS, that edits propagate without a restart (kubelet sync, then NS reloads every 30 s), and that the keys present are the only ones templates can reference.

- [ ] **Step 3: Verify.** Run `helm template` for both cases. Then run `helm lint` on the chart, and the promtool test with `--set postgres.host=pg.test` if it is run locally.
Expected: as in Step 1, with the lint clean.

- [ ] **Step 4: Commit**

```bash
git add helm
git commit -m "feat(ns): optional content ConfigMap for the notification-service content resolver

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Done when

- notification-service `pnpm build`, `pnpm test` and `pnpm test:integration` are green; the automation `helm lint` is clean.
- A template can declare `source: content_ref` and render the content for its locale. Publishing checks every referenced key against the loaded content.
- A caller cannot supply or override content.
- An unavailable, unknown, unresolved or invalid content reference refuses the send with a configuration `422`; it is never rendered empty.
- A broken content file never stops the service or affects sends without content variables, and a bad reload keeps the last good version.
- Each event records which content key, version and locale it carried.
- The chart can mount content as a live-updating ConfigMap.
