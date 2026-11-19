// Bridge contract test: src/ipfs.rs (Rust snapshot extraction) and
// js/ipfs-node.js + js/github-actions.js (JS state producers) must agree
// on the shape of every __ipfsState section. The CONTRACT table below is
// the lock: changing either side without updating it fails this suite.
// The wasm host can't run in node, so both sides are verified textually
// against the contract — the same discipline as action-metadata.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const RUST = fs.readFileSync('src/ipfs.rs', 'utf8');
const JS = fs.readFileSync('js/ipfs-node.js', 'utf8');
const ACTIONS_JS = fs.readFileSync('js/github-actions.js', 'utf8');

// The contract: section -> fields both sides must implement.
// camelCase is the JS wire format; the paired RUST_SNAKE entries name
// fields Rust stores under a different Rust-side identifier.
const CONTRACT = {
  repo: [
    'owner', 'name', 'version', 'files', 'readme', 'workflows', 'actions',
    'branch', 'lastCommitMsg', 'lastCommitTime', 'shortSha', 'commitCount',
    'latestTag', 'commitsSinceTag', 'upstream', 'ahead', 'behind', 'dirty'
  ],
  repoTags: ['tag', 'date', 'subject'],
  workflows: ['file', 'name', 'jobs'],
  workflowJobs: ['name', 'runs_on', 'needs'],
  actions: ['runs', 'error', 'updatedAt'],
  actionRun: ['status', 'conclusion', 'runNumber', 'headBranch'],
  node: ['status', 'peerId', 'multiaddrs', 'connections'],
  connections: ['peer', 'addr', 'direction'],
  chatInbox: ['signer', 'verified', 'text', 'timestamp'],
  issues: ['cid', 'title', 'timestamp'],
  kubo: ['status', 'endpoint', 'peerId'],
  services: ['configured'],
  git: ['serving', 'seen']
};

// Extract the poll() body (the wasm implementation — the stub is empty).
const pollBody = RUST.match(/pub fn poll\(\) -> Snapshot \{([\s\S]*?)\n    \}/);
assert.ok(pollBody, 'poll() found in src/ipfs.rs');
const POLL = pollBody[1];
assert.ok(POLL.includes('Reflect'), 'this is the wasm poll, not the stub');

// --- Rust side ------------------------------------------------------------

function rustHasGetter(receiver, key, kind = 'get_string') {
  const re = new RegExp(`${kind}\\(&${receiver}, "${key}"\\)`);
  return re.test(POLL);
}

test('Rust poll extracts every repo field the JS serves', () => {
  for (const key of CONTRACT.repo) {
    if (key === 'actions') continue; // Reflect-read, covered by its own test below
    const kind = key === 'files' || key === 'workflows' || key === 'tags' ? 'get_array' : key === 'dirty' ? 'get_bool' : 'get_string';
    assert.ok(rustHasGetter('repo', key, kind), `src/ipfs.rs poll must read repo.${key}`);
  }
});

test('Rust poll extracts nested repo collections with their item fields', () => {
  for (const key of CONTRACT.repoTags) {
    assert.ok(rustHasGetter('t', key), `src/ipfs.rs poll must read tag.${key}`);
  }
  for (const key of CONTRACT.workflowJobs) {
    assert.ok(rustHasGetter('j', key), `src/ipfs.rs poll must read workflow job.${key}`);
  }
  for (const key of ['file', 'name']) {
    assert.ok(rustHasGetter('w', key), `src/ipfs.rs poll must read workflow.${key}`);
  }
  assert.ok(/get_array\(&repo, "tags"\)/.test(POLL), 'poll reads repo.tags');
  assert.ok(/get_array\(&repo, "workflows"\)/.test(POLL), 'poll reads repo.workflows');
});

test('Rust poll extracts the actions section and its run fields', () => {
  assert.ok(POLL.includes('from_str("actions")'), 'poll reads repo.actions');
  assert.ok(rustHasGetter('actions', 'error'), 'poll reads actions.error');
  assert.ok(/get_array\(&actions, "runs"\)/.test(POLL), 'poll reads actions.runs');
  for (const key of CONTRACT.actionRun) {
    assert.ok(rustHasGetter('run', key), `src/ipfs.rs poll must read run.${key}`);
  }
  // camelCase wire key vs snake_case Rust field is deliberate — lock it
  assert.ok(rustHasGetter('run', 'runNumber'), 'run.runNumber is camelCase on the wire');
  assert.ok(POLL.includes('run_number:'), 'run_number is snake_case in the struct');
});

test('Rust poll extracts live node state sections', () => {
  for (const key of ['status', 'peerId']) {
    assert.ok(rustHasGetter('node', key), `poll reads node.${key}`);
  }
  assert.ok(/get_array\(&node, "multiaddrs"\)/.test(POLL), 'poll reads node.multiaddrs');
  assert.ok(/get_array\(&node, "connections"\)/.test(POLL), 'poll reads node.connections');
  for (const key of CONTRACT.connections) {
    assert.ok(rustHasGetter('c', key), `poll reads connection.${key}`);
  }
  assert.ok(/get_array\(&chat, "inbox"\)/.test(POLL), 'poll reads chat.inbox');
  for (const key of CONTRACT.chatInbox) {
    const kind = key === 'verified' ? 'get_bool' : 'get_string';
    assert.ok(rustHasGetter('m', key, kind), `poll reads chat message.${key}`);
  }
  assert.ok(/get_array\(&state, "issues"\)/.test(POLL), 'poll reads state.issues');
  for (const key of CONTRACT.issues) {
    assert.ok(rustHasGetter('m', key), `poll reads issue.${key}`);
  }
  for (const key of CONTRACT.kubo) {
    assert.ok(rustHasGetter('kubo', key), `poll reads kubo.${key}`);
  }
  assert.ok(/get_array\(&services, "configured"\)/.test(POLL), 'poll reads services.configured');
  assert.ok(/get_array\(&git, "seen"\)/.test(POLL), 'poll reads git.seen');
  assert.ok(POLL.includes('from_str("serving")'), 'poll reads git.serving');
});

// --- JS side --------------------------------------------------------------

function jsSlice(startRe, endRe) {
  const start = JS.search(startRe);
  assert.ok(start >= 0, `js/ipfs-node.js contains ${startRe}`);
  const end = JS.slice(start).search(endRe);
  assert.ok(end > 0, `slice ends after ${startRe}`);
  return JS.slice(start, start + end);
}

test('JS state.repo literal carries the identity, files, workflows, and actions', () => {
  const repo = jsSlice(/repo:\s*\{/, /\n  \},\n/);
  for (const key of ['owner', 'name', 'fullName', 'version', 'files', 'readme', 'workflows', 'actions']) {
    assert.ok(new RegExp(`\\b${key}:`).test(repo), `state.repo has ${key}`);
  }
});

test('JS repoGitMeta carries every baked git field', () => {
  const meta = jsSlice(/const repoGitMeta = \{/, /\n\};/);
  for (const key of CONTRACT.repo) {
    if (['owner', 'name', 'version', 'files', 'readme', 'workflows', 'actions'].includes(key)) continue;
    assert.ok(new RegExp(`\\b${key}:`).test(meta), `repoGitMeta has ${key}`);
  }
});

test('JS initializes actions state with the contracted fields', () => {
  const actions = jsSlice(/actions: \{/, /\}/);
  for (const key of CONTRACT.actions) {
    assert.ok(new RegExp(`\\b${key}:`).test(actions), `state.repo.actions has ${key}`);
  }
});

test('JS live sections declare the contracted shapes', () => {
  assert.ok(/node: \{ status: 'starting', peerId: null, multiaddrs: \[\], protocols: \[\], connections: \[\] \}/.test(JS), 'node literal shape');
  assert.ok(/\{ signer, verified, text, timestamp \}/.test(JS), 'chat inbox item shape');
  assert.ok(/\{ cid, title, timestamp \}/.test(JS), 'issue item shape');
  assert.ok(/kubo: \{ status: 'unknown', endpoint: null, peerId: null/.test(JS), 'kubo literal shape');
  assert.ok(/services: \{ configured: \[\], endpoints: \{\} \}/.test(JS), 'services literal shape');
  assert.ok(/git: \{ serving: null, seen: \[\] \}/.test(JS), 'git literal shape');
});

test('JS actions matcher returns the contracted run shape', () => {
  const norm = ACTIONS_JS.match(/return \{\s*status:[\s\S]*?\};/);
  assert.ok(norm, 'normalizeRun return found');
  for (const key of CONTRACT.actionRun) {
    assert.ok(new RegExp(`\\b${key}:`).test(norm[0]), `normalizeRun returns ${key}`);
  }
});
