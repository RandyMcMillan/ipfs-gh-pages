// Bundles js/ipfs-node.js into a single browser ESM file that trunk copies
// into dist (via the copy-file link in index-rust.html) and index-rust.html
// loads as a module. Produces assets/ipfs-node.js.
//
// Injects the repo identity (REPO_OWNER / REPO_NAME / REPO_VERSION) and the
// repo file listing (REPO_FILES / REPO_README) via --define, mirroring
// vite's repoIdentityPlugin resolution order in vite.config.js:
// GITHUB_REPOSITORY env -> git remote origin -> package.json version.
// Parity matters: js/ipfs-node.js derives repoFullName from these, and that
// drives the localStorage identity key and gossip topics shared with
// main.js. REPO_FILES gives the Rust TUI (over window.__ipfsState) the same
// file listing the web app renders on its Code tab; REPO_README is the
// root README's raw text (empty when absent or over 64 KiB).

import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { listRepoFiles } from './lib/repo-files.mjs';

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

// Same git probes vite.config.js's resolveIdentity uses for the web app's
// Code tab — the TUI renders them identically.
function resolveGitMeta(root) {
  const run = (cmd) => {
    try { return execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; }
  };
  const branch = run('git symbolic-ref --short -q refs/remotes/origin/HEAD') || run('git rev-parse --abbrev-ref HEAD') || 'main';
  return {
    branch: branch.replace(/^origin\//, ''),
    lastCommitMsg: run('git log -1 --pretty=%s'),
    lastCommitTime: run('git log -1 --pretty=%cI'),
    shortSha: run('git log -1 --pretty=%h'),
    commitCount: run('git rev-list --count HEAD')
  };
}

const { owner, name, version } = resolveIdentity();
const repoRoot = process.env.REPO_ROOT || '.';
const gitMeta = resolveGitMeta(repoRoot);
const repoFiles = [];
let repoReadme = '';
for (const { path: p, full } of listRepoFiles(repoRoot)) {
  repoFiles.push(p);
  if (!repoReadme && /(^|\/)readme\.md$/i.test(p)) {
    try {
      if (fs.statSync(full).size <= 64 * 1024) {
        repoReadme = fs.readFileSync(full, 'utf8');
      }
    } catch {}
  }
}
const define = {
  REPO_OWNER: JSON.stringify(owner),
  REPO_NAME: JSON.stringify(name),
  REPO_VERSION: JSON.stringify(version),
  REPO_FILES: JSON.stringify(repoFiles),
  REPO_README: JSON.stringify(repoReadme),
  REPO_BRANCH: JSON.stringify(gitMeta.branch),
  REPO_LAST_COMMIT: JSON.stringify(gitMeta.lastCommitMsg),
  REPO_LAST_TIME: JSON.stringify(gitMeta.lastCommitTime),
  REPO_SHORT_SHA: JSON.stringify(gitMeta.shortSha),
  REPO_COMMIT_COUNT: JSON.stringify(gitMeta.commitCount)
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
