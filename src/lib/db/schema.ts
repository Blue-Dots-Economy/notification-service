/**
 * Tables drizzle-kit manages (db:generate diffs this file).
 *
 * Partitioned tables are deliberately NOT here — drizzle-kit cannot emit
 * PARTITION BY, so their DDL lives in custom migrations and their query-side
 * definitions in ./partitioned.ts, which drizzle.config.ts does not include.
 */
export {};
