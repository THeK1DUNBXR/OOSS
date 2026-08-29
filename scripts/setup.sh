#!/usr/bin/env bash
#
# One command from a fresh clone to a running application.
#
#   ./scripts/setup.sh            use Docker for Postgres (default)
#   ./scripts/setup.sh --native   use a Postgres already installed on this machine
#
# Creates the role and database, writes apps/api/.env, installs dependencies,
# applies the schema and seeds the demo dataset. Safe to re-run: every step
# checks before it acts.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

MODE="docker"
[ "${1:-}" = "--native" ] && MODE="native"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }
die()  { printf '\n\033[31m%s\033[0m\n\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
say "Checking prerequisites"

command -v node >/dev/null || die "Node is not installed. Node 22 or newer is required — https://nodejs.org"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "${NODE_MAJOR}" -ge 22 ] || die "Node ${NODE_MAJOR} found; this project needs Node 22 or newer."
ok "node $(node -v)"

if ! command -v pnpm >/dev/null; then
  warn "pnpm is not installed — enabling it through corepack"
  corepack enable >/dev/null 2>&1 || die "Could not enable pnpm. Install it with: npm install -g pnpm"
fi
ok "pnpm $(pnpm -v)"

# ---------------------------------------------------------------------------
# Postgres
# ---------------------------------------------------------------------------
say "Preparing PostgreSQL"

if [ "${MODE}" = "docker" ]; then
  command -v docker >/dev/null || die "Docker is not installed. Install Docker, or re-run with --native to use a local PostgreSQL."

  # `docker compose version` answers from the CLI alone and succeeds even when
  # the daemon is unreachable, so ask the daemon something only it can answer.
  #
  # "Installed but not picked up" is usually not a stopped daemon. The CLI
  # resolves its endpoint from DOCKER_HOST, then the active context, and either
  # can point somewhere the daemon is not — Docker Desktop on macOS moved its
  # socket under ~/.docker/run, Colima and Rancher Desktop each use their own,
  # rootless Docker uses the XDG runtime dir. So rather than reporting failure,
  # look for the socket where each of them actually puts it.
  find_docker() {
    docker info >/dev/null 2>&1 && return 0

    # Expanded with a default: DOCKER_HOST is normally unset, and `set -u`
    # would abort on a bare reference.
    local current="${DOCKER_HOST:-}"
    current="${current#unix://}"

    local candidates=(
      "${current}"
      "${HOME}/.docker/run/docker.sock"
      "/var/run/docker.sock"
      "${HOME}/.colima/default/docker.sock"
      "${HOME}/.rd/docker.sock"
      "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/docker.sock"
      "${HOME}/.local/share/containers/podman/machine/podman.sock"
    )
    for sock in "${candidates[@]}"; do
      [ -n "${sock}" ] && [ -S "${sock}" ] || continue
      if DOCKER_HOST="unix://${sock}" docker info >/dev/null 2>&1; then
        export DOCKER_HOST="unix://${sock}"
        ok "found the Docker daemon at ${sock}"
        warn "your shell's Docker endpoint did not point here — see the note at the end"
        FIXED_DOCKER_HOST="${DOCKER_HOST}"
        return 0
      fi
    done
    return 1
  }

  FIXED_DOCKER_HOST=""
  if ! find_docker; then
    # Distinguish the causes rather than blaming a stopped daemon for all of them.
    for sock in "/var/run/docker.sock" "${HOME}/.docker/run/docker.sock"; do
      if [ -S "${sock}" ] && [ ! -w "${sock}" ]; then
        die "The Docker socket at ${sock} exists but this account cannot write to it.
  On Linux, add yourself to the docker group and start a new login session:

    sudo usermod -aG docker \$USER && newgrp docker

  Or re-run with --native to use a local PostgreSQL instead."
      fi
    done
    die "Docker is installed but no daemon is reachable.

  Checked DOCKER_HOST, the active docker context, and the usual socket paths
  for Docker Desktop, Colima, Rancher Desktop, rootless Docker and Podman.

    docker context ls        shows which endpoint the CLI is using
    docker info              shows the daemon's own error

  If Docker Desktop is running, its context is probably not the active one:

    docker context use desktop-linux

  Or skip Docker entirely and use a local PostgreSQL:

    ./scripts/setup.sh --native"
  fi

  if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"
  elif command -v docker-compose >/dev/null;  then COMPOSE="docker-compose"
  else die "Neither 'docker compose' nor 'docker-compose' is available."; fi

  ${COMPOSE} up -d postgres >/dev/null 2>&1 || die "Could not start the postgres container."
  printf '  waiting for postgres'
  for _ in $(seq 1 40); do
    if docker exec kaizen-postgres pg_isready -U kaizen -d kaizen >/dev/null 2>&1; then break; fi
    printf '.'; sleep 1
  done
  printf '\n'
  docker exec kaizen-postgres pg_isready -U kaizen -d kaizen >/dev/null 2>&1 \
    || die "PostgreSQL did not become ready. Check: ${COMPOSE} logs postgres"
  ok "postgres 16 running in Docker on :5432 (role and database created by the image)"

else
  command -v psql >/dev/null || die "psql is not on PATH. Install PostgreSQL 16, or drop --native to use Docker."
  pg_isready -q 2>/dev/null || die "PostgreSQL is not accepting connections on this machine. Start it and re-run."

  # Try the current user first (Homebrew installs make you a superuser); fall
  # back to the postgres system account (typical on Debian and Ubuntu).
  as_super() {
    psql -d postgres -tAc "$1" 2>/dev/null || sudo -u postgres psql -d postgres -tAc "$1" 2>/dev/null
  }

  if [ "$(as_super "SELECT 1 FROM pg_roles WHERE rolname='kaizen'")" = "1" ]; then
    ok "role 'kaizen' already exists"
  else
    as_super "CREATE ROLE kaizen LOGIN PASSWORD 'kaizen' CREATEDB" >/dev/null \
      || die "Could not create the 'kaizen' role. Create it by hand:
    CREATE ROLE kaizen LOGIN PASSWORD 'kaizen' CREATEDB;"
    ok "created role 'kaizen'"
  fi

  if [ "$(as_super "SELECT 1 FROM pg_database WHERE datname='kaizen'")" = "1" ]; then
    ok "database 'kaizen' already exists"
  else
    as_super "CREATE DATABASE kaizen OWNER kaizen" >/dev/null \
      || die "Could not create the 'kaizen' database. Create it by hand:
    CREATE DATABASE kaizen OWNER kaizen;"
    ok "created database 'kaizen'"
  fi
fi

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------
say "Configuring the environment"

if [ -f apps/api/.env ]; then
  ok "apps/api/.env already present, left untouched"
else
  cp apps/api/.env.example apps/api/.env
  # A development secret that is at least unique to this machine.
  SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  node - "$SECRET" <<'NODE'
const fs = require('fs');
const p = 'apps/api/.env';
fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/^JWT_SECRET=.*$/m, `JWT_SECRET="${process.argv[2]}"`));
NODE
  ok "wrote apps/api/.env with a generated JWT secret"
fi

# ---------------------------------------------------------------------------
# Install, schema, seed
# ---------------------------------------------------------------------------
say "Installing dependencies"
pnpm install --silent || die "pnpm install failed."
ok "dependencies installed"

say "Applying the schema"
(cd apps/api && pnpm db:push >/dev/null 2>&1) || die "prisma db push failed. Check DATABASE_URL in apps/api/.env"
ok "schema applied"

say "Seeding"
SEEDED=$(cd apps/api && node -e '
const { PrismaClient } = require("@prisma/client");
new PrismaClient().tenant.count().then(n => { console.log(n); process.exit(0); }).catch(() => { console.log(0); process.exit(0); });
' 2>/dev/null || echo 0)

if [ "${SEEDED:-0}" -gt 0 ]; then
  ok "already seeded (${SEEDED} tenant(s)) — skipped, so your data is left alone"
else
  (cd apps/api && pnpm seed) || die "Seeding failed."
  ok "demo dataset seeded"
fi

# ---------------------------------------------------------------------------
say "Ready"

if [ -n "${FIXED_DOCKER_HOST:-}" ]; then
  cat <<NOTE

  Note: your shell's Docker endpoint did not point at your running daemon.
  This script worked around it for itself, but your own docker commands will
  still fail. To fix it for good, either activate the right context:

    docker context ls          # find the one that is running
    docker context use <name>

  or set the endpoint in your shell profile:

    export DOCKER_HOST="${FIXED_DOCKER_HOST}"
NOTE
fi

cat <<'DONE'

  ./scripts/dev.sh start     start the API and web server
  ./scripts/dev.sh logs      follow both logs
  ./scripts/dev.sh stop      stop them

  Then open  http://localhost:5173
  Sign in as chairman@kaizen.co.in / kaizen2026

  Try sysadmin@kaizen.co.in and latha@kaizen.co.in too (same password) —
  same screens, different systems. That is the permission model, not a demo mode.

DONE
