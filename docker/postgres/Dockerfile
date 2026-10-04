# Local/CI Postgres for notification-service: stock Postgres 17 + pg_partman,
# initialised the way the common-services bootstrap provisions RDS (role,
# database, pg_partman in schema `partman`, grants). Not shipped anywhere.
FROM postgres:17-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-17-partman \
 && rm -rf /var/lib/apt/lists/*
COPY init.sql /docker-entrypoint-initdb.d/10-notification.sql
