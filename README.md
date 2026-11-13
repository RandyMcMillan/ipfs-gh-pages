# Helia IPFS - [deploy-gh-pages](deploy-gh-pages.yml)

[![Deploy Helia App to GitHub Pages](https://github.com/RandyMcMillan/ipfs-gh-pages/actions/workflows/deploy-gh-pages.yml/badge.svg)](https://github.com/RandyMcMillan/ipfs-gh-pages/actions/workflows/this-repo-pages-deploy.yml)
[![Release](https://github.com/RandyMcMillan/ipfs-gh-pages/actions/workflows/release.yml/badge.svg)](https://github.com/RandyMcMillan/ipfs-gh-pages/actions/workflows/release.yml)

A browser-based IPFS node built with [Helia](https://github.com/ipfs/helia) that runs entirely on GitHub Pages. On load it automatically adds every file in the repository to IPFS and exposes a root CID, plus a browsable file tree, content fetch, and download support.

Live demo: https://randymcmillan.github.io/ipfs-gh-pages/

## Features

- In-browser Helia IPFS node (no backend required)
- Automatically adds all repository files to IPFS on startup
- Root directory CID displayed after import
- Repository file/folder tree view with per-file CIDs
- Click any CID to fetch its content (text, binary, or directory listing)
- Download button saves the actual retrieved bytes (files download as themselves, directories as a `.zip`)
- Publish arbitrary text and fetch by CID

## Development

```bash
npm install
npm run dev
```

Open http://localhost:5173.

## Build

```bash
npm run build
npm run preview
```

The production bundle is written to `./dist`.

## Tests

Integration tests use headless Chrome/Chromium via the Chrome DevTools Protocol.

```bash
# start the dev server in another terminal
npm run dev

# run tests
npm run test          # all tests (unit + headless Chrome integration)
npm run test:unit     # pure functions only, no browser needed
npm run test:eval     # inspect fetched bytes
npm run test:zip      # zip a directory
npm run test:download # download flow
npm run test:share    # share link: two headless browsers, auto-connect via ?connect=
node tests/cdp-ui.mjs # UI chrome regression tests (dropdown, tabs, blob view, theme)
node tests/car.test.mjs  # CAR round-trip: export/import with locked deps only
npm run test:gateway  # public gateway reachability for the repo root (needs a provider)

## Submodules & releases

`actions-test` is a small submodule kept as the fixture for the
per-submodule CAR build (`build-car` writes `<submodule>/<name>.car`).
Its `.car` artifacts are ignored (`ignore = untracked` in `.gitmodules`)
so the superproject stays clean.

Release procedure with submodules:

1. To update the fixture's content: commit and push inside the
   submodule, then bump the gitlink here (the normal two-step).
2. Every build installs the repo's own `.github/workflows/deploy-gh-pages.yml`
   as the fixture's `actions-test/.github/workflows/deploy.yml` — one
   deploy workflow shared by this repo, its consumers, and the fixture
   (the repo-root `deploy-gh-pages.yml` is a symlink to it) — then
   rebuilds every submodule CAR from the checked-out commit. The CAR's
   root CID changes only when the submodule's tracked files change.
3. CI checkouts that don't initialize submodules skip the submodule
   CARs gracefully; the main `dist/ipfs-gh-pages.car` is unaffected.

Push order is critical: the submodule's commits must be on ITS remote
BEFORE any superproject commit referencing them is pushed — a gitlink
pointing at an unpushed commit breaks every `submodules: recursive`
checkout (CI: "upload-pack: not our ref"). Verify with:

```
node scripts/check-gitlink.mjs
```

Sync the fixture workflow by hand with:

```
npm run install:consumer-example
```

Releases are cut with `npm run release <version>` — it bumps,
commits, tags, and pushes this repo AND tags the actions-test
submodule at the gitlink's commit, keeping its tags in lockstep.
node tests/cdp-ui.mjs # UI chrome regression tests (dropdown, tabs, blob view, theme)
```

Set `CHROME_PATH` to point at your browser binary if it is not auto-detected.

## Using this as a GitHub Action

This repository is also a reusable GitHub Action. Other repositories can build (and deploy) a
browser IPFS node that embeds all of their own files with a few lines of YAML:

```yaml
name: Deploy IPFS site

on:
  push:
    branches: [main]

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deploy.outputs.page_url }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Build and deploy IPFS site
        id: deploy
        uses: RandyMcMillan/ipfs-gh-pages@v3.0.3
        with:
          node-version: '20'
          deploy: 'true'
```

The example above pins a release tag. A self-updating variant — it auto-detects the
newest `v*` tag of this action at run time (falling back to the default-branch HEAD),
and takes an explicit pin via `workflow_dispatch` — is the very workflow this repo
deploys itself with:
[`.github/workflows/deploy-gh-pages.yml`](https://github.com/RandyMcMillan/ipfs-gh-pages/blob/main/.github/workflows/deploy-gh-pages.yml)
(copy it as `.github/workflows/deploy.yml`; a `deploy-gh-pages.yml` symlink at the
repo root points at the same file).

Inputs:

- `node-version` (default `20`) — Node.js version used for the build.
- `repo-root` (default `${{ github.workspace }}`) — directory whose tracked files are embedded.
- `out-dir` (default `${{ github.workspace }}/dist`) — where the production bundle is written.
- `deploy` (default `true`) — whether to deploy to GitHub Pages.
- `run-tests` (default `false`) — run the integration suite (installs Chromium) before building.
- `pinata-jwt` (default empty) — a Pinata JWT, normally passed as a repo secret (`pinata-jwt: ${{ secrets.PINATA_JWT }}`). When set, the built `ipfs-gh-pages.car` is pinned to Pinata's public IPFS network (`car=true` — the CAR's roots are what gets pinned). Empty = skipped; failures only warn (optional service).
- `filebase-key` / `filebase-secret` / `filebase-bucket` (default empty) — Filebase S3 credentials, normally repo secrets (`FILEBASE_KEY`, `FILEBASE_SECRET`, `FILEBASE_BUCKET` from the Filebase dashboard → Access Keys, plus your bucket). When all three are set, the built `ipfs-gh-pages.car` is pinned to Filebase's IPFS network via an S3 `PUT` (SigV4; the pinned CID comes back in the `x-amz-meta-cid` header). Empty = skipped; failures only warn (optional service).

Outputs:

- `dist-path` — absolute path to the built bundle directory.

Set `deploy: 'false'` to only produce the bundle (e.g. to attach it to a release) and skip
the Pages deployment step.

## CI / CD

- `.github/workflows/this-repo-pages-deploy.yml` runs the full test suite on every push and pull request; deployment to GitHub Pages only happens on `main` after tests pass.
- `.github/workflows/release.yml` runs tests, builds the project, archives `./dist` as `dist.zip`, and attaches it to a GitHub Release (triggered by `v*` tags or manually).

## Project Structure

```
index.html          # app shell + UI
main.js             # Helia node, IPFS import, tree, fetch, download
vite.config.js      # Vite config + virtual repo-files module
tests/              # Chrome DevTools Protocol integration tests
.github/workflows/  # CI/CD pipelines
```

## License

MIT