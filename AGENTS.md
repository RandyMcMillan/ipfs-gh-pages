# Working Agreement

Rules the user has set. Follow them exactly.

## STOP means STOP

When the user says "stop" (in any tone, including all-caps or profanity),
halt immediately: no finishing the current edit, no "one last tool call,"
no cleanup. Acknowledge and wait for the next instruction.

## Incremental commits, never stacked changes

- Commit every change as soon as it is verified. Nothing sits uncommitted.
- Never layer new edits on top of uncommitted edits. If a change cannot be
  committed yet, stop and tell the user why — do not keep working.
- One topic per commit. If two topics touch the same file, split the hunks
  into separate commits.

## One topic at a time

Do not stack unrelated tasks in a single turn. Finish (and commit) the
current task before starting a new one, even when the new request is small.

## Never elide values

Never truncate, shorten, or ellipsis identifiers (CIDs, hashes, addresses,
URLs, peer IDs, commit SHAs) for display. Show the full value and let the UI
wrap it. The user will say explicitly if they ever want a shortened form.

## Commands in docs always get their own line

Every runnable command shown in UI text, help docs, or README gets its own
line (its own code block). Never append comments or prose to a command line,
and never bury a command inside a sentence.

## Push order is critical (submodules)

A superproject commit whose gitlink points at an UNPUSHED submodule commit
breaks every `submodules: recursive` checkout of that ref — CI dies inside
actions/checkout with "upload-pack: not our ref <sha>", far from the cause.
The order is always: submodule branch, submodule tag (releases), THEN the
superproject. Within the superproject, push the release TAG before MAIN:
the shared deploy workflow triggers on the main push and auto-detects the
newest `v*` tag — main first would deploy the previous release. Verify
before any superproject push:

```
node scripts/check-gitlink.mjs
```

Enforced by: `.githooks/pre-commit` (BLOCKS recording a gitlink bump
while the submodule commit is still unpushed — the state must never be
created), `.githooks/pre-push` (blocks default-branch pushes on an
unresolvable gitlink), `scripts/release.mjs` (runs the guard before
pushing main), and the CI workflows (guard step before submodule checkout,
so a violation fails with a clear message instead of a cryptic one).

# Design Objectives

1. **This project enables devs to publish repos to IPFS — other people must
   be able to clone them.** Every feature is judged against that sentence.

2. **Map GitHub functionality to its IPFS/libp2p counterparts in the web
   app.** The page replicates a GitHub repo view; for every GitHub concept
   (clone, star, fork, watch, releases, raw view, README…) the app shows
   the equivalent IPFS/libp2p mechanism — what it does today and what is
   still a gap. The page is both a tool and a map of the decentralized
   GitHub.

# Design Idioms

Page-wide patterns. Keep them; new UI gets them for free or not at all.

- **Commands**: every runnable command displayed on the page (a) gets its
  own line — its own `<pre>`, never prose-inline, (b) renders yellow (the
  attention token), (c) copies with one click — and the whole surrounding
  box is the click target, not just the text. Implemented once: the CSS
  block marked `DESIGN IDIOM — commands` in index.html and the delegated
  listener marked `DESIGN IDIOM — single-click copy` in main.js. Any plain
  `<pre><code>` in any panel inherits all three.
- **Live values**: if the page knows the real CID/hash/address, print it —
  never a placeholder when the data exists (pattern: `doc-pin-cmd`,
  `chip-car-export`, `issue-pin-cmd`). Repo metadata (branch/tag counts,
  stars, forks) is always fetched per-repo at runtime — this app is a
  plugin for ANY GitHub repo, so no repo-specific value may be hardcoded;
  when the API is unreachable, show nothing or a content-free placeholder
  (—), never a fake number, and never a static label that claims a value
  (user override: the branches/tags count links stay hidden until live
  data arrives).
- **Full values**: never truncate CIDs, hashes, peer IDs, URLs for display;
  let the UI wrap (user override: gitlink markers in the file tree use
  GitHub's `@<short>` convention next to the folder name).

# Release Procedure

Releases are cut with:

```
npm run release <semver>
```

`scripts/release.mjs` bumps the version, rewrites README action references,
commits, tags, and keeps the `actions-test` submodule in lockstep: it commits
pending submodule changes, pushes its branch, tags it with the same release
tag, and bumps the superproject gitlink. The fixture's
`actions-test/.github/workflows/deploy.yml` stays in lockstep with the
repo's own `.github/workflows/deploy-gh-pages.yml` (the single deploy
workflow this repo and its consumers share): `scripts/install-consumer-example.mjs`
installs one as the other on every release AND before every CAR build (it
is wired into the build script), so the fixture always consumes the
release being cut — the workflow auto-detects the newest `v*` tag, which
is that release once the tag is pushed. Do not cut a release unless the
user asks for one; a commit is just a snapshot, not a release.

Workflow/CI details and the consumer-contract gotchas (deploy workflow
shape, tag-before-main, the skipped-`needs` trap, pinning providers, CI
suite hangs, consumer testing) live in `.github/AGENTS.md`.
