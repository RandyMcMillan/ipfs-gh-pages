#!/usr/bin/env bash
# Release the signed macOS app (adapted from dashboard.app/Release.sh).
#
# Signs the bundle (scripts/sign-app.sh), then optionally notarizes
# (notarytool submit --wait + stapler staple), repackages as
# ipfs-gh-pages-<tag>.zip, and uploads to a GitHub release.
#
# The tag/version comes from package.json — this repo's release tags are the
# npm-versioned ones (npm run release), not the crate's 0.1.0.
#
# Usage: scripts/release-app.sh [--check] [--notarize] [--apple-id EMAIL]
#          [--team-id TEAM] [--password PASS] [--tag TAG]
#
# Env: APPLE_ID, TEAM_ID, NOTARY_PASSWORD (or PASSWORD), SIGNING_IDENTITY,
#      GH_TOKEN (for the gh release step).

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

root="$(repo_root)"
cd "$root"

CHECK_ONLY=0
NOTARIZE=0
TAG=""
APPLE_ID="${APPLE_ID:-}"
TEAM_ID="${TEAM_ID:-}"
PASSWORD="${NOTARY_PASSWORD:-${PASSWORD:-}}"
SIGNING_IDENTITY="${SIGNING_IDENTITY:-}"

usage() {
  echo "Usage: $0 [--check] [--notarize] [--apple-id EMAIL] [--team-id TEAM] [--password PASS] [--tag TAG]" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --notarize) NOTARIZE=1 ;;
    --apple-id) shift; [[ $# -gt 0 ]] || usage; APPLE_ID="$1" ;;
    --team-id) shift; [[ $# -gt 0 ]] || usage; TEAM_ID="$1" ;;
    --password) shift; [[ $# -gt 0 ]] || usage; PASSWORD="$1" ;;
    --tag) shift; [[ $# -gt 0 ]] || usage; TAG="$1" ;;
    --signing-identity) shift; [[ $# -gt 0 ]] || usage; SIGNING_IDENTITY="$1" ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
  shift
done

VERSION="$(node -p "require('./package.json').version")"
if [[ -z "$VERSION" ]]; then
  echo "Unable to determine version from package.json." >&2
  exit 1
fi
if [[ -z "$TAG" ]]; then
  TAG="v${VERSION}"
fi

app_path="$(bundle_artifact_path ipfs-gh-pages "$(cargo_target_dir)/release/bundle/osx")"
if [[ -z "$app_path" || "$app_path" != *.app ]]; then
  echo "Missing bundled .app; run scripts/bundle.sh --build first." >&2
  exit 1
fi

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  SIGNING_IDENTITY="$SIGNING_IDENTITY" scripts/sign-app.sh
  codesign -dv --verbose=4 "$app_path" 2>&1 | sed -n '1,40p'
  codesign --verify --deep --strict --verbose=2 "$app_path"
  spctl --assess --type execute --verbose=4 "$app_path"
  exit 0
fi

if [[ "$NOTARIZE" -eq 1 && -z "$SIGNING_IDENTITY" ]]; then
  # Notarization requires Developer ID Application — make that explicit
  # rather than falling back to Apple Development.
  SIGNING_IDENTITY="$(security find-identity -v -p codesigning | awk '/Developer ID Application:/{print $2; exit}')"
  if [[ -z "$SIGNING_IDENTITY" ]]; then
    echo "No Developer ID Application identity found; notarization requires one." >&2
    exit 1
  fi
fi

SIGNING_IDENTITY="$SIGNING_IDENTITY" scripts/sign-app.sh

if [[ "$NOTARIZE" -eq 1 ]]; then
  [[ -n "$APPLE_ID" ]] || { echo "Missing --apple-id (or APPLE_ID)." >&2; exit 1; }
  [[ -n "$TEAM_ID" ]] || { echo "Missing --team-id (or TEAM_ID)." >&2; exit 1; }
  [[ -n "$PASSWORD" ]] || { echo "Missing --password (or NOTARY_PASSWORD)." >&2; exit 1; }

  build_dir="$root/build"
  mkdir -p "$build_dir"
  notarize_zip="$build_dir/ipfs-gh-pages-notarize.zip"
  ditto -c -k --keepParent "$app_path" "$notarize_zip"

  xcrun notarytool submit "$notarize_zip" \
    --apple-id "$APPLE_ID" \
    --team-id "$TEAM_ID" \
    --password "$PASSWORD" \
    --wait
  xcrun stapler staple "$app_path"
  codesign --verify --deep --strict --verbose=2 "$app_path"
  spctl --assess --type execute --verbose=4 "$app_path"
fi

build_dir="$root/build"
mkdir -p "$build_dir"
zip_name="$build_dir/ipfs-gh-pages-${TAG}.zip"
package_dir="$(mktemp -d)"
cp -R "$app_path" "$package_dir/ipfs-gh-pages.app"
ditto -c -k --keepParent "$package_dir/ipfs-gh-pages.app" "$zip_name"
rm -rf "$package_dir"

if gh release view "$TAG" >/dev/null 2>&1; then
  gh release upload "$TAG" "$zip_name" --clobber
else
  gh release create "$TAG" \
    --title "ipfs-gh-pages ${TAG}" \
    --generate-notes \
    "$zip_name"
fi

repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
echo "Release asset: https://github.com/${repo}/releases/download/${TAG}/$(basename "$zip_name")"
