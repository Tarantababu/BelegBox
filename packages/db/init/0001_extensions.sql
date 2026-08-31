-- Runs once, on an empty data directory, via docker-entrypoint-initdb.d.
-- Extensions only. Tables arrive with the week 2 migration, together with the
-- RLS policies - see packages/db/README.md.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- archive full-text search (M-05)

-- The application connects as this role. It is deliberately NOT the owner:
-- audit_log and archive_chain must be append-only even to the application, and
-- that is enforced by grants, not by discipline.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'belegbox_app') THEN
    CREATE ROLE belegbox_app LOGIN PASSWORD 'belegbox';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE belegbox TO belegbox_app;
GRANT USAGE ON SCHEMA public TO belegbox_app;
