# ipfs-gh-pages

Agent orientation for this repo: what the project is, how it is built and
tested, how it is organized, and the working rules. Two more files complete
the picture — read `docs/STATUS.md` first on any restart (phase handoff,
what is done, what is next) and `.github/AGENTS.md` for CI and
consumer-contract gotchas earned the hard way. This file is the top-level
contract.

## Project overview

One protocol, three surfaces:

1. **Pages app** — a browser-based IPFS node built with Helia that runs
   entirely on GitHub Pages. `index.html` + `main.js` replicate a GitHub
   repo view; on load the page adds every repository file to IPFS, shows
   the root CID, and offers a browsable file tree, per-file CIDs, content
   fetch, download, and arbitrary publish/fetch. Live demo:
   https://randymcmillan.github.io/ipfs-gh-pages/
2. **Rust app** — the same functionality behind a ratzilla (ratatui in the
   browser, wasm32) TUI with a wry desktop bundle of the same crate,
   rendered as a GitHub web-UI lookalike: Primer dark theme, repo chrome
   (owner/name, Public badge, Watch/Star/Fork, orange-underline tabnav),
   11 GitHub-vocabulary tabs (Code, Issues, Pulls, Actions, Projects, Wiki,
   Security, Insights, Settings, Peer, Publish). It does not reimplement
   IPFS: it drives the shared JS backend over two `window` channels, and
   `scripts/build-ipfs-js.mjs` bakes the repo's files, README, git meta,
   workflows, and tags into the bridge bundle for the Code/Actions/Publish
   views.
3. **Reusable GitHub Action** (`action.yml`, composite) — any repo can
   build and deploy its own copy of the app embedding its own files with a
   few lines of workflow YAML.

Design objectives — judge every feature against these:

1. This project enables devs to publish repos to IPFS — other people must
   be able to clone them.
2. Map GitHub functionality to its IPFS/libp2p counterparts in the web
   app: for every GitHub concept (clone, star, fork, watch, releases, raw
   view, README…) the app shows the equivalent IPFS/libp2p mechanism —
   what it does today and what is still a gap. The page is both a tool and
   a map of the decentralized GitHub.

Identity: npm package `helio-ipfs-github-pages` (version 4.0.1 at the time
of writing — check `package.json` / `git tag`), Rust crate
`ipfs-gh-pages` 0.1.0, MIT license, upstream
git@github.com:RandyMcMillan/ipfs-gh-pages.git.

## Repository layout

- `index.html` — the app shell: GitHub-style header plus tabs (Code,
  Issues, Pulls, Actions, Projects, Wiki, Security, Insights, Settings,
  Peer, Publish). Also carries the `DESIGN IDIOM — commands` CSS block.
- `main.js` — the app entry: owns the in-page Helia node and all DOM
  rendering and wiring. Large on purpose; feature logic lives in `js/`.
- `js/` — feature modules imported by `main.js`, kept pure (no DOM, no
  network; dependencies injected) so they run under `node:test`:
  `git-objects.js` (loose+pack+delta object reader), `git-upload-pack.js`
  (in-process smart-HTTP server), `git-smart.js` (isomorphic-git transport
  over it), `github-issues.js` (GitHub ↔ signed-notes bridge),
  `github-auth.js` (OAuth device flow), `ipfs-node.js` (the bridge backend
  for the Rust TUI), `kubo.js` (local Kubo RPC probe + CAR hand-off),
  `blame.js`, `line-comments.js`, `cid-links.js`, `markdown.js`,
  `rehost.js`, `camo-fetch.js`, `index-merge.js`.
- `lib/shared.mjs` — pure helpers shared by `main.js` and the unit tests
  (base64, size formatting, repo-tree build, address normalization).
- `public/theme-init.js` — theme bootstrap; externalized precisely so the
  CSP meta `script-src 'self'` holds.
- `index-rust.html` — Trunk target for the Rust TUI. Must stay at the repo
  root (Trunk canonicalizes the target path).
- `src/` — the Rust crate: `main.rs` (three cfg-gated build modes),
  `app.rs` (TUI state: GitHub-vocab tabs, list cursors, inputs, pending
  commands), `backend.rs` (ratzilla DOM/Canvas/WebGL2 backends), `ipfs.rs`
  (typed poll/cmd bridge to `window.__ipfsState` / `window.__ipfsCmd`),
  `theme.rs` (Primer dark palette + shared style helpers — all visual
  styling imports from here), `ui.rs` (chrome + tab renderers), `effects.rs`
  (tab-transition/startup sweeps), `fps.rs`, `utils.rs`, `cli.rs` +
  `wry_app.rs` (native-only, cfg-gated).
- `scripts/` — build/release/pinning/Kubo tooling (`.mjs` and `.sh`):
  `build-car.mjs` (CAR archives + `repo-manifest.json`, streaming, bounded
  RAM), `build-ipfs-js.mjs` (esbuild bundle of `js/ipfs-node.js`),
  `index-walk.mjs` (issues-index DAG collector), `install-consumer-example.mjs`
  (fixture workflow lockstep), `release.mjs`, `check-gitlink.mjs`,
  `pinata-pin.mjs`, `filebase-pin.mjs`, `rehost-service.mjs`,
  `test-e2e.mjs` (the CI e2e runner), `ci-chrome.mjs`, `bundle.sh`,
  `deploy.sh`, `sign-app.sh`, `release-app.sh`, `wss-proxy.mjs`,
  `cert-generate.mjs`, kubo-config-*.mjs, `lib/` (`repo-files.mjs`,
  `repo-info.mjs`, `nvidia-chat.mjs`).
- `tests/` — `*.test.mjs` unit suites (run with `node --test`), `cdp-*.mjs`
  headless-Chrome integration suites (raw DevTools Protocol),
  `utils.mjs` (shared CDP launcher + `check`/`finish` helpers),
  `fixtures/` (`interop-vectors.json`, `stego/` carriers).
- `docs/` — design docs (see Documentation map below); `STATUS.md` is the
  handoff contract, updated at every release.
- `.github/workflows/` — CI (see CI and deployment); `.github/actions/test-setup/`
  — composite CI environment setup.
- `.githooks/` — versioned hooks (`pre-commit`, `pre-push`, `post-merge`,
  `lib.sh`); activate with `npm run githooks:activate`.
- `actions-test/` — git submodule, the fixture repo for per-submodule CAR
  builds (its `.car` artifacts are ignored: `ignore = untracked` in
  `.gitmodules`).
- `dist/` — build output (gitignored): vite bundle, Trunk wasm artifacts,
  `ipfs-gh-pages.car`, `repo-manifest.json`, `404.html`.
- `certs/` — local TLS material for `npm run proxy:wss` (gitignored).
- `icons/` — macOS bundle icons. `assets/` — logos and generated
  snapshots. `cdp-provide.mjs` / `cdp-routing.mjs` — root-level debug
  scripts for the share-link dial path. `deploy-gh-pages.yml` at the repo
  root is a symlink to `.github/workflows/deploy-gh-pages.yml`.

## Technology stack

- Node.js ≥ 26 (`engines` in `package.json`, `.nvmrc` = 26.13.0), pure ESM
  (`"type": "module"`), npm with a committed lockfile — install with
  `npm ci`.
- Vite 5, vanilla JS, no UI framework; `@primer/css` (GitHub's design
  system) for the GitHub look.
- IPFS/libp2p in the browser: `helia` 5, `@helia/unixfs`, `@helia/strings`,
  `@helia/ipns`, `@helia/verified-fetch`, `@helia/car`,
  `@chainsafe/libp2p-gossipsub`, `@libp2p/pubsub-peer-discovery`,
  `@multiformats/multiaddr`.
- Git in the browser: `isomorphic-git` + `@isomorphic-git/lightning-fs`.
- Markdown: `marked` (GFM) + `dompurify`; zip: `fflate`.
- Rust: edition 2021. `ratzilla` 0.3 (ratatui TUI on wasm), `tachyonfx`
  effects, `wasm-bindgen`/`js-sys`. Native-only, behind the `bundle-wry`
  cargo feature and `cfg(not(target_arch = "wasm32"))`: `wry`, `tao`,
  `muda`, `clap`, `image`, `tray-icon`. Trunk drives the wasm build
  (`Trunk.toml`); `cargo-bundle` makes the desktop app.
- Tests: `node:test` for unit suites; headless Chrome driven over the raw
  Chrome DevTools Protocol (the `ws` package — no test framework) for
  integration; Chrome for Testing supplied by `scripts/ci-chrome.mjs`.

## Architecture

### Build-time data bridge (vite virtual modules)

`vite.config.js` carries four plugins that bake deploy-time data into the
bundle:

- `virtual:repo-files` + `virtual:repo-mode` — the repo file set. Total ≤
  `EMBED_THRESHOLD_BYTES` (20 MiB, `scripts/lib/repo-files.mjs`): contents
  are base64-inlined (`embedded` mode, zero fetches). Larger repos switch
  to `car` mode: contents stay out of the bundle and the app reads paths +
  CIDs from `dist/repo-manifest.json` and bytes from `dist/repo.car`,
  both written by `scripts/build-car.mjs` (same threshold, streaming
  through a disk blockstore).
- `virtual:repo-identity` — owner/name/version/tagVersion/default branch/
  last commit, resolved from `GITHUB_REPOSITORY`, the git remote,
  `REPO_TAG_VERSION`, and `git describe`.
- `virtual:repo-submodules` — recursive gitlink map `{path: {sha, url}}`
  for the GitHub-style submodule rows.
- `virtual:repo-live-info` — GitHub API repo metadata fetched at build
  time (`GITHUB_TOKEN` makes it authenticated and quota-free).

File-set semantics, defined once in `scripts/lib/repo-files.mjs`: the
superproject's tracked files plus, recursively, each checked-out
submodule's tracked files flattened as `<sub>/<file>`. The vite plugin,
`build-car.mjs`, and `repo-manifest.json` must all agree — change the walk
in one place.

### Runtime

- `main.js` owns the in-page Helia node (gossipsub + pubsub discovery,
  IPNS, CAR export/import, verified fetch) and all DOM rendering. Section
  banners mark subsystems; the `DESIGN IDIOM` markers show the page-wide
  patterns.
- Feature logic is pure modules under `js/`; `main.js` owns rendering and
  wiring. New features follow this split and cite their design doc in the
  module header.
- The Rust TUI polls `window.__ipfsState` (plain JSON, every frame) and
  issues `window.__ipfsCmd(id, op, arg)`; async results land in
  `__ipfsState.results[id]`. `js/ipfs-node.js` owns the node behind that
  API and is bundled separately by `scripts/build-ipfs-js.mjs` into
  `assets/ipfs-node.js`, which `index-rust.html` loads. Cross-surface
  parity is a hard contract: same `repoFullName` derivation, same
  localStorage identity key, same gossip topics, same blocklist, same
  bootstrap list.
- Desktop: same crate with `--features bundle-wry` (`scripts/bundle.sh`
  runs build-ipfs-js + build-repo-files + trunk + cargo bundle); clap CLI
  `--host/--port/--serve-dir/--url/--kubo/--repo/--systray`; tray via the
  `tray-icon` crate (NOT tao — tao 0.35 dropped tray); interop loopback
  server on port 5050.

### Identity and data model

- One Ed25519 identity key per `repoFullName`, stored in localStorage as
  `ipns-branch-key:<repo>`; notes and chat are P7-signed dag-json;
  signatures verify across both surfaces.
- gossipsub topics `repo-gossip:<repo>` and `repo-gossip:<repo>:chat`;
  blocklist in localStorage `blocked-peers`.
- Issues are signed notes on a hash-chained index living under its OWN
  IPNS name, `ipns-index-key:<repo>` — one IPNS name = one value; never
  reuse the branch key. Multi-writer sync merges via
  `js/index-merge.js` `classifyIndexSync` (genesis / fast-forward either
  way / two-parent union, OR-Set semantics).
- Git bridge: `.githooks/pre-push` writes the index tip CID as git notes
  under `refs/notes/<owner>/<repo>/index` on every pushed commit (never
  blocks the push); `post-merge` reads the fetched note back. Plain
  `git notes --ref=<ns> show <sha>` reads them.
- Git-over-IPFS: `js/git-objects.js` reads loose objects, packfiles with
  OFS/REF deltas, and refs from an in-memory bare-repo tree;
  `js/git-upload-pack.js` speaks the smart-HTTP protocol in-process;
  `js/git-smart.js` adapts it to isomorphic-git. Real `git clone` /
  `git pull` run through this.
- Release chain: each publish of a repo root records a
  `{type:'release', root, prev, timestamp}` dag-json link
  (`repo-release-chain`); blame attributes each line to the oldest
  release containing it.

## Build and run commands

```bash
npm ci                # install (lockfile is committed)
npm run dev           # vite dev server → http://localhost:5173
npm run build         # vite build + fixture workflow lockstep + CAR build → ./dist
npm run build:action  # consumer path: build + CAR only, no fixture lockstep
npm run preview       # serve the production bundle
```

```bash
cargo check --target wasm32-unknown-unknown
cargo check --features bundle-wry
./scripts/bundle.sh --build   # build-ipfs-js + build-repo-files + trunk + cargo bundle
cargo fmt                     # CI enforces: cargo fmt --check
```

Useful environment variables: `REPO_ROOT` (build as-if another repo —
consumer testing), `OUT_DIR`, `GITHUB_TOKEN` (authenticated repo-info
bake), `REPO_TAG_VERSION`, `VERBOSE=1`, `TEST_URL`, `CHROME_PATH`,
`KUBO_RPC`, `INDEX_GATEWAYS`, `INDEX_TIPS`.

Kubo helpers: `npm run kubo:browser`, `npm run kubo:ws`, `npm run kubo:wss`,
`npm run kubo:webrtc`, `npm run kubo:id`, `npm run proxy:wss`,
`npm run cert:generate`.

## Testing

Two layers, both under `tests/`:

1. **Unit suites** — `node --test tests/<name>.test.mjs`. Pure logic: no
   DOM, no network; fetches and stores are injected. Every `js/` module
   and `lib/shared.mjs` has one.
2. **CDP suites** — `tests/cdp-*.mjs`. Headless Chrome driven over a raw
   DevTools Protocol WebSocket (`tests/utils.mjs`: `launchChrome`,
   `check`, `finish`). Each suite boots its own Chrome on its own debug
   port and drives the real app at `TEST_URL` (default
   http://127.0.0.1:5173).

```bash
npm run test:unit     # pure functions only, no browser needed
npm run test          # = test:all — every unit suite, then every CDP suite (needs Chrome)
npm run test:ci       # test-e2e.mjs: ensures Chrome, starts the dev server, runs the
                      # suites individually with per-suite timeouts, tears down
npm run test:deployed # the whole suite against the live Pages deployment
```

`npm run test:ci` parses the suite list out of `package.json`'s `test:all`
— it is never duplicated, so the two cannot drift. Set `CHROME_PATH` if
Chrome is not auto-detected; `VERBOSE=1` for chatty output.

Rules that keep the suite healthy:

- Suites that spin up Helia nodes carry the deterministic-exit shim
  `after(() => setTimeout(() => process.exit(0), 500).unref())` — libp2p
  can leave dangling dials that hang `node --test` after every test passed
  (the story is in `.github/AGENTS.md`). Replicate it in any new suite
  that shows the same flake.
- Suites run individually under the e2e runner, never chained into one
  long process — a wedged suite must fail with its own name in the log.
- Fixtures are real: genuine CIDs, URLs, and payloads
  (`tests/fixtures/interop-vectors.json`); assertions must be shaped so a
  placeholder could never pass.

## CI and deployment

Workflows in `.github/workflows/`:

- `deploy-gh-pages.yml` — THE deploy workflow. This repo dogfoods it,
  consumers copy it verbatim as their own `deploy.yml`, and the
  `actions-test` fixture installs it in lockstep. Deploys on every
  default-branch push, re-checks daily (cron `23 3 * * *`) so a new action
  release self-deploys, and accepts a manual pin via `workflow_dispatch`.
  Shape, marker-cache gate, and gotchas: `.github/AGENTS.md`.
- `release.yml` — on `v*` tags: test, build, archive `./dist` as
  `dist.zip`, attach it to the GitHub Release. Only runs when the test job
  passed, which is why tags alone don't create Releases.
- `action-smoke.yml` — on every main push / PR: submodule gitlink guard,
  submodule checkout, packaging build; plus a `rust-smoke` job
  (`cargo fmt --check` and both cargo checks, pinned `ubuntu-24.04` with
  the webkit2gtk/gtk/soup apt set) and an `ai-smoke` job.
- `deployed-smoke.yml` — post-deploy smoke: two headless nodes must
  discover each other on the live page.
- `ai-triage.yml`, `test-with-ai.yml` — NVIDIA-AI triage/review of runs
  (optional accelerants).

The reusable action (`action.yml`, composite action) inputs:
`node-version` (default `26`), `repo-root`, `out-dir`, `deploy`,
`run-tests`, `pinata-jwt`, `filebase-access-key-id`,
`filebase-secret-access-key`, `filebase-bucket`. Optional pinning services
warn and never fail the build. NEVER reference `${{ secrets.* }}` inside
`action.yml` — `secrets` is not a valid context in action metadata and
breaks every `uses: ./` step; `tests/action-metadata.test.mjs` guards this.

## Security considerations

- CSP meta `script-src 'self'` — keep all JS in external files
  (`public/theme-init.js` exists precisely for this); no inline handlers.
- All repo-rendered markdown passes marked → DOMPurify (≥3.2.4,
  namespace-aware) → a DOM rewrite pass; network content renders in
  sandboxed iframes; SVG is `<img>`-only. Policy decisions live in
  `docs/markdown-rendering.md`.
- Secrets are never printed or embedded in error text; JWT and S3 keys
  travel by environment variable only. Optional services (pin providers,
  Kubo hand-off, GitHub sync) degrade their own status line and never take
  the core flow down — `docs/optional-services.md`: services are
  accelerants, never dependencies.
- `certs/`, `dist/`, downloaded `chrome/`, and `payload.json` stay
  gitignored.
- The stego carriers in `tests/fixtures/stego/` are attack-vector proof of
  concept fixtures for the markdown image-policy work — data, not
  executables.

## Code style and conventions

- ESM everywhere; Node-side files use `.mjs`. Vanilla DOM + `@primer/css`;
  no framework and no build-time type checking on the JS side.
- Pure logic belongs in `js/` modules (or `lib/shared.mjs`) with a
  `node:test` suite; cite the governing design doc in the module header —
  that is the established convention (see any `js/*.js` header).
- `js/ipfs-node.js` is bundled separately by esbuild and cannot import
  `lib/shared.mjs`; it re-implements the few helpers it needs behind a
  `parity:` comment. Keep the two in sync when touching either.
- Identity resolution has two mirrors that must stay in lockstep:
  `vite.config.js`'s `resolveIdentity` and `scripts/build-ipfs-js.mjs`'s
  `--define` injection.
- Rust: run `cargo fmt` before committing (CI checks `cargo fmt --check`);
  anything outside `wasm32` stays behind
  `cfg(not(target_arch = "wasm32"))` or the `bundle-wry` feature so the
  Trunk/wasm build never pulls wry/tao/muda.
- Commit messages: short imperative with a lowercase area prefix (`ci:`,
  `scripts:`, `tests:`, `wiki:`, `projects:`, `pulls:`, `docs:`) or a bare
  `vX.Y.Z` release commit.
- Never hardcode repo-specific values in the page; anything identity-like
  is baked at build time or fetched live (see Design Idioms).

## Documentation map

- `docs/STATUS.md` — restart handoff: architecture summary, done/next by
  phase, standing orders. Update at every release. (Its "Last release"
  line lags reality sometimes — trust `git tag` for the newest release.)
- `docs/issues-car.md` — issues/notes/index-chain design (phases through
  blame and the git-notes bridge).
- `docs/git-over-ipfs.md` — in-process git smart protocol design.
- `docs/rust-js-bridge.md` — the `__ipfsState`/`__ipfsCmd` bridge contract.
- `docs/interop.md` — Pages app ↔ dev server ↔ Rust app identity sharing.
- `docs/markdown-rendering.md`, `docs/ipfs-rehost-service.md`,
  `docs/ipfs-uri-providers.md`, `docs/optional-services.md` — rendering
  policy, rehost service, URI/provider integration, the optional-services
  constraint.
- `docs/brig-ideas.md`, `docs/git-over-ipfs.md` (header note) — reference
  notes; some doc headers are older than the code they describe, STATUS.md
  is the arbiter of what actually shipped.

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
current task before starting a new one, even when the new request is
small.

## Never elide values

Never truncate, shorten, or ellipsis identifiers (CIDs, hashes, addresses,
URLs, peer IDs, commit SHAs) for display. Show the full value and let the
UI wrap it. The user will say explicitly if they ever want a shortened
form.

## Commands in docs always get their own line

Every runnable command shown in UI text, help docs, or README gets its
own line (its own code block). Never append comments or prose to a command
line, and never bury a command inside a sentence.

## Never push without an explicit order

`git push` (and any other remote or destructive action) runs only when
the user explicitly says so. Never infer permission from an earlier task
or a standing goal — work stays local until told otherwise. After any
push, check CI in the background
(https://github.com/RandyMcMillan/ipfs-gh-pages/actions) and report when
it lands — never block on sleeps.

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
