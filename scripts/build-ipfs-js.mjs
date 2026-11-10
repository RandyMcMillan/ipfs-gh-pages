// Bundles js/ipfs-node.js into a single browser ESM file that trunk copies
// into dist (via the copy-file link in index-rust.html) and index-rust.html
// loads as a module. Produces assets/ipfs-node.js.
//
// Injects the repo identity (REPO_OWNER / REPO_NAME / REPO_VERSION) via
// --define, mirroring vite's repoIdentityPlugin resolution order in
// vite.config.js: GITHUB_REPOSITORY env -> git remote origin -> package.json
// version. Parity matters: js/ipfs-node.js derives repoFullName from these,
// and that drives the localStorage identity key and gossip topics shared
// with main.js.

import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

function resolveIdentity() {
  let owner = process.env.GITHUB_REPOSITORY_OWNER || '';
  let name = (process.env.GITHUB_REPOSITORY || '').split('/')[1] || '';
  let version = process.env.npm_package_version || '';
  if (!version) {
    try {
      version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version || '';
    } catch {}
  }
  if (!owner || !name) {
    try {
      const remote = execSync('git config --get remote.origin.url', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim();
      const m = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
      if (m) {
        owner = owner || m[1];
        name = name || m[2];
      }
    } catch {}
  }
  return { owner: owner || 'gnostr', name: name || 'gnostr-repo', version };
}

const { owner, name, version } = resolveIdentity();
const define = {
  REPO_OWNER: JSON.stringify(owner),
  REPO_NAME: JSON.stringify(name),
  REPO_VERSION: JSON.stringify(version)
};

await build({
  entryPoints: ['js/ipfs-node.js'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'esnext',
  mainFields: ['browser', 'module', 'main'],
  sourcemap: false,
  define,
  outfile: 'assets/ipfs-node.js',
  logLevel: 'info'
});
