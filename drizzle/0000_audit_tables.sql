-- Tier-1 audit tables (spec §Retention and PII): monthly RANGE partitions on
-- created_at, managed by pg_partman (schema `partman`). Custom migration because
-- drizzle-kit cannot emit PARTITION BY; query-side definitions live in
-- src/lib/db/partitioned.ts. Retention (partition drop at 90 days) is NOT set
-- here — that is #65.
--
-- Partitioned tables cannot carry a primary key or unique constraint that omits
-- the partition key, hence PRIMARY KEY (id, created_at) and no foreign key from
-- delivery_attempt to notification_event (an FK into a partitioned table would
-- need created_at too). notification_event_id is indexed instead.
CREATE TABLE notification_event (
  id              uuid        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  correlation_id  text        NOT NULL,
  trace_id        text,
  idempotency_key text,
  event_type      text,
  template_key    text,
  network         text        NOT NULL,
  domain          text,
  source          text        NOT NULL,
  priority        text        NOT NULL,
  deadline        timestamptz,
  status          text        NOT NULL,
  payload         jsonb       NOT NULL,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
--> statement-breakpoint
CREATE INDEX notification_event_correlation_idx ON notification_event (correlation_id);
--> statement-breakpoint
CREATE TABLE delivery_attempt (
  id                    uuid        NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  notification_event_id uuid        NOT NULL,
  channel               text        NOT NULL,
  provider              text,
  template_id           text        NOT NULL,
  attempt_no            integer     NOT NULL DEFAULT 1,
  status                text        NOT NULL,
  status_rank           smallint    NOT NULL,
  recoverable           boolean     NOT NULL,
  job                   jsonb,
  provider_message_id   text,
  error                 text,
  dispatched_at         timestamptz,
  completed_at          timestamptz,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
--> statement-breakpoint
CREATE INDEX delivery_attempt_event_idx ON delivery_attempt (notification_event_id);
--> statement-breakpoint
CREATE INDEX delivery_attempt_open_idx ON delivery_attempt (status, updated_at)
  WHERE status IN ('queued', 'dispatching');
--> statement-breakpoint
SELECT partman.create_parent(
  p_parent_table := 'public.notification_event',
  p_control      := 'created_at',
  p_interval     := '1 month',
  p_premake      := 3
);
--> statement-breakpoint
SELECT partman.create_parent(
  p_parent_table := 'public.delivery_attempt',
  p_control      := 'created_at',
  p_interval     := '1 month',
  p_premake      := 3
);
