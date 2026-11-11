#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

usage() {
  cat <<'EOF'
Usage: scripts/bundle.sh [--build] [--run] [--test] [--install [PATH]]

Builds the macOS app bundle for ipfs-gh-pages.
--run opens the bundled macOS app.
--test opens the bundled macOS app, curls the bundled index.html, and verifies the HTML.
--install copies the .app to PATH (default: /Applications, or ~/Applications
  if /Applications is not writable). Builds first if the bundle is missing.
EOF
}

build=false
run=false
test=false
install=false
install_path=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build)
      build=true
      shift
      ;;
    --run)
      run=true
      shift
      ;;
    --test)
      test=true
      shift
      ;;
    --install)
      install=true
      # Optional value: the next word, unless it is another flag.
      if [[ $# -gt 1 && "$2" != --* ]]; then
        install_path="$2"
        shift
      fi
      shift
      ;;
    --install=*)
      install=true
      install_path="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "$build" == false && "$run" == false && "$test" == false && "$install" == false ]]; then
  usage
  exit 1
fi

root="$(repo_root)"
cd "$root"

bundle_root="$(cargo_target_dir)/release/bundle"
bundle_name="ipfs-gh-pages"
bundle_app_path() {
  find "$bundle_root" -type d -name "${bundle_name}.app" -print -quit
}

build_bundle() {
  ensure_wasm_target
  ensure_cargo_bundle
  ensure_trunk

  node scripts/build-ipfs-js.mjs
  node scripts/build-repo-files.mjs
  trunk build --release --dist dist --html-output index-rust.html
  # cargo-bundle does not refresh Resources/ inside an existing .app —
  # wipe it so dist/ (and the icon) are copied fresh every build.
  rm -rf "${bundle_root:?}"
  cargo bundle --bin ipfs-gh-pages --release --features bundle-wry
}

ensure_bundle() {
  if [[ -z "$(bundle_app_path)" ]]; then
    build_bundle
  fi
}

run_bundle() {
  local app_path
  app_path="$(bundle_app_path)"
  if [[ -z "$app_path" ]]; then
    echo "Missing bundled app; run scripts/bundle.sh --build first." >&2
    exit 1
  fi

  open "$app_path"
}

test_bundle() {
  local app_path
  local html
  local app_pid=""
  local binary
  local log_file
  local url=""

  app_path="$(bundle_app_path)"
  if [[ -z "$app_path" ]]; then
    echo "Missing bundled app; run scripts/bundle.sh --build first." >&2
    exit 1
  fi

  binary="$app_path/Contents/MacOS/${bundle_name}"
  log_file="$(mktemp)"

  cleanup() {
    if [[ -n "$app_pid" ]] && kill -0 "$app_pid" >/dev/null 2>&1; then
      kill "$app_pid" >/dev/null 2>&1 || true
      wait "$app_pid" >/dev/null 2>&1 || true
    fi
    rm -f "$log_file"
  }

  trap cleanup EXIT

  # Run the binary directly so its stdout reaches us; the app binds an
  # ephemeral port and prints "Serving web UI at http://127.0.0.1:<port>".
  "$binary" >"$log_file" 2>&1 &
  app_pid=$!

  for _ in $(seq 1 60); do
    url="$(grep -oE 'http://127\.0\.0\.1:[0-9]+' "$log_file" | head -n 1 || true)"
    if [[ -n "$url" ]]; then
      break
    fi
    if ! kill -0 "$app_pid" 2>/dev/null; then
      echo "Bundled app exited early; output:" >&2
      cat "$log_file" >&2
      exit 1
    fi
    sleep 1
  done

  if [[ -z "$url" ]]; then
    echo "Timed out waiting for the app's serving URL; output:" >&2
    cat "$log_file" >&2
    exit 1
  fi

  for _ in $(seq 1 60); do
    if html="$(curl -fsS "$url" 2>/dev/null)"; then
      break
    fi
    sleep 1
  done

  if [[ -z "${html:-}" ]]; then
    echo "Timed out waiting for $url" >&2
    exit 1
  fi

  printf '%s' "$html" | grep -F '<title>Ratzilla Demo</title>'
  js_path="$(printf '%s' "$html" | grep -oE "./[^']+\.js" | head -n 1)"
  wasm_path="$(printf '%s' "$html" | grep -oE "./[^']+_bg\.wasm" | head -n 1)"
  curl -fsS "$url/${js_path#./}" >/dev/null
  curl -fsS "$url/${wasm_path#./}" >/dev/null

  cleanup
  trap - EXIT
  printf 'Verified %s\n' "$url"
}

if [[ "$build" == true ]]; then
  build_bundle
fi

if [[ "$run" == true ]]; then
  ensure_bundle
  run_bundle
fi

if [[ "$test" == true ]]; then
  ensure_bundle
  test_bundle
fi

install_bundle() {
  local app_path
  local dest
  local target

  app_path="$(bundle_app_path)"
  if [[ -z "$app_path" ]]; then
    echo "Missing bundled app; run scripts/bundle.sh --build first." >&2
    exit 1
  fi

  if [[ -n "$install_path" ]]; then
    dest="$install_path"
  elif [[ -w /Applications ]]; then
    dest="/Applications"
  else
    dest="$HOME/Applications"
  fi

  # A path ending in .app is the exact target; anything else is a directory.
  if [[ "$dest" == *.app ]]; then
    target="$dest"
  else
    mkdir -p "$dest"
    target="$dest/${bundle_name}.app"
  fi

  rm -rf "$target"
  cp -R "$app_path" "$target"
  echo "Installed ${bundle_name}.app to $target"
}

if [[ "$install" == true ]]; then
  ensure_bundle
  install_bundle
fi
