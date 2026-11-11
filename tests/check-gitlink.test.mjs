// Push-order guard tests (AGENTS.md "Push order"): a superproject whose
// gitlink points at an UNPUSHED submodule commit breaks every
// `submodules: recursive` checkout (CI: "upload-pack: not our ref").
// scripts/check-gitlink.mjs must catch that BEFORE the push, and the
// pre-push hook must block default-branch pushes on it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = path.join(ROOT, 'scripts', 'check-gitlink.mjs');
const PRE_PUSH = path.join(ROOT, '.githooks', 'pre-push');
const ZERO40 = '0'.repeat(40);

const git = (args, cwd) =>
  execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'protocol.file.allow=always', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();

const runGuard = (cwd) => {
  try {
    return { code: 0, out: execFileSync('node', [GUARD], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
};

// Superproject with an actions-test submodule whose gitlink points PAST
// the remote (commit B exists only in the submodule working repo) — the
// exact state that turned CI red.
const mkFixture = () => {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlink-remote-'));
  git(['init', '-q', '--bare', '-b', 'master', remote], remote);
  const sub = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlink-sub-'));
  git(['init', '-q', '-b', 'master'], sub);
  git(['config', 'user.email', 'test@example.com'], sub);
  git(['config', 'user.name', 'Test'], sub);
  fs.writeFileSync(path.join(sub, 'hello.txt'), 'hello\n');
  git(['add', '.'], sub);
  git(['commit', '-q', '-m', 'on remote'], sub);
  git(['push', '-q', remote, 'master'], sub);

  const sup = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlink-sup-'));
  git(['init', '-q', '-b', 'main'], sup);
  git(['config', 'user.email', 'test@example.com'], sup);
  git(['config', 'user.name', 'Test'], sup);
  fs.writeFileSync(path.join(sup, 'readme.md'), '# sup\n');
  git(['add', '.'], sup);
  git(['commit', '-q', '-m', 'initial'], sup);
  git(['submodule', 'add', remote, 'actions-test'], sup);
  git(['commit', '-q', '-m', 'add submodule'], sup);

  // The submodule advances past the remote; the superproject records the
  // new commit WITHOUT it being pushed — the broken state.
  fs.writeFileSync(path.join(sub, 'hello.txt'), 'hello v2\n');
  git(['add', '.'], sub);
  git(['commit', '-q', '-m', 'not pushed'], sub);
  const subSha = git(['rev-parse', 'HEAD'], sub);
  git(['fetch', '-q', sub, 'master'], path.join(sup, 'actions-test'));
  git(['checkout', '-q', 'FETCH_HEAD'], path.join(sup, 'actions-test'));
  git(['add', 'actions-test'], sup);
  git(['commit', '-q', '-m', 'bump gitlink past remote'], sup);

  fs.mkdirSync(path.join(sup, 'scripts'));
  fs.copyFileSync(GUARD, path.join(sup, 'scripts', 'check-gitlink.mjs'));
  return { remote, sub, sup, subSha };
};

test('guard fails on an unpushed gitlink, names the full SHA + remediation', () => {
  const { sup, subSha } = mkFixture();
  const r = runGuard(sup);
  assert.equal(r.code, 1);
  assert.ok(r.out.includes(subSha), 'full gitlink SHA in the message');
  assert.ok(r.out.includes('upload-pack: not our ref'), 'the exact CI error surfaces');
  assert.ok(r.out.includes(`git -C actions-test push origin master`), 'remediation command on its own line');
});

test('guard passes once the submodule commit is on its remote', () => {
  const { remote, sub, sup, subSha } = mkFixture();
  git(['push', '-q', remote, 'master'], sub);
  const r = runGuard(sup);
  assert.equal(r.code, 0);
  assert.ok(r.out.includes(`${subSha} resolves`));
});

test('guard passes on a repo with no submodules', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlink-none-'));
  git(['init', '-q', '-b', 'main'], bare);
  const r = runGuard(bare);
  assert.equal(r.code, 0);
  assert.ok(r.out.includes('no submodules recorded'));
});

test('pre-push BLOCKS a default-branch push with an unpushed gitlink', () => {
  const { sup, sub, remote, subSha } = mkFixture();
  const supSha = git(['rev-parse', 'HEAD'], sup);
  const input = `refs/heads/main ${supSha} refs/heads/main ${ZERO40}\n`;
  const runHook = () => {
    try {
      return { code: 0, out: execFileSync('bash', [PRE_PUSH, 'origin'], { cwd: sup, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, IPFS_INDEX_TIP: '' } }) };
    } catch (e) {
      return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
    }
  };
  const blocked = runHook();
  assert.equal(blocked.code, 1, 'push is blocked');
  assert.ok(blocked.out.includes('BLOCKED') && blocked.out.includes(subSha), 'block message names the SHA');

  git(['push', '-q', remote, 'master'], sub);
  const allowed = runHook();
  assert.equal(allowed.code, 0, 'push proceeds once the submodule is on its remote');
});

test('pre-push leaves topic-branch pushes ungated', () => {
  const { sup, subSha } = mkFixture();
  const supSha = git(['rev-parse', 'HEAD'], sup);
  const input = `refs/heads/topic ${supSha} refs/heads/topic ${ZERO40}\n`;
  try {
    execFileSync('bash', [PRE_PUSH, 'origin'], { cwd: sup, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, IPFS_INDEX_TIP: '' } });
  } catch (e) {
    assert.fail(`topic push should not be gated: ${e.stderr || e.message}`);
  }
});
