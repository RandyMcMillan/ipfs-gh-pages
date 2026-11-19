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
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
// Code tab — the TUI renders them identically. The drydock-style release
// metrics (latest tag, commits since it, upstream ahead/behind, tree
// cleanliness) round out the TUI's Repository panel; values are baked at
// bundle build time.
function resolveGitMeta(root) {
  const run = (cmd) => {
    try { return execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; }
  };
  const branch = run('git symbolic-ref --short -q refs/remotes/origin/HEAD') || run('git rev-parse --abbrev-ref HEAD') || 'main';
  const latestTag = run('git describe --tags --abbrev=0');
  const commitsSinceTag = latestTag ? run(`git rev-list --count ${latestTag}..HEAD`) : '';
  const upstream = run("git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}'");
  let ahead = '';
  let behind = '';
  if (upstream) {
    const counts = run(`git rev-list --left-right --count '${upstream}'...HEAD`).split('\t');
    behind = counts[0] || '';
    ahead = counts[1] || '';
  }
  const dirty = run('git status --porcelain') !== '';
  // gitsocial-style releases view: recent tags with date + subject.
  const tags = run("git for-each-ref refs/tags --sort=-creatordate --format='%(refname:short)%09%(creatordate:short)%09%(subject)'")
    .split('\n')
    .filter(Boolean)
    .slice(0, 10)
    .map((l) => {
      const [tag = '', date = '', subject = ''] = l.split('\t');
      return { tag, date, subject };
    });
  return {
    branch: branch.replace(/^origin\//, ''),
    lastCommitMsg: run('git log -1 --pretty=%s'),
    lastCommitTime: run('git log -1 --pretty=%cI'),
    shortSha: run('git log -1 --pretty=%h'),
    commitCount: run('git rev-list --count HEAD'),
    latestTag,
    commitsSinceTag,
    upstream,
    ahead,
    behind,
    dirty,
    tags
  };
}

// Workflow summaries for the TUI's Actions tab (wrkflw-style map): the
// workflow `name`, its job ids, and each job's runs-on/needs — line-parsed,
// no YAML dependency. Definitions only; run status lives on the git host.
function stripQuotes(s) {
  return s.replace(/^['"]|['"]$/g, '');
}

// Trailing " # comment" off a scalar value (keeps '#' inside the value).
function stripComment(s) {
  return s.replace(/\s+#.*$/, '').trim();
}

function parseWorkflow(file, text) {
  const jobs = [];
  let name = '';
  let inJobs = false;
  let jobsIndent = -1;
  let current = null;
  let collectingNeeds = false;
  const needsItems = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (!inJobs) {
      const m = line.match(/^name:\s*(.+)$/);
      if (m && indent === 0) name = stripQuotes(stripComment(m[1]));
      if (indent === 0 && line === 'jobs:') inJobs = true;
      continue;
    }
    if (indent === 0) break; // next top-level key ends the jobs section
    const jobMatch = raw.match(/^(\s+)([A-Za-z0-9_-]+):\s*(?:#.*)?$/);
    if (jobMatch) {
      const ind = jobMatch[1].length;
      if (jobsIndent === -1) jobsIndent = ind;
      if (ind === jobsIndent) {
        if (current && collectingNeeds) current.needs = needsItems.join(', ');
        current = { name: jobMatch[2], runs_on: '', needs: '' };
        jobs.push(current);
        collectingNeeds = false;
        needsItems.length = 0;
        continue;
      }
    }
    if (!current || indent <= jobsIndent) continue;
    const ro = line.match(/^runs-on:\s*(.+)$/);
    if (ro) current.runs_on = stripQuotes(stripComment(ro[1]));
    const ne = line.match(/^needs:\s*(.*)$/);
    if (ne) {
      const value = stripComment(ne[1]);
      if (value.startsWith('[')) {
        current.needs = stripQuotes(value.replace(/^\[|\]$/g, ''));
        collectingNeeds = false;
      } else if (value) {
        current.needs = stripQuotes(value);
        collectingNeeds = false;
      } else {
        collectingNeeds = true; // multiline list form
        needsItems.length = 0;
      }
      continue;
    }
    if (collectingNeeds) {
      const item = line.match(/^-\s+(.+)$/);
      if (item) needsItems.push(stripQuotes(item[1].trim()));
    }
  }
  if (current && collectingNeeds) current.needs = needsItems.join(', ');
  return { file, name: name || file, jobs };
}

function extractWorkflows(root) {
  const wfDir = `${root}/.github/workflows`;
  let files = [];
  try {
    files = fs.readdirSync(wfDir).filter((f) => /\.(ya?ml)$/.test(f)).sort();
  } catch {}
  const workflows = [];
  for (const file of files) {
    try {
      workflows.push(parseWorkflow(file, fs.readFileSync(`${wfDir}/${file}`, 'utf8')));
    } catch {}
  }
  return workflows;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

export {
  resolveIdentity,
  resolveGitMeta,
  parseWorkflow,
  extractWorkflows
};

if (isMain) {
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
    REPO_COMMIT_COUNT: JSON.stringify(gitMeta.commitCount),
    REPO_LATEST_TAG: JSON.stringify(gitMeta.latestTag),
    REPO_COMMITS_SINCE_TAG: JSON.stringify(gitMeta.commitsSinceTag),
    REPO_UPSTREAM: JSON.stringify(gitMeta.upstream),
    REPO_AHEAD: JSON.stringify(gitMeta.ahead),
    REPO_BEHIND: JSON.stringify(gitMeta.behind),
    REPO_DIRTY: JSON.stringify(gitMeta.dirty),
    REPO_TAGS: JSON.stringify(gitMeta.tags),
    REPO_WORKFLOWS: JSON.stringify(extractWorkflows(repoRoot))
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
}
