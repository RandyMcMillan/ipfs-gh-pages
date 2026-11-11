#!/usr/bin/env bash
# Sign the bundled macOS app (adapted from dashboard.app/sign.sh).
#
# cargo-bundle output is already a clean Contents-only bundle, so unlike
# the dashboard flow no staging dance is needed — sign in place so
# bundle.sh --install picks up the signed app.
#
# Identity: SIGNING_IDENTITY env wins; otherwise Developer ID Application
# (required for notarization/gatekeeper distribution), falling back to
# Apple Development for local testing.

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

root="$(repo_root)"
cd "$root"

# The osx/ subdir holds only the .app (the dmg lives in dmg/) — the generic
# helper would otherwise prefer the dmg on Darwin.
app_path="$(bundle_artifact_path ipfs-gh-pages "$(cargo_target_dir)/release/bundle/osx")"
if [[ -z "$app_path" || "$app_path" != *.app ]]; then
  echo "Missing bundled .app; run scripts/bundle.sh --build first." >&2
  exit 1
fi

SIGNING_IDENTITY="${SIGNING_IDENTITY:-}"
if [[ -z "$SIGNING_IDENTITY" ]]; then
  SIGNING_IDENTITY="$(security find-identity -v -p codesigning | awk '/Developer ID Application:/{print $2; exit}')"
fi
if [[ -z "$SIGNING_IDENTITY" ]]; then
  SIGNING_IDENTITY="$(security find-identity -v -p codesigning | awk '/Apple Development:/{print $2; exit}')"
fi
if [[ -z "$SIGNING_IDENTITY" ]]; then
  echo "No Developer ID Application or Apple Development identity in the keychain." >&2
  echo "Set SIGNING_IDENTITY or install a certificate." >&2
  security find-identity -v -p codesigning >&2
  exit 1
fi

echo "Signing $app_path with $SIGNING_IDENTITY"
xattr -cr "$app_path"
codesign --force --deep --sign "$SIGNING_IDENTITY" --options runtime "$app_path"
codesign --verify --deep --strict --verbose=2 "$app_path"
echo "Signed: $app_path"
