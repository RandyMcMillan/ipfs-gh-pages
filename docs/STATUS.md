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
- Web app: `npm run dev` / `npm run build` (rebuilds actions-test.car — snapshot the submodule before releasing)
- Tests: `npm run test:all` — unit, car, index-merge (5), index-walk (3), line-comments (4), blame (6), git-objects (14), git-upload-pack (4), git-clone-smart (2), git-pull-smart (2), then CDP suite
- Release (ONLY when user orders): `npm run release <semver>` — refuses on dirty tree; snapshot `actions-test.car` first if `npm run build` ran
- Sign/release app: `scripts/sign-app.sh`, `scripts/release-app.sh [--notarize]`

## Done (by plan)

- **Bridge plan** (`docs/rust-js-bridge.md`): phases 1–8, 11. Tabs: IPFS, Peers, Fetch, Publish, Chat, Kubo (generic `kubo.rpc` = full API), Services, Git, Repo, Issues. `:` bar = vim command line (whole op surface; `kubo <m> <args>`, second token passes as `sha`).
- **Phase 9 git clone** (`docs/git-over-ipfs.md`): COMPLETE. `js/git-objects.js` (loose+pack+delta reader), `js/git-upload-pack.js` (in-process smart protocol; real git clones through it, fsck-clean), `js/git-smart.js` (isomorphic-git transport), `git.cloneSmart`/`git.pullSmart`/`git.clones` (lightning-fs, IndexedDB, incremental). TUI Git tab: c/s/u/a/l.
- **Phase 10 issues** (`docs/issues-car.md`): index on its OWN IPNS name (`ipns-index-key:<repo>` — branch pointer uses the repo key; one name = one value). `extendChain` publishes tip. Cross-surface sync in both surfaces; **multi-parent merge** via shared `js/index-merge.js` `classifyIndexSync` (genesis/ff-either-way/two-parent union). Bridge ops `issues.create`/`issues.sync`; TUI Issues tab (i/s). Issues CAR bundle walk (phase 6): `scripts/index-walk.mjs` walks tip → entries (`prev`) + notes (`added`, comment `parent` links; anchors NOT followed) into the blockstore; `build-car.mjs --index-tip <cid>` (repeatable) or `INDEX_TIPS=<cid,cid>` stages via Kubo RPC (KUBO_RPC) then trustless gateways (INDEX_GATEWAYS) — never fatal; CAR roots = repo root + resolved tips, partial tips bundled but not rooted. Line comments (phase 9, web app): select blob lines → signed `line-comment` note `{ns:'review', anchors:[fileCid], line:{start,end}}` via `js/line-comments.js` helpers (pure, unit-tested); gutter markers + tinted rows, composer, verified-comment panel; CDP-covered (cdp-line-comments). Root chain + blame (phases 10-11, web app): `recordRelease` in `addAllRepoFiles` writes `{type:'release', root, prev, timestamp}` dag-json per new root (dedup on republish; tips in `repo-release-chain`, genesis = current root); Blame toggle attributes each line to the OLDEST release containing it (multiset-exact line-text match, file-CID-diff fetch skip; `js/blame.js` pure, unit-tested), origin column doubles as the blame-comment affordance — signed `{ns:'review', type:'blame-comment', anchors:[fileCid], line:{start}, origin}` notes that ride the line across later versions (`blameCommentMatches`); CDP-covered (cdp-blame). TUI/bridge parity for line/blame comments: not built (web app only, like the rest of review UI).
- **Interop** (`docs/interop.md`): steps 1–3. Rust app serves loopback-only `:5050` (`/publish`, `/well-known/identity`, CORS `*`); bridge posts identity after boot + every 30s; main.js probes and adopts silently when no key, else exposes `window.__pendingIdentityAdoption`. Deployed-page CI smoke: `.github/workflows/deployed-smoke.yml` (two headless nodes must discover each other).
- **URIs/providers** (`docs/ipfs-uri-providers.md`): step 1 (pin.remote.list/add, registry entries `{endpoint, token}`), step 2 (`ipfs://`/`ipns://` click interception in-app + `web+ipfs`/`web+ipns` protocol handlers via `?uri=`).
- Desktop app: clap CLI (`--host/--port/--serve-dir/--url/--kubo/--repo/--systray`), tray-icon crate (NOT tao — tao 0.35 dropped tray), About panel (system light/dark, responsive), quit accelerators (Cmd+Q/Ctrl+Q menu, Ctrl+C raw key), interop :5050, sign/release scripts. `bundle.sh --install [PATH]`, `--run -- <args>` passthrough.

## Next (in priority order)

1. **Phase 10 remainder**: `.githooks/` git-host bridge.
2. **uri-providers steps 3–4**: CID linkification rendering pass (every rendered CID gets gateway/ipfs:// /providers/pin affordances), companion preference toggle.
3. **libp2p git transport** (`/ipfs-gh-pages/git/1`): for cross-machine clone; blocked on having a LISTENING libp2p node (browser can't); the in-process upload-pack is the same logic wrapped in a stream later.

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

## Standing orders

Interrupt = full stop. Commit = snapshot (release only via `npm run release` or explicit order). One topic per commit. Never push without an explicit order. Full values, never truncate. Every command its own line, yellow, single-click copy (web app). Tests live in `tests/`. Bump version + tag + push after every confirmed phase.
