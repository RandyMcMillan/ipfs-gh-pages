#!/bin/sh
# One-shot CAR seed: wait for Kubo, fetch the site's repo.car, and
# dag-import it so the sidecar serves the published repo tree. Endpoint
# forms proven by tests/kubo-alignment.test.mjs (multipart file arg,
# NDJSON Root.Cid response).
set -eu

API="${KUBO_RPC:-http://127.0.0.1:5001}"
WEB="${WEB_URL:-http://web}"

echo "kubo-init: waiting for ${API}"
until curl -sf "${API}/api/v0/version" >/dev/null 2>&1; do
  sleep 2
done
echo "kubo-init: kubo up"

if curl -sf "${WEB}/repo.car" -o /tmp/repo.car; then
  echo "kubo-init: repo.car $(wc -c < /tmp/repo.car) bytes"
  # Multipart file arg — kubo's dag/import rejects raw bodies.
  curl -sf -F "file=@/tmp/repo.car;type=application/vnd.ipld.car" \
    "${API}/api/v0/dag/import?stream-channels=true" | head -n 5
  echo "kubo-init: import complete"
else
  # Embedded-mode site (< EMBED_THRESHOLD_BYTES): files live in the bundle,
  # no CAR artifact is published. Nothing to seed — the app can still pin
  # its published root from the Code tab.
  echo "kubo-init: no repo.car (embedded-mode build) — nothing to seed"
fi
