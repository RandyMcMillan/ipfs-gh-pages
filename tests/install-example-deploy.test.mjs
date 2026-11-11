// install-example-deploy.mjs tests: the actions-test fixture's deploy.yml
// stays in lockstep with the repo's example.deploy.yml (installed before
// CAR generation). Fixtures use REPO_ROOT so the real submodule is never
// touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'install-example-deploy.mjs');

const EXAMPLE = 'name: Deploy IPFS site\n# auto-detects newest v* tag\n';

const mkFixture = ({ withTarget = true, stale = true } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-example-'));
  fs.writeFileSync(path.join(root, 'example.deploy.yml'), EXAMPLE);
  const dest = path.join(root, 'actions-test', '.github', 'workflows', 'deploy.yml');
  if (withTarget) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, stale ? 'stale: pin 8e5ea397b3fa70854b2b2779eb3f2e8ead0691dd\n' : EXAMPLE);
  }
  return { root, dest };
};

const run = (root, args = []) =>
  execFileSync('node', [SCRIPT, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, REPO_ROOT: root },
  }).trim();

test('installs the example over a stale fixture workflow, byte-identical', () => {
  const { root, dest } = mkFixture();
  const out = run(root);
  assert.ok(out.includes('installed'), out);
  assert.equal(fs.readFileSync(dest, 'utf8'), EXAMPLE);
});

test('is idempotent — identical files are left untouched', () => {
  const { root, dest } = mkFixture({ stale: false });
  const before = fs.statSync(dest).mtimeMs;
  const out = run(root);
  assert.ok(out.includes('already in sync'), out);
  assert.equal(fs.statSync(dest).mtimeMs, before, 'no rewrite when in sync');
});

test('creates the fixture workflow directory when missing', () => {
  const { root, dest } = mkFixture({ withTarget: false });
  run(root);
  assert.equal(fs.readFileSync(dest, 'utf8'), EXAMPLE);
});

test('--check exits 1 on drift and 0 in lockstep, without writing', () => {
  const { root, dest } = mkFixture();
  assert.throws(() => run(root, ['--check']), /differs from/);
  assert.ok(fs.readFileSync(dest, 'utf8').includes('stale'), 'check wrote nothing');
  run(root);
  assert.ok(run(root, ['--check']).includes('already in sync'));
});

test('missing example.deploy.yml is a hard error', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-example-'));
  assert.throws(() => run(root), /source not found/);
});
