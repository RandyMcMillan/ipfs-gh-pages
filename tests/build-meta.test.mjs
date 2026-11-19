// scripts/build-ipfs-js.mjs tests: the GitHub→IPFS baking that feeds the
// TUI bridge. parseWorkflow covers every needs shape YAML allows
// (single-line, bracket list, multiline list, quoted values, absent
// name); extractWorkflows and resolveGitMeta run against real fixture
// repos built in temp dirs (same pattern as git-notes-bridge.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveGitMeta,
  parseWorkflow,
  extractWorkflows
} from '../scripts/build-ipfs-js.mjs';

const CWD = process.cwd();

function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-meta-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const git = (args) =>
    execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  git(['init', '-q', '-b', 'main']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return { dir, git };
}

test('parseWorkflow reads name, jobs, runs-on, and single-line needs', () => {
  const wf = parseWorkflow(
    'deploy.yml',
    [
      'name: Deploy',
      'on:',
      '  push:',
      'jobs:',
      '  changed:',
      '    runs-on: ubuntu-latest',
      '  build:',
      '    needs: changed',
      "    runs-on: 'ubuntu-24.04'",
      ''
    ].join('\n')
  );
  assert.equal(wf.name, 'Deploy');
  assert.equal(wf.file, 'deploy.yml');
  assert.deepEqual(wf.jobs, [
    { name: 'changed', runs_on: 'ubuntu-latest', needs: '' },
    { name: 'build', runs_on: 'ubuntu-24.04', needs: 'changed' }
  ]);
});

test('parseWorkflow handles bracket and multiline needs lists', () => {
  const bracket = parseWorkflow(
    'a.yml',
    ['jobs:', '  test:', '    runs-on: ubuntu-latest', '  release:', '    needs: [test, lint]', '    runs-on: ubuntu-latest'].join('\n')
  );
  assert.equal(bracket.jobs[1].needs, 'test, lint');
  const multiline = parseWorkflow(
    'b.yml',
    ['jobs:', '  lint:', '    runs-on: ubuntu-latest', '  test:', '    needs:', '      - lint', '      - build', '    runs-on: ubuntu-latest'].join('\n')
  );
  assert.equal(multiline.jobs[1].needs, 'lint, build');
});

test('parseWorkflow falls back to the filename and skips comments', () => {
  const wf = parseWorkflow(
    'ci.yml',
    ['# head comment', 'jobs:', '  # job comment', '  smoke:', '    runs-on: ubuntu-latest # trailing'].join('\n')
  );
  assert.equal(wf.name, 'ci.yml');
  assert.equal(wf.jobs.length, 1);
  assert.equal(wf.jobs[0].runs_on, 'ubuntu-latest');
});

test('extractWorkflows walks a fixture .github/workflows directory', () => {
  const { dir } = makeRepo({
    '.github/workflows/one.yml': 'name: One\njobs:\n  a:\n    runs-on: ubuntu-latest\n',
    '.github/workflows/two.yaml': 'name: Two\njobs:\n  b:\n    runs-on: ubuntu-latest\n',
    '.github/workflows/not-a-workflow.txt': 'ignored\n'
  });
  const wfs = extractWorkflows(dir);
  assert.deepEqual(wfs.map((w) => w.name).sort(), ['One', 'Two']);
});

test('extractWorkflows reads the real repo with needs chains intact', () => {
  const wfs = extractWorkflows(CWD);
  assert.ok(wfs.length >= 5, `expected the repo's workflows, got ${wfs.length}`);
  const deploy = wfs.find((w) => w.file === 'deploy-gh-pages.yml');
  assert.ok(deploy, 'deploy-gh-pages.yml present');
  const build = deploy.jobs.find((j) => j.name === 'build-and-deploy');
  assert.equal(build.needs, 'changed');
});

test('resolveGitMeta reports release and dirtiness state on a fixture repo', () => {
  const { dir, git } = makeRepo({ 'file.txt': 'x\n' });
  execFileSync('git', ['add', 'file.txt'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'add file'], { cwd: dir });
  git(['tag', 'v1.0.0']);
  fs.writeFileSync(path.join(dir, 'dirty.txt'), 'dirty');
  const meta = resolveGitMeta(dir);
  assert.equal(meta.branch, 'main');
  assert.equal(meta.latestTag, 'v1.0.0');
  assert.equal(meta.dirty, true);
  assert.match(meta.commitCount, /^\d+$/);
});

test('resolveGitMeta on this repo yields the release fields the TUI shows', () => {
  const meta = resolveGitMeta(CWD);
  assert.match(meta.latestTag, /^v\d+\.\d+\.\d+$/);
  assert.match(meta.commitCount, /^\d+$/);
  assert.ok(Array.isArray(meta.tags));
  assert.equal(meta.tags[0].tag, meta.latestTag, 'tags sorted newest first');
});
