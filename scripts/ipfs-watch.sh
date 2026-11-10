#!/usr/bin/env bash
set -euo pipefail

# Configuration variables
REPO_PATH=".gnostr/.ipfs"
API_PORT="5002"
GATEWAY_PORT="8081"
WATCH_PATH="."

echo "=== 1. Initializing IPFS repository at $REPO_PATH ==/="
if [ ! -d "$REPO_PATH" ]; then
    ipfs --repo-dir "$REPO_PATH" init
    echo "Repository initialized."
else
    echo "Repository already exists at $REPO_PATH."
fi

echo "=== 2. Configuring CORS headers for IPFS Web UI ==/="
ipfs --repo-dir "$REPO_PATH" config --json API.HTTPHeaders.Access-Control-Allow-Origin '["https://webui.ipfs.io", "http://localhost:3001", "*"]'
ipfs --repo-dir "$REPO_PATH" config --json API.HTTPHeaders.Access-Control-Allow-Methods '["PUT", "GET", "POST"]'

echo "=== 3. Setting custom ports (API: $API_PORT, Gateway: $GATEWAY_PORT) ==/="
ipfs --repo-dir "$REPO_PATH" config Addresses.API "/ip4/127.0.0.1/tcp/$API_PORT"
ipfs --repo-dir "$REPO_PATH" config Addresses.Gateway "/ip4/127.0.0.1/tcp/$GATEWAY_PORT"

echo "=== 4. Starting IPFS daemon with repo $REPO_PATH in background ==/="
export IPFS_PATH="$REPO_PATH"
ipfs daemon &
DAEMON_PID=$!

# Ensure background daemon cleans up if script exits
trap "kill $DAEMON_PID 2>/dev/null" EXIT

# Wait briefly for daemon to initialize API socket
sleep 3

echo "=== 5. Launching ipfswatch on path '$WATCH_PATH' ==/="
# Run ipfswatch pointing to the custom repo and path
ipfswatch -repo "$REPO_PATH" -path "$WATCH_PATH"
