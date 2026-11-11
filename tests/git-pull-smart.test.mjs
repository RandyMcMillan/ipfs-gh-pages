// Phase 9 step 4 tests: incremental pull against a newer publish. Clone
// from store A (2 commits), the repo advances (commit 3) -> store B,
// pull through the haves path, HEAD advances and only new content lands.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import isoGit from 'isomorphic-git';
import { GitStore } from '../js/git-objects.js';
import { makeSmartHttp } from '../js/git-smart.js';

const git = (args, cwd) =>
  execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();

const src = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-src-'));
const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-dest-'));

git(['init', '-q', '-b', 'main'], src);
git(['config', 'user.email', 'test@example.com'], src);
git(['config', 'user.name', 'Test'], src);
git(['config', 'commit.gpgsign', 'false'], src);
fs.writeFileSync(path.join(src, 'v1.txt'), 'version one\n');
git(['add', '.'], src);
git(['commit', '-q', '-m', 'one'], src);
fs.writeFileSync(path.join(src, 'v2.txt'), 'version two\n');
git(['add', '.'], src);
git(['commit', '-q', '-m', 'two'], src);

function buildStore() {
  const files = new Map();
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(src, '.git', rel))) {
      const relPath = rel ? `${rel}/${name}` : name;
      const full = path.join(src, '.git', relPath);
      if (fs.statSync(full).isDirectory()) walk(relPath);
      else if (!relPath.startsWith('logs/')) files.set(relPath, new Uint8Array(fs.readFileSync(full)));
    }
  };
  walk('');
  return new GitStore(files);
}

test('incremental pull advances HEAD and lands only new content', async () => {
  const storeA = buildStore();
  await isoGit.clone({
    fs: fsp,
    http: makeSmartHttp(storeA),
    url: 'http://ipfs.local/a.git',
    dir: dest,
    corsProxy: undefined,
  });
  assert.equal(await fsp.readFile(path.join(dest, 'v1.txt'), 'utf8'), 'version one\n');
  assert.ok(!(await fsp.readdir(dest)).includes('v3.txt'), 'v3 absent before publish');

  // The repo advances: commit 3 in the source, as a new publish would.
  fs.writeFileSync(path.join(src, 'v3.txt'), 'version three\n');
  git(['add', '.'], src);
  git(['commit', '-q', '-m', 'three'], src);
  const storeB = buildStore();

  const before = await isoGit.resolveRef({ fs: fsp, dir: dest, ref: 'HEAD' });
  await isoGit.pull({
    fs: fsp,
    http: makeSmartHttp(storeB),
    dir: dest,
    url: 'http://ipfs.local/b.git',
    corsProxy: undefined,
    singleBranch: false,
    author: { name: 'Test', email: 'test@example.com' },
  });
  const after = await isoGit.resolveRef({ fs: fsp, dir: dest, ref: 'HEAD' });

  assert.notEqual(after, before, 'HEAD advanced');
  assert.equal(await fsp.readFile(path.join(dest, 'v3.txt'), 'utf8'), 'version three\n');
  const log = await isoGit.log({ fs: fsp, dir: dest });
  assert.equal(log.length, 3, 'three commits after pull');
});

test('pull against the same store is a no-op fast-forward', async () => {
  const storeB = buildStore();
  const before = await isoGit.resolveRef({ fs: fsp, dir: dest, ref: 'HEAD' });
  await isoGit.pull({
    fs: fsp,
    http: makeSmartHttp(storeB),
    dir: dest,
    url: 'http://ipfs.local/b.git',
    corsProxy: undefined,
    singleBranch: false,
    author: { name: 'Test', email: 'test@example.com' },
  });
  const after = await isoGit.resolveRef({ fs: fsp, dir: dest, ref: 'HEAD' });
  assert.equal(after, before, 'HEAD unchanged');
});
