#!/usr/bin/env bash
#
# Provisions the acceptance suite's database.
#
# The suite runs against a real database rather than mocks, so it needs one of
# its own — it creates and mutates records, and the development dataset is a
# demonstration rather than a scratchpad.
#
#   scripts/test-db.sh          create and seed if absent
#   scripts/test-db.sh --reseed drop and rebuild from the seed
#
# Two roles, as in production (FX-51). The owner (kaizen) migrates and seeds and
# bypasses row-level security. The application role (kaizen_app) is what the
# API and the tests connect as; row-level security binds it.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${TEST_DB_NAME:-kaizen_test}"
OWNER_URL="postgresql://kaizen:kaizen@127.0.0.1:5432/${DB}?schema=public"
APP_URL="postgresql://kaizen_app:kaizen_app@127.0.0.1:5432/${DB}?schema=public"

exists() { sudo -u postgres psql -lqt | cut -d'|' -f1 | tr -d ' ' | grep -qx "${DB}"; }

if [ "${1:-}" = "--reseed" ] && exists; then
  echo "dropping ${DB}…"
  sudo -u postgres psql -c "DROP DATABASE ${DB};" >/dev/null
fi

if ! exists; then
  echo "creating ${DB}…"
  sudo -u postgres psql -c "CREATE DATABASE ${DB} OWNER kaizen;" >/dev/null
fi

# The owner bypasses RLS, so migrations and the seed can write any tenant's rows.
sudo -u postgres psql -c "ALTER ROLE kaizen BYPASSRLS;" >/dev/null
# Before migrations: the migration creates the application role only if it is
# missing, and the owner has no CREATEROLE.
sudo -u postgres psql -v ON_ERROR_STOP=1 -f "${ROOT}/scripts/app-role.sql" >/dev/null

cd "${ROOT}/apps/api"
# Migrations, not db push: db push never installed the triggers the migration
# history carries, so the suite would test a schema production does not have.
DATABASE_URL="${APP_URL}" MIGRATION_DATABASE_URL="${OWNER_URL}" npx prisma migrate deploy >/dev/null
DATABASE_URL="${OWNER_URL}" MIGRATION_DATABASE_URL="${OWNER_URL}" UNSCOPED_DATABASE_URL="${OWNER_URL}" \
  NODE_ENV=test JWT_SECRET="test-only-secret-not-used-anywhere-else-0123456789" \
  FIELD_ENCRYPTION_KEY="test-only-field-encryption-key-not-used-anywhere-else-0123456789" \
  npx tsx src/tests/fixtures/run.ts >/dev/null
echo "${DB} ready  ->  owner ${OWNER_URL}"
echo "                app   ${APP_URL}"
