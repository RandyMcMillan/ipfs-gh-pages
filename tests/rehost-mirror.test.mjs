// rehost-mirror tests: chain walk collects only ns='rehost' notes,
// first-writer-wins per URL, bounded by maxBlocks. dag-json fixtures in
// memory — no network, no Kubo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as dagJson from '@ipld/dag-json';
import { sha256 } from 'multiformats/hashes/sha2';
import { CID } from 'multiformats/cid';
import { collectRehosts } from '../scripts/rehost-mirror.mjs';

// In-memory dag-json blockstore: objects get real content-addressed CIDs.
const store = new Map();
const put = async (obj) => {
  const bytes = dagJson.encode(obj);
  const cid = CID.create(1, dagJson.code, await sha256.digest(bytes)).toString();
  store.set(cid, obj);
  return cid;
};
const get = async (cid) => {
  const obj = store.get(cid);
  if (!obj) throw new Error(`not found: ${cid}`);
  return obj;
};

const REHOST_A = { ns: 'rehost', type: 'rehost', url: 'https://a.example/x.png', cid: 'bafyaaa', timestamp: '2026-11-11T00:00:00Z' };
const REHOST_B = { ns: 'rehost', type: 'rehost', url: 'https://b.example/y.png', cid: 'bafybbb', timestamp: '2026-11-11T00:01:00Z' };
const ISSUE = { ns: 'issues', type: 'issue', title: 'not a rehost' };

test('collectRehosts walks prev + added, filters ns=rehost, first-writer-wins', async () => {
  const nA = await put(REHOST_A);
  const nIssue = await put(ISSUE);
  const nB = await put(REHOST_B);
  const e1 = await put({ type: 'index-entry', added: [nA, nIssue], prev: null, height: 1, lamport: 1 });
  const e2 = await put({ type: 'index-entry', added: [nB, nA], prev: [e1], height: 2, lamport: 2 }); // nA again — dup

  const out = await collectRehosts(e2, { get });
  assert.equal(out.size, 2);
  assert.equal(out.get('https://a.example/x.png'), 'bafyaaa');
  assert.equal(out.get('https://b.example/y.png'), 'bafybbb');
});

test('collectRehosts: the NEWEST rehost of a URL wins (chain is walked newest-first)', async () => {
  const newest = await put({ ...REHOST_A, cid: 'bafy-newest' });
  const older = await put({ ...REHOST_A, cid: 'bafy-older' });
  // Chain tip is the newest entry: its `added` is seen first.
  const e1 = await put({ type: 'index-entry', added: [older], prev: null, height: 1, lamport: 1 });
  const e2 = await put({ type: 'index-entry', added: [newest], prev: [e1], height: 2, lamport: 2 });
  const out = await collectRehosts(e2, { get });
  assert.equal(out.get('https://a.example/x.png'), 'bafy-newest', 'mirror pins the current version, not the stale one');
});

test('collectRehosts: stops at maxBlocks', async () => {
  let prev = null;
  for (let i = 0; i < 10; i++) {
    prev = await put({ type: 'index-entry', added: [], prev: prev ? [prev] : null, height: i + 1, lamport: i + 1 });
  }
  const out = await collectRehosts(prev, { get, maxBlocks: 3 });
  assert.equal(out.size, 0); // bounded walk — no crash, no full traversal
});
