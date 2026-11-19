// js/github-actions.js tests: run normalization, workflow matching
// (path first, name fallback), and the display-label contract (null when
// there is nothing to show — the UI never invents a status).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRun,
  latestRunByWorkflow,
  runLabel
} from '../js/github-actions.js';

const WORKFLOWS = [
  { file: 'deploy-gh-pages.yml', name: 'Deploy IPFS site' },
  { file: 'release.yml', name: 'Release' }
];

const RUNS = [
  {
    name: 'Release',
    path: '.github/workflows/release.yml',
    status: 'completed',
    conclusion: 'success',
    run_number: 42,
    head_branch: 'main',
    created_at: '2026-11-18T01:00:00Z'
  },
  {
    name: 'Deploy IPFS site',
    path: '.github/workflows/deploy-gh-pages.yml',
    status: 'in_progress',
    conclusion: null,
    run_number: 43,
    head_branch: 'main',
    created_at: '2026-11-18T02:00:00Z'
  }
];

test('normalizeRun keeps the rendered fields and defaults the rest', () => {
  assert.deepEqual(normalizeRun(RUNS[0]), {
    status: 'completed',
    conclusion: 'success',
    runNumber: 42,
    headBranch: 'main',
    createdAt: '2026-11-18T01:00:00Z'
  });
  assert.equal(normalizeRun(null), null);
  assert.equal(normalizeRun('x'), null);
  assert.deepEqual(normalizeRun({}), {
    status: '',
    conclusion: '',
    runNumber: null,
    headBranch: '',
    createdAt: ''
  });
});

test('latestRunByWorkflow matches by path and takes the newest first', () => {
  const out = latestRunByWorkflow(WORKFLOWS, RUNS);
  assert.equal(out.length, 2);
  const release = out.find((w) => w.file === 'release.yml');
  assert.equal(release.run.runNumber, 42);
  assert.equal(release.run.conclusion, 'success');
});

test('latestRunByWorkflow falls back to name matching', () => {
  const runs = [{ name: 'Deploy IPFS site', status: 'queued', conclusion: null }];
  const out = latestRunByWorkflow(WORKFLOWS, runs);
  const deploy = out.find((w) => w.file === 'deploy-gh-pages.yml');
  assert.equal(deploy.run.status, 'queued');
  // no run for release → null, never a fabricated status
  const release = out.find((w) => w.file === 'release.yml');
  assert.equal(release.run, null);
});

test('latestRunByWorkflow tolerates garbage input', () => {
  assert.deepEqual(latestRunByWorkflow(null, null), []);
  assert.deepEqual(latestRunByWorkflow(WORKFLOWS, 'nope'), [
    { file: 'deploy-gh-pages.yml', name: 'Deploy IPFS site', run: null },
    { file: 'release.yml', name: 'Release', run: null }
  ]);
});

test('runLabel prefers conclusion, then status, else null', () => {
  assert.equal(runLabel({ status: 'completed', conclusion: 'failure' }), 'failure');
  assert.equal(runLabel({ status: 'in_progress', conclusion: '' }), 'in_progress');
  assert.equal(runLabel({ status: '', conclusion: '' }), null);
  assert.equal(runLabel(null), null);
});
