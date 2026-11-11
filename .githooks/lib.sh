# Shared helpers for the ipfs-gh-pages git-host bridge (docs/issues-car.md
# "Git-host bridge (hooks)", phase 12). Sourced by pre-push and post-merge;
# not a hook itself.
#
# The bridge carries the issues-index tip CID through plain git refs, so any
# git host is a free mirror: outbound (pre-push) writes the tip as a git
# note under refs/notes/<owner>/<repo>/index — the native SHA-keyed notes
# layout, readable by plain `git notes`, git-appraise, git-bug — inbound
# (post-merge) reads a fetched note and hands the tip CID to the app.

# Notes namespace: <owner>/<repo>, derived from the origin remote so every
# fork of the same repo shares one namespace. Override with
#   git config ipfs.repo owner/repo
ipfs_notes_namespace() {
  local full url
  full=$(git config ipfs.repo 2>/dev/null || true)
  if [ -z "$full" ]; then
    url=$(git remote get-url origin 2>/dev/null || true)
    case "$url" in
      *://*/*) full=${url#*://*/} ;;
      *:*)     full=${url#*:} ;;
    esac
    full=${full%.git}
    full=${full#/}
  fi
  # A refname component cannot contain whitespace, "..", or start with "/".
  case "$full" in
    ''|*..*|*' '*|*'	'*) full=$(basename "$(git rev-parse --show-toplevel)") ;;
  esac
  printf '%s/index' "$full"
}

# Resolve the current canonical index tip CID. First source wins:
#   1. IPFS_INDEX_TIP env (per-invocation override, tests)
#   2. $(git rev-parse --git-path ipfs-index-tip) — written via the export
#      command the app shows under the index chain status
#   3. git config ipfs.indexTip (static override)
#   4. git config ipfs.indexName resolved through a local Kubo daemon
# Prints the CID; exits 1 when nothing resolves.
ipfs_index_tip() {
  local tip f name
  if [ -n "${IPFS_INDEX_TIP:-}" ]; then
    printf '%s' "$IPFS_INDEX_TIP"
    return 0
  fi
  f=$(git rev-parse --git-path ipfs-index-tip 2>/dev/null || true)
  if [ -n "$f" ] && [ -f "$f" ]; then
    tip=$(head -n 1 "$f" | tr -d '[:space:]')
    if [ -n "$tip" ]; then
      printf '%s' "$tip"
      return 0
    fi
  fi
  tip=$(git config ipfs.indexTip 2>/dev/null || true)
  if [ -n "$tip" ]; then
    printf '%s' "$tip"
    return 0
  fi
  name=$(git config ipfs.indexName 2>/dev/null || true)
  if [ -n "$name" ] && command -v ipfs >/dev/null 2>&1; then
    tip=$(ipfs name resolve --nocache "$name" 2>/dev/null | sed 's|^/ipfs/||' || true)
    if [ -n "$tip" ]; then
      printf '%s' "$tip"
      return 0
    fi
  fi
  return 1
}
