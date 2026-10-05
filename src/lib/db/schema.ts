import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Tables drizzle-kit manages (db:generate diffs this file).
 *
 * Partitioned tables are deliberately NOT here — drizzle-kit cannot emit
 * PARTITION BY, so their DDL lives in custom migrations and their query-side
 * definitions in ./partitioned.ts, which drizzle.config.ts does not include.
 */

export type LifecycleStatus = 'draft' | 'active' | 'retired';
export type PolicyMode = 'first_available' | 'all';

/** One entry of a template's variable contract. */
export interface VariableSpec {
  name: string;
  required: boolean;
  type: 'string' | 'number' | 'url';
  /** Redacted wherever a send comes to rest (rows, logs, dead letters). */
  sensitive: boolean;
  /** Email only: insert without HTML-escaping. An explicit, reviewable opt-out. */
  raw: boolean;
  /** url only: the value's host must equal one of these or be a subdomain of one. */
  urlHosts?: string[];
  /** `content_ref`: the value comes from the content resolver, never the caller. Absent = `request`. */
  source?: 'request' | 'content_ref';
  /** content_ref only: the content key, e.g. `tnc.in_force.url`. */
  contentKey?: string;
}

export interface PolicyChannel {
  channel: string;
  template_key: string;
}

const lifecycle = {
  createdBy: text('created_by').notNull(),
  publishedBy: text('published_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
};

export const template = pgTable(
  'template',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    network: text('network').notNull(),
    channel: text('channel').notNull(),
    templateKey: text('template_key').notNull(),
    locale: text('locale').notNull(),
    version: integer('version').notNull(),
    status: text('status').$type<LifecycleStatus>().notNull().default('draft'),
    subject: text('subject'),
    bodyHtml: text('body_html'),
    bodyText: text('body_text'),
    variables: jsonb('variables').$type<VariableSpec[]>().notNull().default(sql`'[]'::jsonb`),
    provider: text('provider').notNull(),
    providerTemplateId: text('provider_template_id'),
    senderId: text('sender_id'),
    dltEntityId: text('dlt_entity_id'),
    dltHeaderId: text('dlt_header_id'),
    dltTagId: text('dlt_tag_id'),
    approvalRef: text('approval_ref'),
    defaultDeadlineS: integer('default_deadline_s'),
    ...lifecycle,
  },
  (t) => [
    uniqueIndex('template_version_uq').on(t.network, t.channel, t.templateKey, t.locale, t.version),
    uniqueIndex('template_active_uq')
      .on(t.network, t.channel, t.templateKey, t.locale)
      .where(sql`${t.status} = 'active'`),
    check('template_status_ck', sql`${t.status} in ('draft', 'active', 'retired')`),
  ],
);

export const notificationPolicy = pgTable(
  'notification_policy',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    network: text('network').notNull(),
    domain: text('domain'),
    eventType: text('event_type'),
    version: integer('version').notNull(),
    status: text('status').$type<LifecycleStatus>().notNull().default('draft'),
    mode: text('mode').$type<PolicyMode>().notNull(),
    channels: jsonb('channels').$type<PolicyChannel[]>().notNull(),
    ...lifecycle,
  },
  (t) => [
    uniqueIndex('policy_version_uq').on(
      t.network,
      sql`coalesce(${t.domain}, '')`,
      sql`coalesce(${t.eventType}, '')`,
      t.version,
    ),
    uniqueIndex('policy_active_uq')
      .on(t.network, sql`coalesce(${t.domain}, '')`, sql`coalesce(${t.eventType}, '')`)
      .where(sql`${t.status} = 'active'`),
    check('policy_status_ck', sql`${t.status} in ('draft', 'active', 'retired')`),
    check('policy_mode_ck', sql`${t.mode} in ('first_available', 'all')`),
  ],
);

export type TemplateRow = typeof template.$inferSelect;
export type PolicyRow = typeof notificationPolicy.$inferSelect;

/** Send idempotency for normal/bulk priority (urgent uses Redis). Kept 90 days. */
export const idempotencyKey = pgTable(
  'idempotency_key',
  {
    network: text('network').notNull(),
    key: text('key').notNull(),
    response: jsonb('response'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.network, t.key] }),
    index('idempotency_key_created_at_idx').on(t.createdAt),
  ],
);
