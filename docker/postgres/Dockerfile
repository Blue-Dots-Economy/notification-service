# Local/CI Postgres for notification-service: stock Postgres 17 + pg_partman,
# initialised the way the common-services bootstrap provisions RDS (role,
# database, pg_partman in schema `partman`, grants). Not shipped anywhere.
FROM postgres:17-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-17-partman \
 && rm -rf /var/lib/apt/lists/*
COPY init.sql /docker-entrypoint-initdb.d/10-notification.sql
# Run as the image's own non-root `postgres` user (the entrypoint supports it;
# PGDATA and the socket dir are already owned by postgres in the base image).
USER postgres
# TCP probe: the first-boot init server listens on the unix socket only, so a
# socket probe would report ready before init.sql has run.
HEALTHCHECK --interval=5s --timeout=3s --retries=20 \
  CMD pg_isready -h 127.0.0.1 -U postgres -d notification || exit 1
