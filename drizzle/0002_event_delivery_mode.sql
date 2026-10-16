-- Delivery mode of a send: 'single' (template_key), 'first_available' (try channels
-- in order), 'all' (fan out). Decides how the event's status is derived from its
-- attempts. Added on the partitioned parent; pg_partman children inherit it.
ALTER TABLE notification_event ADD COLUMN delivery_mode text NOT NULL DEFAULT 'single';
--> statement-breakpoint
ALTER TABLE notification_event ADD CONSTRAINT notification_event_delivery_mode_ck
  CHECK (delivery_mode IN ('single', 'first_available', 'all'));
