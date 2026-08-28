#!/usr/bin/env bash
#
# Local development runner.
#
#   scripts/dev.sh start    boot Postgres, the API and the web dev server
#   scripts/dev.sh stop     stop the API and web dev server
#   scripts/dev.sh restart  stop, then start
#   scripts/dev.sh status   report what is up
#   scripts/dev.sh logs     tail both logs
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_LOG="${ROOT}/.dev/api.log"
WEB_LOG="${ROOT}/.dev/web.log"
mkdir -p "${ROOT}/.dev"

api_pids() { pgrep -f "tsx.*src/server\.ts" 2>/dev/null; }
web_pids() { pgrep -f "vite.*--host" 2>/dev/null; }

start_db() {
  if pg_isready -q 2>/dev/null; then
    echo "postgres  already accepting connections"
    return
  fi
  echo "postgres  starting…"
  (service postgresql start >/dev/null 2>&1 || pg_ctlcluster 16 main start >/dev/null 2>&1) || true
  for _ in $(seq 1 20); do
    pg_isready -q 2>/dev/null && break
    sleep 1
  done
  pg_isready -q 2>/dev/null && echo "postgres  up" || echo "postgres  FAILED to start"
}

wait_for() {
  local url="$1" name="$2"
  for _ in $(seq 1 45); do
    if curl -sf -m 2 "$url" >/dev/null 2>&1; then
      echo "$name  up  ->  $url"
      return 0
    fi
    sleep 1
  done
  echo "$name  did not come up; see the log"
  return 1
}

stop() {
  for pid in $(api_pids) $(web_pids); do kill -9 "$pid" 2>/dev/null || true; done
  sleep 1
  echo "stopped"
}

start() {
  start_db

  if [ -z "$(api_pids)" ]; then
    (cd "${ROOT}/apps/api" && nohup npx tsx src/server.ts > "${API_LOG}" 2>&1 &) >/dev/null 2>&1
    wait_for "http://localhost:4000/health" "api      "
  else
    echo "api       already running"
  fi

  if [ -z "$(web_pids)" ]; then
    (cd "${ROOT}/apps/web" && nohup npx vite --host > "${WEB_LOG}" 2>&1 &) >/dev/null 2>&1
    wait_for "http://localhost:5173/" "web      "
  else
    echo "web       already running"
  fi

  echo
  echo "  API   http://localhost:4000"
  echo "  Web   http://localhost:5173"
  echo "  Sign in as chairman@kaizen.co.in / kaizen2026"
}

status() {
  pg_isready -q 2>/dev/null && echo "postgres  up" || echo "postgres  down"
  [ -n "$(api_pids)" ] && echo "api       up  (pid $(api_pids | tr '\n' ' '))" || echo "api       down"
  [ -n "$(web_pids)" ] && echo "web       up  (pid $(web_pids | tr '\n' ' '))" || echo "web       down"
}

case "${1:-start}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; start ;;
  status)  status ;;
  logs)    tail -n 40 -f "${API_LOG}" "${WEB_LOG}" ;;
  *)       echo "usage: scripts/dev.sh {start|stop|restart|status|logs}"; exit 1 ;;
esac
