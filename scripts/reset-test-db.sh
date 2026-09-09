#!/usr/bin/env bash
#
# Rebuilds the acceptance suite's database from scratch.
#
# Errors are NOT suppressed. A `DROP DATABASE` against a live connection fails,
# and a reseed that swallows that failure appears to succeed while every
# guarded block silently skips — which has cost this project a debugging
# session more than once. Open connections are terminated first, on purpose.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${TEST_DB_NAME:-kaizen_test}"
export PGPASSWORD="${PGPASSWORD:-kaizen}"
PSQL=(psql -h 127.0.0.1 -U kaizen -v ON_ERROR_STOP=1)
URL="postgresql://kaizen:kaizen@127.0.0.1:5432/${DB}?schema=public"

"${PSQL[@]}" -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB}' AND pid<>pg_backend_pid();" >/dev/null
"${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS ${DB};" >/dev/null
"${PSQL[@]}" -d postgres -c "CREATE DATABASE ${DB} OWNER kaizen;" >/dev/null

cd "${ROOT}/apps/api"
DATABASE_URL="${URL}" npx prisma db push --skip-generate >/dev/null
DATABASE_URL="${URL}" npx tsx src/tests/fixtures/run.ts >/dev/null
echo "${DB} rebuilt  ->  ${URL}"
