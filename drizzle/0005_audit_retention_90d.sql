-- Tier-1 retention (spec §Retention and PII): the audit tables keep 90 days.
-- pg_partman drops a monthly partition once its whole month is older than the
-- retention window, during the maintenance run NS drives (src/lib/db/maintenance.ts).
-- A row therefore lives at least 90 days and at most about 121 (90 days plus the
-- month it was written in). Dropped partitions are removed, not detached.
-- Rows in a default partition are not covered; check_default reports them.
UPDATE partman.part_config
   SET retention            = '90 days',
       retention_keep_table = false,
       retention_keep_index = false
 WHERE parent_table IN ('public.notification_event', 'public.delivery_attempt');
