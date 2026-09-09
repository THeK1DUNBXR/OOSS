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
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${TEST_DB_NAME:-kaizen_test}"
URL="postgresql://kaizen:kaizen@127.0.0.1:5432/${DB}?schema=public"

exists() { sudo -u postgres psql -lqt | cut -d'|' -f1 | tr -d ' ' | grep -qx "${DB}"; }

if [ "${1:-}" = "--reseed" ] && exists; then
  echo "dropping ${DB}…"
  sudo -u postgres psql -c "DROP DATABASE ${DB};" >/dev/null
fi

if ! exists; then
  echo "creating ${DB}…"
  sudo -u postgres psql -c "CREATE DATABASE ${DB} OWNER kaizen;" >/dev/null
fi

cd "${ROOT}/apps/api"
DATABASE_URL="${URL}" npx prisma db push --skip-generate >/dev/null
DATABASE_URL="${URL}" npx tsx src/tests/fixtures/run.ts >/dev/null
echo "${DB} ready  ->  ${URL}"
