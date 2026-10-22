# Helia IPFS - Browser Self-Hosting

[![Deploy Helia App to GitHub Pages](https://github.com/RandyMcMillan/ipfs-gh-pages/actions/workflows/deploy.yml/badge.svg)](https://github.com/RandyMcMillan/ipfs-gh-pages/actions/workflows/deploy.yml)
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
npm run test          # fetch a file
npm run test:eval     # inspect fetched bytes
npm run test:zip      # zip a directory
npm run test:download # download flow
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
        uses: RandyMcMillan/ipfs-gh-pages@v1.4.0
        with:
          node-version: '20'
          deploy: 'true'
```

Inputs:

- `node-version` (default `20`) — Node.js version used for the build.
- `repo-root` (default `${{ github.workspace }}`) — directory whose tracked files are embedded.
- `out-dir` (default `${{ github.workspace }}/dist`) — where the production bundle is written.
- `deploy` (default `true`) — whether to deploy to GitHub Pages.
- `run-tests` (default `false`) — run the integration suite (installs Chromium) before building.

Outputs:

- `dist-path` — absolute path to the built bundle directory.

Set `deploy: 'false'` to only produce the bundle (e.g. to attach it to a release) and skip
the Pages deployment step.

## CI / CD

- `.github/workflows/deploy.yml` runs the full test suite on every push and pull request; deployment to GitHub Pages only happens on `main` after tests pass.
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