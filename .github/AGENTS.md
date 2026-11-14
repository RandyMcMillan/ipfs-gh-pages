# Workflows & Consumer Contract

Applies to `.github/`, the release pipeline, and everything a consumer
touches. The root `AGENTS.md` holds the working agreement; this file holds
the deploy/CI knowledge earned the hard way.

## One deploy workflow, three users

`.github/workflows/deploy-gh-pages.yml` is THE deploy workflow:

1. **This repo runs it as its own deploy** (dogfooding).
2. **Consumers copy it verbatim** as their `.github/workflows/deploy.yml` —
   it is the demo; show off the self-updating features, keep every line
   working in a stranger's repo.
3. **The `actions-test` fixture installs it in lockstep**
   (`scripts/install-consumer-example.mjs`, on every release and CAR
   build). The repo-root `deploy-gh-pages.yml` is a symlink to the real
   file for visibility.

## The consumer deploy contract (hard-won gotchas)

- **Consumer deploys build from the newest `v*` tag of this action, never
  from main.** Unreleased commits reach nobody. Releases are the
  distribution mechanism; a consumer page can only show what the newest
  tag carries.
- **Release push order** (enforced by `scripts/release.mjs`): submodule
  branch → submodule tag → superproject **tag** → superproject **main**.
  Tag-before-main because the main push triggers the deploy, which
  auto-detects the newest tag — main-first would deploy the previous
  release and the tag push does not re-trigger (consumer shape has no
  `tags:` trigger).
- **A `needs` job that is `if`-skipped skips its dependents regardless of
  their own `if`** (only `always()` overrides). The `changed` gate job
  therefore runs on EVERY event and outputs `changed` internally (instant
  `true` for push/dispatch; marker-cache check on schedule). Never give it
  a job-level `if` — that broke `gnostr-org/gnostr` deploys once already.
- **The daily cron (`23 3 * * *`) is a demo feature** — it picks up a new
  action release with no consumer commits. Its marker-cache key is
  `deployed-<HEAD>-<newest-action-tag>`, so either side moving fires it;
  `actions/cache/save` is `continue-on-error` (a same-key race costs one
  redundant deploy, never a failure).
- **Submodules are content, and consumers must check them out.** The
  bundle mirrors the working tree (`scripts/lib/repo-files.mjs` flattens
  each checked-out submodule as `<sub>/<file>`); a plain
  `actions/checkout` leaves submodule dirs EMPTY and the deployed site
  silently ships without their files. The demo workflow passes
  `submodules: 'recursive'`, and the action itself runs
  `git submodule update --init --recursive` when `.gitmodules` exists —
  so custom workflows are covered too. A broken gitlink fails the build
  by design (that state breaks every recursive clone of the consumer
  repo as well). Large repos (over `EMBED_THRESHOLD_BYTES`) switch to
  `car` mode: `dist/repo.car` + `repo-manifest.json` carry the same
  flattened file set; per-submodule CARs cover each submodule's own
  files (`listTrackedFiles`).
- **Pinning inputs use each provider's own terminology.** Filebase:
  `filebase-access-key-id` / `filebase-secret-access-key` /
  `filebase-bucket` ← secrets `FILEBASE_ACCESS_KEY_ID`,
  `FILEBASE_SECRET_ACCESS_KEY`, `FILEBASE_BUCKET` (dashboard → Access
  Keys; S3 `PUT` to `https://s3.filebase.io`, region `auto`, SigV4 —
  `scripts/filebase-pin.mjs`, signer proven against AWS's known-answer
  vector). Pinata: `pinata-jwt` ← `PINATA_JWT`. Both optional, never
  fatal (`::warning::` on failure), secrets never printed or included in
  error text. Missing/empty = step skipped — that is normal, not a bug.

## Page identity: the repo's own data only

- Owner/name come from `GITHUB_REPOSITORY` (correct in every consumer
  build). The repo's own latest tag is `git describe` in `REPO_ROOT` after
  the workflow's "Fetch latest tag" step — consumer checkouts are shallow.
- **The CI bake of `tagVersion` is silently empty**: `actions/checkout`
  defaults to `fetch-depth: 1` and the workflow fetches just the one tag at
  depth 1, so `git describe` cannot prove the tag's commit is an ancestor
  of HEAD and fails. Every live page self-corrects via the runtime GitHub
  API (the releases/latest → newest-tag fallback), which is why this goes
  unnoticed — but anything relying on the baked value sees `''`. Fetch
  depth (or `git tag --sort=-v:refname`) is the fix if the bake ever
  matters before the API answers.
- **The action's package version (`appVersion`) is NEVER a fallback for
  the repo's release chip.** That printed this repo's v-tag on tagless
  consumer pages (the gnostr bug). The chip shows only the repo's own tag
  (baked or live API); the chip row and "+ N releases" stay `hidden`
  until real data exists (0 releases → hidden, never "+ 0 releases").
- Live metadata (branches/tags counts, release, release count) is fetched
  per-repo at runtime; count links stay hidden when the API doesn't
  answer (user override of the old "neutral label" idiom — a static
  label that claims a value is false information).
- Missing GitHub **Releases** for tags stall the page's live "latest
  release" (the `releases/latest` endpoint keeps answering with the
  newest old release). Tags alone don't create Releases — `release.yml`
  does, and only when its test job passes.

## CI suite hangs: deterministic exit

`node --test` waits for the event loop to drain; helia/libp2p shutdown
occasionally leaves dangling dial handles on CI runners (restricted
egress) so a suite whose tests ALL PASSED still dies at the `test:ci`
180s cap — this blocked the v3.0.2–v3.0.4 releases at
`tests/index-walk.test.mjs`. Node 20 has no `--test-force-exit`; suites
that spin up helia nodes carry the shim:

```js
after(() => setTimeout(() => process.exit(0), 500).unref());
```

Timers fire whether or not other handles keep the loop alive; `.unref()`
keeps the shim itself from being a handle. Replicate in any suite that
shows the same flake.

## Pages deploy flake: never re-run `--failed`

`actions/deploy-pages` fetches artifact metadata after
`upload-pages-artifact` succeeds; GitHub's metadata propagation sometimes
lags, failing the deploy with "No artifacts named github-pages were found"
minutes after a clean upload. **Do not `gh run rerun --failed`**: re-running
the job re-runs the upload and creates a SECOND `github-pages` artifact,
and deploy-pages then fails with "Multiple artifacts" — the run is
deadlocked. Remedy: wait a minute and dispatch a fresh run (new run id,
clean artifact namespace).

## Filebase pin troubleshooting

A `403 AccessDenied` (not `SignatureDoesNotMatch`) means the request was
well-signed and reached Filebase's authorization layer — check the secret
VALUES, not the wiring: bucket name must exist under the same account as
the Access Keys, and the key pair must have write access. Upload errors
name the bucket and accessKeyId (identifiers, not secrets) to compare
against the dashboard. The step is never fatal: it warns and the deploy
continues unpinned.

## Testing consumers locally

```bash
REPO_ROOT=/path/to/consumer npx vite build --outDir /tmp/dist-consumer --emptyOutDir
```

Then read the baked identity out of the built bundle (`owner:`,
`name:`, `tagVersion:` in `assets/index-*.js`) and/or serve `dist/` and
probe the DOM (`latest-release-link.hidden`,
`latest-release-version.textContent`, `releases-more`). esbuild folds an
empty `tagVersion` away — absence from the bundle IS the empty value, and
it yields `undefined || ''` → chip hidden. Local checkouts for this:

- `/Users/Shared/github/gnostr` — the live consumer (`gnostr-org/gnostr`).
  Versioning is `blockheight.weeble.wobble` from `[workspace.package]` in
  its `Cargo.toml`; its deploy tag detection matches `v*` (which also
  matches `release/v...` ref tails). Pushing a `v<version>` tag there is
  authorized for testing the with-tags consumer path.
- `/Users/Shared/github/ipfs-gh-pages/actions-test` — the fixture; its
  lockstep tags track this repo's releases.

A consumer page built before a fix keeps the old behavior until it
redeploys (push/dispatch/daily cron) against an action tag that carries
the fix.
