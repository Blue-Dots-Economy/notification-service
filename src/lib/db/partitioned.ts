import { boolean, integer, jsonb, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Query-side definitions of the partitioned audit tables. Their DDL is the
 * custom migration drizzle/0000_audit_tables.sql — drizzle.config.ts does not
 * include this file, so `db:generate` never tries to re-create them. Change a
 * column here AND in a new custom migration, together.
 */

export type EventStatus =
  | 'accepted' | 'resolved' | 'dispatching' | 'sent'
  | 'delivered' | 'partially_delivered' | 'failed' | 'expired';

export type AttemptStatus =
  | 'queued' | 'dispatching' | 'sent' | 'accepted_by_provider'
  | 'delivered' | 'bounced' | 'failed' | 'expired';

/** How an event's status derives from its attempts: single/first_available mirror the current attempt; all rolls up. */
export type DeliveryMode = 'single' | 'first_available' | 'all';

export const notificationEvent = pgTable('notification_event', {
  id: uuid('id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  correlationId: text('correlation_id').notNull(),
  traceId: text('trace_id'),
  idempotencyKey: text('idempotency_key'),
  eventType: text('event_type'),
  templateKey: text('template_key'),
  network: text('network').notNull(),
  domain: text('domain'),
  source: text('source').notNull(),
  priority: text('priority').notNull(),
  deadline: timestamp('deadline', { withTimezone: true }),
  status: text('status').$type<EventStatus>().notNull(),
  payload: jsonb('payload').notNull(),
  deliveryMode: text('delivery_mode').$type<DeliveryMode>().notNull().default('single'),
});

export const deliveryAttempt = pgTable('delivery_attempt', {
  id: uuid('id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  notificationEventId: uuid('notification_event_id').notNull(),
  channel: text('channel').notNull(),
  provider: text('provider'),
  templateId: text('template_id').notNull(),
  attemptNo: integer('attempt_no').notNull().default(1),
  status: text('status').$type<AttemptStatus>().notNull(),
  statusRank: smallint('status_rank').notNull(),
  recoverable: boolean('recoverable').notNull(),
  job: jsonb('job'),
  providerMessageId: text('provider_message_id'),
  error: text('error'),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});
