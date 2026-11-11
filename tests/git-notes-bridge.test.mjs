// Phase 12 tests: the .githooks/ git-host bridge (docs/issues-car.md
// "Git-host bridge (hooks)") against real git repos in tmp dirs.
//
// The interop requirement is asserted the strong way: notes written by the
// pre-push hook are read back with plain `git notes --ref=<ns> show <sha>`
// — native tooling (git-appraise, git-bug) reads the same layout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.githooks');
const TIP_A = 'baguqiger3qvmvq5b3tm5x4vbgwls5k3li63jumdifywczijqh5wfjvqp7oa';
const TIP_B = 'baguqiger3qvmvq5b3tm5x4vbgwls5k3li63jumdifywczijqh5wfjvqp7ob';
const ZERO40 = '0'.repeat(40);

const git = (args, cwd) =>
  execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();

const runHook = (name, args, { cwd, input = '', env = {} }) =>
  execFileSync('bash', [path.join(HOOKS, name), ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: { ...process.env, IPFS_INDEX_TIP: '', ...env },
  });

const mkRepo = (originUrl) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-bridge-'));
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello\n');
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', 'initial'], dir);
  if (originUrl) git(['remote', 'add', 'origin', originUrl], dir);
  return dir;
};

const head = (dir) => git(['rev-parse', 'HEAD'], dir);

const pushLine = (dir, localRef = 'refs/heads/main') =>
  `${localRef} ${head(dir)} ${localRef} ${ZERO40}\n`;

test('pre-push writes a note native git notes reads back (env tip)', () => {
  const dir = mkRepo('https://github.com/acme/widget.git');
  const sha = head(dir);
  const out = runHook('pre-push', ['origin'], { cwd: dir, input: pushLine(dir), env: { IPFS_INDEX_TIP: TIP_A } });
  assert.ok(out.includes(`noted index tip ${TIP_A} on ${sha}`), 'hook reports the note');
  assert.equal(git(['notes', '--ref=acme/widget/index', 'show', sha], dir), TIP_A);
  // The notes ref is a real ref under refs/notes/<owner>/<repo>/index.
  assert.equal(git(['rev-parse', '--verify', 'refs/notes/acme/widget/index'], dir).length, 40);
});

test('pre-push reads the tip from the exported file', () => {
  const dir = mkRepo('https://github.com/acme/widget.git');
  const sha = head(dir);
  fs.writeFileSync(path.join(dir, '.git', 'ipfs-index-tip'), `${TIP_B}\n`);
  runHook('pre-push', ['origin'], { cwd: dir, input: pushLine(dir) });
  assert.equal(git(['notes', '--ref=acme/widget/index', 'show', sha], dir), TIP_B);
});

test('pre-push without a tip never blocks the push', () => {
  const dir = mkRepo('https://github.com/acme/widget.git');
  const sha = head(dir);
  let err = '';
  try {
    runHook('pre-push', ['origin'], { cwd: dir, input: pushLine(dir) });
  } catch (e) {
    err = e.stderr || '';
  }
  // Exit 0 with a notice; no note written.
  assert.ok(!err.includes('fatal'), 'no failure');
  assert.throws(() => git(['notes', '--ref=acme/widget/index', 'show', sha], dir));
});

test('pre-push skips deletion lines and annotates every pushed tip', () => {
  const dir = mkRepo('https://github.com/acme/widget.git');
  git(['branch', 'dev'], dir);
  const mainSha = head(dir);
  const devSha = git(['rev-parse', 'dev'], dir);
  const input = `${pushLine(dir)}refs/heads/dev ${devSha} refs/heads/dev ${ZERO40}\nrefs/heads/old ${ZERO40} refs/heads/old ${ZERO40}\n`;
  runHook('pre-push', ['origin'], { cwd: dir, input, env: { IPFS_INDEX_TIP: TIP_A } });
  assert.equal(git(['notes', '--ref=acme/widget/index', 'show', mainSha], dir), TIP_A);
  assert.equal(git(['notes', '--ref=acme/widget/index', 'show', devSha], dir), TIP_A);
  // Deletion of refs/heads/old wrote nothing (no such object annotated).
  const notesLog = git(['notes', '--ref=acme/widget/index', 'list'], dir);
  assert.ok(!notesLog.includes(ZERO40), 'zero sha never annotated');
});

test('namespace derives from ssh origin and falls back to the toplevel basename', () => {
  const sshDir = mkRepo('git@github.com:acme/widget.git');
  runHook('pre-push', ['origin'], { cwd: sshDir, input: pushLine(sshDir), env: { IPFS_INDEX_TIP: TIP_A } });
  assert.equal(git(['notes', '--ref=acme/widget/index', 'show', head(sshDir)], sshDir), TIP_A);

  const bare = mkRepo(null);
  const ns = `${path.basename(bare)}/index`;
  runHook('pre-push', ['origin'], { cwd: bare, input: pushLine(bare), env: { IPFS_INDEX_TIP: TIP_B } });
  assert.equal(git(['notes', `--ref=${ns}`, 'show', head(bare)], bare), TIP_B);
});

test('post-merge hands the fetched tip CID off (full value, incoming file)', () => {
  const dir = mkRepo('https://github.com/acme/widget.git');
  const sha = head(dir);
  runHook('pre-push', ['origin'], { cwd: dir, input: pushLine(dir), env: { IPFS_INDEX_TIP: TIP_A } });
  const out = runHook('post-merge', [], { cwd: dir });
  assert.ok(out.includes(`names index tip ${TIP_A} (from HEAD)`), 'hand-off prints the full CID');
  const incoming = fs.readFileSync(path.join(dir, '.git', 'ipfs-index-tip-incoming'), 'utf8');
  assert.ok(incoming.includes(TIP_A), 'incoming file carries the tip');
  assert.ok(out.includes(`ipfs pin add ${TIP_A}`), 'pin command on its own line');
});

test('post-merge with no notes ref exits quietly', () => {
  const dir = mkRepo('https://github.com/acme/widget.git');
  const out = runHook('post-merge', [], { cwd: dir });
  assert.equal(out.trim(), '');
  assert.ok(!fs.existsSync(path.join(dir, '.git', 'ipfs-index-tip-incoming')));
});
