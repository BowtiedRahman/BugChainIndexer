#!/usr/bin/env bash
# Deploy BugChainIndexer to a fresh Ubuntu 22.04+/Debian 12 VPS.
#
#   ./deploy.sh user@host
#
# Installs Docker, copies the repo, writes .env from local values, boots
# the stack. Idempotent: safe to rerun; it converges to the same state.
set -euo pipefail

HOST="${1:?usage: ./deploy.sh user@host}"
REPO_DIR="/opt/bugchain"
LOCAL_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> [1/4] installing docker on $HOST"
ssh "$HOST" 'command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh'

echo "==> [2/4] syncing repo"
ssh "$HOST" "mkdir -p $REPO_DIR"
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude scanners/logs \
  "$LOCAL_REPO/" "$HOST:$REPO_DIR/"

echo "==> [3/4] writing .env from local values"
# Pull the secrets from the local untracked .env so they never appear in
# the repo or this script. Missing values become empty and the compose
# file refuses to boot without PGPASSWORD and the Etherscan key.
LOCAL_ENV="$LOCAL_REPO/scanners/.env"
[ -f "$LOCAL_ENV" ] || { echo "no local scanners/.env found; create one first"; exit 1; }
scp -q "$LOCAL_ENV" "$HOST:$REPO_DIR/scanners/.env"

echo "==> [4/4] booting stack"
ssh "$HOST" "cd $REPO_DIR/scanners && docker compose up -d --build"

ssh "$HOST" "cd $REPO_DIR/scanners && docker compose ps --format 'table {{.Name}}\t{{.Status}}'"
echo "==> done. logs: ssh $HOST 'docker compose -f $REPO_DIR/scanners/docker-compose.yml logs -f'"
