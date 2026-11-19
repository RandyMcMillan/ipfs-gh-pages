// scripts/overlay-tui.mjs tests: the ref-resolution contract for the
// TUI overlay. The zip download/unzip paths are exercised by the release
// and deploy pipelines themselves; here we lock the precedence rules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRef, DEFAULT_ACTION_REPO } from '../scripts/overlay-tui.mjs';

test('resolveRef: explicit env override wins', () => {
  assert.equal(
    resolveRef({ env: { IPFS_GH_PAGES_ACTION_REF: 'v9.9.9' }, contextSha: 'abc' }),
    'v9.9.9'
  );
});

test('resolveRef: workflow context SHA is next', () => {
  assert.equal(resolveRef({ env: {}, contextSha: 'deadbeef' }), 'deadbeef');
});

test('resolveRef: null when neither — caller falls back to newest release', () => {
  assert.equal(resolveRef({ env: {} }), null);
});

test('the default action repo is this project', () => {
  assert.equal(DEFAULT_ACTION_REPO, 'RandyMcMillan/ipfs-gh-pages');
});
