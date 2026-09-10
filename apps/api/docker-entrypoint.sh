#!/usr/bin/env bash
#
# Brings the database to a usable state before the API accepts traffic.
#
# Idempotent by construction: the schema push is a no-op when the schema already
# matches, and the seed is skipped entirely when a tenant already exists — so
# restarting the stack never overwrites your data.
#
set -euo pipefail

say() { printf '\033[36m[entrypoint]\033[0m %s\n' "$*"; }

say "waiting for the database"
for i in $(seq 1 60); do
  if node -e '
    const { PrismaClient } = require("@prisma/client");
    const p = new PrismaClient();
    p.$queryRaw`SELECT 1`.then(() => process.exit(0)).catch(() => process.exit(1));
  ' >/dev/null 2>&1; then
    say "database reachable"
    break
  fi
  [ "$i" = "60" ] && { say "database never became reachable"; exit 1; }
  sleep 1
done

# Called by path rather than through npx: the binary is right here under the
# pnpm layout, and npx would otherwise be free to reach for the network.
say "applying the schema"
./node_modules/.bin/prisma db push --skip-generate

TENANTS="$(node -e '
  const { PrismaClient } = require("@prisma/client");
  new PrismaClient().tenant.count()
    .then(n => { console.log(n); process.exit(0); })
    .catch(() => { console.log(0); process.exit(0); });
')"

if [ "${TENANTS:-0}" -gt 0 ]; then
  say "already prepared (${TENANTS} tenant(s)) — leaving the data alone"
else
  say "preparing the tenant (permissions, pipelines, leave types, first account)"
  node dist/seed/index.js
fi

say "starting the API"
exec "$@"
