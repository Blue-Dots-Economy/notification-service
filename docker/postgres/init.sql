-- Mirrors bluedots-automation helm/common-services postgres-bootstrap-job.yaml
-- (notificationRole). Keep the two in step.
CREATE ROLE notification LOGIN PASSWORD 'notification';
CREATE DATABASE notification OWNER notification;
\connect notification
CREATE SCHEMA IF NOT EXISTS partman;
CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman;
GRANT USAGE, CREATE ON SCHEMA partman TO notification;
GRANT ALL ON ALL TABLES IN SCHEMA partman TO notification;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA partman TO notification;
GRANT EXECUTE ON ALL PROCEDURES IN SCHEMA partman TO notification;
GRANT TEMPORARY ON DATABASE notification TO notification;
