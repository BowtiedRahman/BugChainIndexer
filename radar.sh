#!/usr/bin/env bash
# BugChainIndexer control: start, stop, status, logs, chain management.
#
#   ./radar.sh start                 postgres + scanners + gates for all ACTIVE chains
#   ./radar.sh stop                  all workers (postgres and data stay)
#   ./radar.sh status                workers, row counts, per-chain progress
#   ./radar.sh logs                  tail worker logs
#
#   ./radar.sh chains                list known chains and which are active
#   ./radar.sh add <chain>           activate a chain already in config/networks.js
#   ./radar.sh remove <chain>        deactivate: stop its workers, keep its data
#   ./radar.sh newchain <id> <chainId> <rpcUrl> <symbol>   add a brand-new chain
#                                    to config + activate it in one step
#
# Active chains live in scanners/chains.txt (one per line). That file is the
# single source of truth; every command reads it. Data for a removed chain
# stays in Postgres until you delete it by hand.
set -uo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# scanners/ sits next to this script when run from the repo root, or one
# level under BugChainIndexer/ when run from a parent checkout folder.
if   [ -d "$BASE/scanners" ];                then S="$BASE/scanners"
elif [ -d "$BASE/BugChainIndexer/scanners" ]; then S="$BASE/BugChainIndexer/scanners"
else echo "$0: cannot locate scanners/ relative to $BASE" >&2; exit 1
fi
LOGD="$BASE/logs"
CHAINS_FILE="$S/chains.txt"
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

worker_pids() { pgrep -f 'core/(DeploymentScanner|FundingGate)\.js' 2>/dev/null; }

active_chains() { [ -f "$CHAINS_FILE" ] && grep -vE '^\s*(#|$)' "$CHAINS_FILE"; }

known_chains() {
  # Run from $S so node resolves dotenv/deno-installed modules.
  # grep keeps only bare chain-name lines; dotenv's banner lines contain
  # spaces/symbols and get dropped.
  (cd "$S" && node -e 'require("dotenv").config();const{NETWORKS}=require("./config/networks.js");console.log(Object.keys(NETWORKS).join("\n"))' 2>/dev/null | grep -E '^[a-z0-9-]+$')
}

worker_running() { # $1=chain $2=script-name
  for p in $(worker_pids); do
    local net; net=$(tr '\0' '\n' < /proc/$p/environ 2>/dev/null | grep '^NETWORK=' | cut -d= -f2)
    [ "$net" = "$1" ] && ps -o args= -p $p | grep -q "$2" && return 0
  done
  return 1
}

start_worker() { # $1=chain $2=script-file $3=logfile
  worker_running "$1" "$2" && { echo "  $1 $2 already running"; return 0; }
  (cd "$S" && setsid nohup env NETWORK="$1" node "core/$2" >> "$LOGD/$3" 2>&1 < /dev/null &)
  echo "  started $1 $2"
}

# ---------- start/stop ----------
cmd_start() {
  echo "==> postgres"
  ensure_postgres && echo "  ready"
  echo "==> workers for active chains ($(active_chains | tr '\n' ' '))"
  for net in $(active_chains); do
    start_worker "$net" DeploymentScanner.js "deploy-$net.log"
    start_worker "$net" FundingGate.js "gate-$net.log"
  done
  sleep 2
  cmd_status
}

cmd_stop() {
  local pids; pids=$(worker_pids)
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null; sleep 2
    pids=$(worker_pids); [ -n "$pids" ] && kill -9 $pids 2>/dev/null
    echo "stopped all workers"
  else
    echo "no workers running"
  fi
  echo "(postgres left running; data persists)"
}

# ---------- status ----------
cmd_status() {
  echo "== workers"
  local pids; pids=$(worker_pids)
  if [ -z "$pids" ]; then
    echo "  none running (./radar.sh start)"
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
    for net in $(active_chains); do
      local blk; blk=$(docker exec bugchain-pg psql -U postgres -d bugchain_indexer -tAc \
        "SELECT last_block FROM scan_cursor WHERE network='$net'" 2>/dev/null)
      local cnt; cnt=$(docker exec bugchain-pg psql -U postgres -d bugchain_indexer -tAc \
        "SELECT count(*) FROM addresses WHERE network='$net'" 2>/dev/null)
      echo "  $net: $cnt rows, cursor block ${blk:-none}"
    done
  else
    echo "  DOWN"
  fi
  echo "== active chains: $(active_chains | tr '\n' ' ')"
}

cmd_logs() { tail -n 40 -f "$LOGD"/deploy-*.log "$LOGD"/gate-*.log 2>/dev/null; }

# ---------- chain management ----------
cmd_chains() {
  echo "known chains (in config/networks.js):"
  for c in $(known_chains); do
    local active=""; active_chains | grep -qx "$c" && active=" [ACTIVE]"
    echo "  $c$active"
  done
}

cmd_add() { # $1=chain
  local c="$1"
  [ -z "$c" ] && { echo "usage: radar.sh add <chain>"; exit 1; }
  known_chains | grep -qx "$c" || { echo "unknown chain '$c'. Known: $(known_chains | tr '\n' ' ')"; exit 1; }
  active_chains | grep -qx "$c" && { echo "$c already active"; exit 0; }
  echo "$c" >> "$CHAINS_FILE"
  sort -u -o "$CHAINS_FILE" "$CHAINS_FILE"
  echo "$c activated. running: ./radar.sh start picks it up."
  if pg_up; then
    echo "starting its workers now:"
    start_worker "$c" DeploymentScanner.js "deploy-$c.log"
    start_worker "$c" FundingGate.js "gate-$c.log"
  fi
}

cmd_remove() { # $1=chain
  local c="$1"
  [ -z "$c" ] && { echo "usage: radar.sh remove <chain>"; exit 1; }
  if [ -f "$CHAINS_FILE" ]; then
    grep -vE "^${c}\$" "$CHAINS_FILE" > "$CHAINS_FILE.tmp" && mv "$CHAINS_FILE.tmp" "$CHAINS_FILE"
  fi
  # kill just this chain's workers
  for p in $(worker_pids); do
    local net; net=$(tr '\0' '\n' < /proc/$p/environ 2>/dev/null | grep '^NETWORK=' | cut -d= -f2)
    [ "$net" = "$c" ] && kill "$p" 2>/dev/null
  done
  echo "$c deactivated. Its rows stay in Postgres; delete with:"
  echo "  docker exec bugchain-pg psql -U postgres -d bugchain_indexer -c \"DELETE FROM addresses WHERE network='$c'; DELETE FROM scan_cursor WHERE network='$c';\""
}

cmd_newchain() { # $1=slug $2=chainId $3=rpcUrl $4=symbol
  local slug="$1" cid="$2" rpc="$3" sym="$4"
  [ -z "$slug" ] || [ -z "$cid" ] || [ -z "$rpc" ] || [ -z "$sym" ] && {
    echo "usage: radar.sh newchain <slug> <chainId> <rpcUrl> <nativeSymbol>"; echo 'example: radar.sh newchain arbitrum 42161 https://arb1.arbitrum.io/rpc ETH'; exit 1; }
  known_chains | grep -qx "$slug" && { echo "$slug already exists in config"; exit 1; }
  # Append a minimal network entry. No helper contracts: the unified scanner
  # skips this chain, but DeploymentScanner and FundingGate work everywhere.
  cat >> "$S/config/networks.js.tmp" << EOF

  $slug: {
    chainId: $cid,
    name: '$slug',
    rpcUrls: ['$rpc'],
    nativeCurrency: '$sym',
    contractValidator: null,
    BalanceHelper: null
  },
EOF
  # Insert the new network into ADDITIONAL_NETWORKS (the second chain object,
  # starts at `const ADDITIONAL_NETWORKS = {`). Anchoring on its declaration
  # and inserting right after is always syntactically valid; anchoring on
  # CONFIG failed because NETWORKS/ADDITIONAL_NETWORKS close above it.
  node - "$S/config/networks.js" "$S/config/networks.js.tmp" << 'NODEEOF'
const fs = require('fs');
const [path, tmpPath] = process.argv.slice(2);
const src = fs.readFileSync(path, 'utf8');
const addition = fs.readFileSync(tmpPath, 'utf8');
const anchor = 'const ADDITIONAL_NETWORKS = {';
const idx = src.indexOf(anchor);
if (idx === -1) { console.error('cannot find ADDITIONAL_NETWORKS'); process.exit(1); }
// insert just after the opening brace line
const insertAt = src.indexOf('\n', idx) + 1;
fs.writeFileSync(path, src.slice(0, insertAt) + addition.replace(/^\n/, '') + src.slice(insertAt));
NODEEOF
  rm -f "$S/config/networks.js.tmp"
node --check "$S/config/networks.js" || { echo "config broken; reverting"; git -C "$S/.." checkout -- "$S/config/networks.js"; exit 1; }
echo "$slug" >> "$CHAINS_FILE"
sort -u -o "$CHAINS_FILE" "$CHAINS_FILE"
echo "$slug added (chainId $cid) and activated. Workers start on next ./radar.sh start, or run: ./radar.sh add $slug"
}

cmd_backfill() { # $1=chain $2=from-date-or-block $3=to-date-or-block
  local c="$1" fromArg="$2" toArg="$3"
  [ -z "$c" ] || [ -z "$fromArg" ] && { echo "usage: radar.sh backfill <chain> <from-date|block> [to-date|block]"; echo 'example: radar.sh backfill binance 2025-09-01           # sept 1 to now'; echo '         radar.sh backfill binance 2025-09-01 2025-10-01  # explicit range'; echo '         radar.sh backfill binance 48000000 49500000      # block numbers'; exit 1; }
  ensure_postgres
  local envs="NETWORK=$c"
  if [[ "$fromArg" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    envs="$envs FROM_DATE=$fromArg"
  else
    envs="$envs FROM_BLOCK=$fromArg"
  fi
  if [ -n "$toArg" ]; then
    if [[ "$toArg" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then envs="$envs TO_DATE=$toArg"; else envs="$envs TO_BLOCK=$toArg"; fi
  fi
  echo "backfilling $c ($envs). Runs in foreground; live cursor untouched."
  (cd "$S" && exec env $envs node core/DeploymentScanner.js)
}

case "${1:-status}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status|'') cmd_status ;;
  logs) cmd_logs ;;
  chains) cmd_chains ;;
  add) cmd_add "${2:-}" ;;
  remove) cmd_remove "${2:-}" ;;
  newchain) cmd_newchain "${2:-}" "${3:-}" "${4:-}" "${5:-}" ;;
  backfill) cmd_backfill "${2:-}" "${3:-}" "${4:-}" ;;
  *) echo "usage: $0 {start|stop|status|logs|chains|add <chain>|remove <chain>|newchain <slug> <chainId> <rpc> <symbol>|backfill <chain> <from> [to]}"; exit 1 ;;
esac
