/** A loaded, validated, immutable view of the shared content. */
export interface ContentSnapshot {
  version: string;
  /** The allowlist: the only keys a template may reference. */
  keys: ReadonlySet<string>;
  get(key: string, locale: string): string | undefined;
  /** Hash of the source text, when the provider has one; used to spot edits that keep the version. */
  fingerprint?: string;
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
