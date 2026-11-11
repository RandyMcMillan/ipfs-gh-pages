# STATUS — read this first on restart

Last release: **v2.7.8** (all tags pushed, main in sync, actions-test
lockstep). This file is the handoff contract; the docs below carry the
design detail. Update it at every release.

## Architecture in one paragraph

Three surfaces share one protocol. **Pages** (`main.js`, vite → GitHub
Pages) is the mature GitHub-style app. **rust** (`src/`, ratzilla TUI +
wry desktop bundle) hosts 14 TUI tabs and the native app. They meet in
the page: the bridge backend (`js/ipfs-node.js`, esbuild-bundled to
`assets/ipfs-node.js`) owns the Helia node; Rust drives it over
`window.__ipfsState` (polled per frame in `on_tick`) and
`window.__ipfsCmd(id, op, arg)` (async results keyed by id). Identity:
one Ed25519 key per `repoFullName` (`ipns-branch-key:<repo>`), notes are
P7-signed dag-json, gossipsub topics are `repo-gossip:<repo>`(+`:chat`).

## Build/test commands

- Rust checks: `cargo check --target wasm32-unknown-unknown` + `cargo check --features bundle-wry`
- Bundle build: `./scripts/bundle.sh --build` (runs build-ipfs-js.mjs + build-repo-files.mjs + trunk + cargo bundle)
- JS bundle only: `node scripts/build-ipfs-js.mjs` (inject repo identity via --define)
- Web app: `npm run dev` / `npm run build` (installs consumer.example.yml → actions-test/.github/workflows/deploy.yml in lockstep via `install:consumer-example`, then rebuilds actions-test.car — snapshot the submodule before releasing)
- Tests: `npm run test:all` — unit, car, index-merge (5), index-walk (3), line-comments (4), blame (6), cid-links (4), interop-vectors (3+1 skip), pinata-pin (5), git-notes-bridge (7), check-gitlink (7), install-consumer-example (5), git-objects (14), git-upload-pack (4), git-clone-smart (2), git-pull-smart (2), then CDP suite (incl. cdp-git-bridge, cdp-cid-links, cdp-interop-vector)
- Release (ONLY when user orders): `npm run release <semver>` — refuses on dirty tree; snapshot `actions-test.car` first if `npm run build` ran
- Sign/release app: `scripts/sign-app.sh`, `scripts/release-app.sh [--notarize]`

## Done (by plan)

- **Bridge plan** (`docs/rust-js-bridge.md`): phases 1–8, 11. Tabs: IPFS, Peers, Fetch, Publish, Chat, Kubo (generic `kubo.rpc` = full API), Services, Git, Repo, Issues. `:` bar = vim command line (whole op surface; `kubo <m> <args>`, second token passes as `sha`).
- **Phase 9 git clone** (`docs/git-over-ipfs.md`): COMPLETE. `js/git-objects.js` (loose+pack+delta reader), `js/git-upload-pack.js` (in-process smart protocol; real git clones through it, fsck-clean), `js/git-smart.js` (isomorphic-git transport), `git.cloneSmart`/`git.pullSmart`/`git.clones` (lightning-fs, IndexedDB, incremental). TUI Git tab: c/s/u/a/l.
- **Phase 10 issues** (`docs/issues-car.md`): index on its OWN IPNS name (`ipns-index-key:<repo>` — branch pointer uses the repo key; one name = one value). `extendChain` publishes tip. Cross-surface sync in both surfaces; **multi-parent merge** via shared `js/index-merge.js` `classifyIndexSync` (genesis/ff-either-way/two-parent union). Bridge ops `issues.create`/`issues.sync`; TUI Issues tab (i/s). Issues CAR bundle walk (phase 6): `scripts/index-walk.mjs` walks tip → entries (`prev`) + notes (`added`, comment `parent` links; anchors NOT followed) into the blockstore; `build-car.mjs --index-tip <cid>` (repeatable) or `INDEX_TIPS=<cid,cid>` stages via Kubo RPC (KUBO_RPC) then trustless gateways (INDEX_GATEWAYS) — never fatal; CAR roots = repo root + resolved tips, partial tips bundled but not rooted. Line comments (phase 9, web app): select blob lines → signed `line-comment` note `{ns:'review', anchors:[fileCid], line:{start,end}}` via `js/line-comments.js` helpers (pure, unit-tested); gutter markers + tinted rows, composer, verified-comment panel; CDP-covered (cdp-line-comments). Root chain + blame (phases 10-11, web app): `recordRelease` in `addAllRepoFiles` writes `{type:'release', root, prev, timestamp}` dag-json per new root (dedup on republish; tips in `repo-release-chain`, genesis = current root); Blame toggle attributes each line to the OLDEST release containing it (multiset-exact line-text match, file-CID-diff fetch skip; `js/blame.js` pure, unit-tested), origin column doubles as the blame-comment affordance — signed `{ns:'review', type:'blame-comment', anchors:[fileCid], line:{start}, origin}` notes that ride the line across later versions (`blameCommentMatches`); CDP-covered (cdp-blame). TUI/bridge parity for line/blame comments: not built (web app only, like the rest of review UI).
- **Git-host bridge** (`docs/issues-car.md` phase 12): `.githooks/` (versioned, activated per clone by `npm run githooks:activate` → `core.hooksPath`). Outbound `pre-push`: resolves the index tip (`IPFS_INDEX_TIP` env → `.git/ipfs-index-tip` export file the app shows under the chain status → `ipfs.indexTip` config → `ipfs.indexName` via Kubo), writes it as a note on every pushed commit under `refs/notes/<owner>/<repo>/index` — native SHA-keyed notes layout, readable by plain `git notes --ref=<ns> show <sha>`; never blocks the push; prints the one-time `+refs/notes/*:refs/notes/*` refspec setup. Inbound `post-merge`: reads the fetched note on HEAD / HEAD^2, prints the full tip CID + `ipfs pin add`, records it in `.git/ipfs-index-tip-incoming`. App side: Issues panel gains "Sync index tip" (`syncIndexFromTip`, refactored out of `syncIndexFromIpns`; note union now also happens on chain-noop, OR-Set semantics) — the paste hand-off a CLI hook can't do into a tab. Unit-tested against real git (`git-notes-bridge`, 7), CDP-covered (cdp-git-bridge).
- **Release tag identity**: the header "latest release" chip bakes from the repo's latest git tag — `git describe --tags --abbrev=0` at REPO_ROOT in vite.config.js's `resolveIdentity` (`REPO_TAG_VERSION` env overrides without git); the chip prefers `tagVersion`, the action's package version stays on the Actions panel. `consumer.example.yml` gained a "Fetch latest tag" step (newest v* tag only, no full history — shallow consumer checkouts have no tags). Verified by fixture builds: tagged repo → `tagVersion:"9.9.9"` over package.json 0.0.1; untagged → empty fallback.
- **Interop** (`docs/interop.md`): steps 1–3. Rust app serves loopback-only `:5050` (`/publish`, `/well-known/identity`, CORS `*`); bridge posts identity after boot + every 30s; main.js probes and adopts silently when no key, else exposes `window.__pendingIdentityAdoption`. Deployed-page CI smoke: `.github/workflows/deployed-smoke.yml` (two headless nodes must discover each other). Interop test vectors (`tests/fixtures/interop-vectors.json`): gnostr.svg `bafkreih2kz6g6n5fhria2x23ana6dp76e2nln6edrt4iyikzgifxomx46a` (raw, 1763 bytes, sha256 `fa567c6f37a53c500d5f5b0341e1bffe269ab6f8838cf88c2159320b7732fcf0`, Pinata) — byte-exactness proven per surface: dedicated + public gateways (plain + `?format=raw`), Kubo RPC block/get (self-seeds via pin/add), in-page Helia via the Files UI (cdp-interop-vector).
- **URIs/providers** (`docs/ipfs-uri-providers.md`): steps 1–4 COMPLETE. Step 1 (pin.remote.list/add, registry entries `{endpoint, token}`), step 2 (`ipfs://`/`ipns://` click interception in-app + `web+ipfs`/`web+ipns` protocol handlers via `?uri=`), steps 3–4 (CID linkification: `js/cid-links.js` pure module + MutationObserver pass — every rendered CID becomes `a.cid-link` fetching in-app and opening the affordance popover with gateway/ipfs:// links, `ipfs pin add`, delegated-routing providers with `ipfs swarm connect` per addr, ☆ Pin to provider via shared `remotePinCid`; commands stay copy-pure; companion toggle in Peer→Settings skips interception for native `ipfs://` hrefs when on). Unit-tested (cid-links, 4), CDP-covered (cdp-cid-links). **Pinata**: action input `pinata-jwt` (repo secret) pins the release CAR via `scripts/pinata-pin.mjs` (v3 `uploads.pinata.cloud` multipart, `car=true` → roots pinned; JWT never logged; non-fatal); consumer.example.yml wires `secrets.PINATA_JWT`; page stub gains a Pinata preset (PSA endpoint prefill). Unit-tested (pinata-pin, 5).
- Desktop app: clap CLI (`--host/--port/--serve-dir/--url/--kubo/--repo/--systray`), tray-icon crate (NOT tao — tao 0.35 dropped tray), About panel (system light/dark, responsive), quit accelerators (Cmd+Q/Ctrl+Q menu, Ctrl+C raw key), interop :5050, sign/release scripts. `bundle.sh --install [PATH]`, `--run -- <args>` passthrough.

## Next (in priority order)

1. **markdown rendering like GitHub** (`docs/markdown-rendering.md`): concern DOCUMENTED, DECISION PENDING (image policy / iframe sandbox / CSP timing / bundle budget) — do not implement until decided.
2. **IPFS rehost service** (`docs/ipfs-rehost-service.md`): PLAN — decentralized camo (fetch-once → content-addressed URLs); tiers: browser-native / node service / desktop daemon; feeds the markdown image-policy decision (#1) as the "rehost" option.
3. **libp2p git transport** (`/ipfs-gh-pages/git/1`): for cross-machine clone; blocked on having a LISTENING libp2p node (browser can't); the in-process upload-pack is the same logic wrapped in a stream later.

## Backlog (research TODOs, gist refs)

- **Self-contained entropy generation, standards-compliant** — Rust NIST SP 800-90B health-tested jitter engine (RCT/APT/POST, latched failure) + BIP-64MOD conditioned 64-bit words + C ABI: https://gist.github.com/RandyMcMillan/17583506b0b00f4724ed2d3a2918e39c
- **Memoization where it measurably improves** — fib 5 ways (naive/memo/iterative/matrix/Binet) as the benchmark pattern: https://gist.github.com/RandyMcMillan/555fefec9a9c00b2864d066c9362bbbe
- **Consider for transport** — self-extracting shell script with appended tar.gz payload (marker-offset extraction): https://gist.github.com/RandyMcMillan/b4858efada0d267b228e2d016093f673
- **Consider for alternate transport protocol** — recursive MTU slicing with XOR parity slices, loss recovery from sibling+parity: https://gist.github.com/RandyMcMillan/f72ede9bff8bb79ec70d004ee34dd3ad
- **Potential attack vectors — stego carriers (PoCs, see docs/markdown-rendering.md)** — SVG `feColorMatrix`-coefficient stego: https://gist.github.com/RandyMcMillan/55e56ac549b4c31ac16ce7f7c7d381bd · SVG phantom-polyline coordinate stego (encode+decode): https://gist.github.com/RandyMcMillan/7b7b0de098cd26a341fc4a7390d22254 · PPM LSB channel stego (std-only): https://gist.github.com/RandyMcMillan/524a2d81ee8f0df35fcf2b08f0e1222c
- **P2P time sync, JS ↔ Rust bridge** — median-diff clock convergence (hour→minute→second) then nonce-grind consensus ritual with escalating SHA-difficulty as finality: https://gist.github.com/RandyMcMillan/dd116a5d29178ad16cae73cb0f84954e

## Hard-won gotchas (do not relearn)

- trunk canonicalizes its target's path → target html must live at repo root; `--html-output index-rust.html` sets the dist artifact name; `copy-file` flattens unless `data-target-path`.
- cargo-bundle does NOT refresh Resources/ in an existing .app → bundle.sh `rm -rf`s the bundle root first.
- esbuild/inomorphic-git: `StreamReader` iterates body CHUNKS — return `[bytes]`, not bare bytes; its request bodies arrive as chunk arrays — parser must normalize.
- Pack entries: `size` in the header is the DELTA size for ofs/ref deltas, result size otherwise.
- pkt-line length includes its own 4 chars AND the sideband channel byte.
- stateless-rpc REQUIRES `multi_ack_detailed` advertised; flush-pkts separate want/have sections — skip, never stop.
- execFileSync on git clone/fetch BLOCKS the node loop → starves an in-process server; use async execFile.
- git's detached auto-maintenance inherits pipes → `-c maintenance.auto=false -c gc.auto=0` in tests.
- `cargo fmt` before committing (rust-smoke CI checks it); clap/image/tray-icon are native-only deps (target-gated).
- Release flow: `npm run release` refuses on dirty tree; https-push of actions-test submodule is blocked (workflow scope) — release script falls back to origin-ssh automatically.
- Identity ONEness: `ipns-branch-key` (repo/root pointer) vs `ipns-index-key` (issues chain) are DIFFERENT keys — one IPNS name = one value.
- Optional services (`docs/optional-services.md`) are accelerants, never dependencies; resolution: configured → public defaults → p2p.
- PUSH ORDER (AGENTS.md): submodule branch/tag on ITS remote FIRST, superproject second — a gitlink pointing at an unpushed commit breaks CI checkout ("upload-pack: not our ref <sha>"). Guard: `node scripts/check-gitlink.mjs`; enforced in `.githooks/pre-push`, `release.mjs`, and the CI workflows (guard step before submodule checkout).
- `Action packaging smoke test` rust-smoke job: FIXED — was the ubuntu-latest migration dropping glib preinstalls; now pins `ubuntu-24.04` and apt-installs `libglib2.0-dev libgtk-3-dev libwebkit2gtk-4.1-dev libsoup-3.0-dev` (wry 0.55 / webkit2gtk-sys 2.0 pkg-config set).

## Standing orders

Interrupt = full stop. Commit = snapshot (release only via `npm run release` or explicit order). One topic per commit. Never push without an explicit order. Full values, never truncate. Every command its own line, yellow, single-click copy (web app). Tests live in `tests/`. Bump version + tag + push after every confirmed phase.
