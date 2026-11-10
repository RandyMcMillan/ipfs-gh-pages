#!/usr/bin/env bash
set -euo pipefail

# Watch the working tree with an IPFS node: ipfswatch embeds its OWN node —
# never run a separate `ipfs daemon` against the same repo (repo.lock).
# Ports are chosen to sit beside a stock Kubo (API 5001, gateway 8080;
# this repo's dev Kubo uses 5003/8082).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

REPO_PATH="$PROJECT_ROOT/.gnostr/.ipfs"
API_PORT="5002"
GATEWAY_PORT="8081"
WATCH_PATH="$PROJECT_ROOT"

# All ipfs commands address the repo through IPFS_PATH.
export IPFS_PATH="$REPO_PATH"

echo "=== Working Context ==="
echo "Project Root: $PROJECT_ROOT"
echo "Target Repo:  $REPO_PATH"
echo ""

if ! command -v ipfswatch >/dev/null 2>&1; then
  echo "ERROR: ipfswatch is not installed."
  echo ""
  echo "Install it with:"
  echo "go install github.com/ipfs/ipfswatch@latest"
  echo ""
  echo "Or with a prebuilt kubo distribution that ships ipfswatch:"
  echo "https://dist.ipfs.tech/#ipfswatch"
  exit 1
fi

echo "=== 1. Freeing port $API_PORT (previous run of this script) ==="
PID=$(lsof -ti :"$API_PORT" || true)
if [ -n "$PID" ]; then
  echo "Found process(es) $PID on port $API_PORT. Terminating..."
  kill $PID 2>/dev/null || true
  for i in 1 2 3 4 5; do
    sleep 1
    PID=$(lsof -ti :"$API_PORT" || true)
    [ -z "$PID" ] && break
  done
  if [ -n "$PID" ]; then
    kill -9 $PID 2>/dev/null || true
    sleep 1
  fi
  echo "Port $API_PORT freed."
else
  echo "No process on port $API_PORT."
fi

echo "=== 2. Clearing stale repo lock (only if no live holder) ==="
if [ -f "$REPO_PATH/repo.lock" ]; then
  LOCK_PID=$(lsof -t "$REPO_PATH/repo.lock" 2>/dev/null || true)
  if [ -n "$LOCK_PID" ]; then
    echo "repo.lock is held by live process(es) $LOCK_PID — NOT removing."
    echo "Stop that daemon first, or pick a different REPO_PATH."
    exit 1
  fi
  echo "Removing stale $REPO_PATH/repo.lock"
  rm -f "$REPO_PATH/repo.lock"
fi

echo "=== 3. Initializing the watch repo (first run only) ==="
if [ ! -f "$REPO_PATH/config" ]; then
  ipfs init
  echo "Repository initialized."
else
  echo "Repository already initialized."
fi

echo "=== 4. Configuring CORS + ports (API $API_PORT, gateway $GATEWAY_PORT) ==="
ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["https://webui.ipfs.io", "http://localhost:3001", "*"]'
ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods '["PUT", "GET", "POST"]'
ipfs config Addresses.API "/ip4/127.0.0.1/tcp/$API_PORT"
ipfs config Addresses.Gateway "/ip4/127.0.0.1/tcp/$GATEWAY_PORT"

echo "=== 5. Launching ipfswatch (its own node — no separate daemon) ==="
echo "Watching: $WATCH_PATH"
echo "Repo:     $REPO_PATH"
echo ""
exec ipfswatch -repo "$REPO_PATH" -path "$WATCH_PATH"
