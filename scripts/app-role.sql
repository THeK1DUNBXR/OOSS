-- The database role the API and the test suite connect as (FX-51).
--
-- It is not the owner. Row-level security binds it, and the boot check
-- (apps/api/src/platform/rlsGuard.ts) refuses to serve as a role that bypasses
-- it. Run as a superuser, before migrations: the migration creates this role
-- only if it is missing, and creating a role needs CREATEROLE, which the owner
-- does not have. The password here is for local and CI databases only; a
-- deployment sets its own.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kaizen_app') THEN
    CREATE ROLE kaizen_app LOGIN PASSWORD 'kaizen_app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  ELSE
    ALTER ROLE kaizen_app LOGIN PASSWORD 'kaizen_app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
