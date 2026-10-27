#!/usr/bin/env bash
# BugChainIndexer control: start, stop, status for the whole radar.
#
#   ./radar.sh start     postgres + watchers + gates for all chains
#   ./radar.sh stop      everything (data persists in docker volume)
#   ./radar.sh status    what's running, chain progress, last alert
#   ./radar.sh logs      tail all worker logs
#
# Chains: ethereum, binance, base, robinhood. Add more in CHAINS below.
set -uo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="$BASE/BugChainIndexer/scanners"
CHAINS=(ethereum binance base)
LOGD="$BASE/logs"
mkdir -p "$LOGD"

# ---------- helpers ----------
pg_up() { docker exec bugchain-pg pg_isready -U postgres -q 2>/dev/null; }

ensure_postgres() {
  if ! docker ps --filter name=bugchain-pg --format '{{.Names}}' | grep -q bugchain-pg; then
    docker start bugchain-pg >/dev/null 2>&1 || \
    docker run -d --name bugchain-pg \
      -e POSTGRES_PASSWORD="$(grep -oE '^PGPASSWORD=.*' "$S/.env" | cut -d= -f2)" \
      -e POSTGRES_USER=postgres -e POSTGRES_DB=bugchain_indexer \
      -p 5432:5432 -v bugchain_pgdata:/var/lib/postgresql/data postgres:16 >/dev/null
  fi
  for i in $(seq 1 20); do pg_up && return 0; sleep 1; done
  echo "postgres failed to become ready" >&2; return 1
}

worker_pids() { pgrep -f 'core/(DeploymentScanner|FundingGate|RobinhoodWatcher)\.js' 2>/dev/null; }

start_worker() { # $1=name $2=script $3=network $4=logfile
  pgrep -f "node .*core/$2" | grep -v "^\$$" >/dev/null 2>&1 && return 0
  local env_net=""
  [ "$3" != "-" ] && env_net="NETWORK=$3"
  # cwd must be $S so dotenv.config() finds scanners/.env.
  # setsid detaches from the terminal's session so closing the terminal
  # (SIGHUP) doesn't kill the worker. Plain nohup+& dies here.
  (cd "$S" && setsid nohup env $env_net node "core/$2" >> "$LOGD/$4" 2>&1 < /dev/null &)
  echo "  started $1"
}

# ---------- commands ----------
cmd_start() {
  echo "==> postgres"
  ensure_postgres && echo "  ready"
  echo "==> deployment scanners"
  for net in "${CHAINS[@]}"; do
    start_worker "deploy-$net" DeploymentScanner.js "$net" "deploy-$net.log"
  done
  # robinhood uses its own curl-transport watcher (ethers stalls on this box)
  pgrep -f 'core/RobinhoodWatcher.js' >/dev/null || {
    (cd "$S" && setsid nohup node core/RobinhoodWatcher.js >> "$LOGD/deploy-robinhood.log" 2>&1 < /dev/null &)
    echo "  started deploy-robinhood"
  }
  echo "==> funding gates"
  for net in "${CHAINS[@]}" robinhood; do
    start_worker "gate-$net" FundingGate.js "$net" "gate-$net.log"
  done
  sleep 2
  cmd_status
}

cmd_stop() {
  local pids; pids=$(worker_pids)
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null
    sleep 2
    pids=$(worker_pids)
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null
    echo "stopped $(echo $pids | wc -w) workers"
  else
    echo "no workers running"
  fi
  # postgres stays up: data survives, and stopping it earns nothing.
  echo "(postgres left running; 'docker stop bugchain-pg' stops it too)"
}

cmd_status() {
  echo "== workers"
  local pids; pids=$(worker_pids)
  if [ -z "$pids" ]; then
    echo "  none running"
  else
    for p in $pids; do
      local net; net=$(tr '\0' '\n' < /proc/$p/environ 2>/dev/null | grep '^NETWORK=' | cut -d= -f2 || echo '?')
      local script; script=$(ps -o args= -p $p | grep -oE 'core/[A-Za-z]+\.js' | head -1)
      echo "  $script [$net] pid=$p"
    done
  fi
  echo "== postgres"
  if pg_up; then
    docker exec bugchain-pg psql -U postgres -d bugchain_indexer -tAc \
      "SELECT '  rows=' || count(*) || ' funded=' || count(*) FILTER (WHERE status='funded') || ' candidates=' || count(*) FILTER (WHERE status='candidate') FROM addresses"
    for net in "${CHAINS[@]}" robinhood; do
      local blk; blk=$(docker exec bugchain-pg psql -U postgres -d bugchain_indexer -tAc \
        "SELECT last_block FROM scan_cursor WHERE network='$net'" 2>/dev/null)
      [ -n "$blk" ] && [ "$blk" != "0" ] && echo "  $net cursor: block $blk"
    done
  else
    echo "  DOWN"
  fi
}

cmd_logs() {
  tail -n 40 -f "$LOGD"/deploy-*.log "$LOGD"/gate-*.log 2>/dev/null
}

case "${1:-status}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status|'') cmd_status ;;
  logs) cmd_logs ;;
  *) echo "usage: $0 {start|stop|status|logs}"; exit 1 ;;
esac
