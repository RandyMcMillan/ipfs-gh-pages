// Phase 9 step 3 tests: isomorphic-git cloning through the in-process
// upload-pack — the exact wiring the bridge uses (makeSmartHttp over a
// GitStore), but with node fs/promises instead of lightning-fs so the
// assertion is files on disk.

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

const src = fs.mkdtempSync(path.join(os.tmpdir(), 'isosrc-'));
const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'isodest-'));

git(['init', '-q', '-b', 'main'], src);
git(['config', 'user.email', 'test@example.com'], src);
git(['config', 'user.name', 'Test'], src);
git(['config', 'commit.gpgsign', 'false'], src);
git(['config', 'tag.gpgsign', 'false'], src);
fs.writeFileSync(path.join(src, 'readme.md'), '# hello\n');
git(['add', '.'], src);
git(['commit', '-q', '-m', 'initial'], src);
fs.writeFileSync(path.join(src, 'app.js'), 'console.log(1);\n');
git(['add', '.'], src);
git(['commit', '-q', '-m', 'add app'], src);
git(['tag', '-a', '-m', 'v2.0', 'v2.0'], src);
git(['branch', 'dev'], src);
git(['notes', 'add', '-m', 'interop note', 'HEAD~1'], src);

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
const store = new GitStore(files);
const http = makeSmartHttp(store);

test('isomorphic-git clones through the in-process upload-pack', async () => {
  await isoGit.clone({
    fs: fsp,
    http,
    url: 'http://ipfs.local/bafyfake.git', // decorative; store is the remote
    dir: dest,
    corsProxy: undefined,
    tags: true,
  });

  assert.equal(await fsp.readFile(path.join(dest, 'readme.md'), 'utf8'), '# hello\n');
  assert.equal(await fsp.readFile(path.join(dest, 'app.js'), 'utf8'), 'console.log(1);\n');

  const log = await isoGit.log({ fs: fsp, dir: dest });
  assert.equal(log.length, 2, 'two commits');
  assert.ok(log[0].commit.message.includes('add app'), 'newest first');

  const branches = await isoGit.listBranches({ fs: fsp, dir: dest });
  assert.ok(branches.includes('main'), 'main branch checked out');
  const remoteBranches = await isoGit.listBranches({ fs: fsp, dir: dest, remote: 'origin' });
  assert.ok(remoteBranches.includes('dev'), 'dev branch on remote');

  const tags = await isoGit.listTags({ fs: fsp, dir: dest });
  assert.ok(tags.includes('v2.0'), 'annotated tag');

  // The notes ref resolves in the store (the notes-through-upload-pack
  // fetch path itself is proven with the real git CLI in
  // git-upload-pack.test.mjs).
  const noteRef = store.refs().refs.find((r) => r.name === 'refs/notes/commits');
  assert.ok(noteRef, 'notes ref advertised by the store');
  assert.equal(store.catFile(noteRef.sha).type, 'commit', 'notes tip is a commit');
});

test('clone of the same store into a second dir is deterministic', async () => {
  const dest2 = fs.mkdtempSync(path.join(os.tmpdir(), 'isodest2-'));
  await isoGit.clone({ fs: fsp, http, url: 'http://ipfs.local/x.git', dir: dest2, corsProxy: undefined });
  const log = await isoGit.log({ fs: fsp, dir: dest2 });
  assert.equal(log.length, 2);
  fs.rmSync(dest2, { recursive: true, force: true });
});
