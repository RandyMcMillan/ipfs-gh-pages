// Pure fork-choice tests for the index chronology (docs/issues-car.md):
// genesis adoption, fast-forward both directions, and the divergence
// merge — semantics identical in main.js and the bridge because both
// call classifyIndexSync.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIndexSync } from '../js/index-merge.js';

test('genesis: no local tip adopts the remote', () => {
  const r = classifyIndexSync(null, { cid: 'r', height: 3, lamport: 3 }, false, false);
  assert.equal(r.action, 'adopt-remote');
});

test('fast-forward: remote descends from local', () => {
  const r = classifyIndexSync(
    { cid: 'l', height: 2, lamport: 2 },
    { cid: 'r', height: 4, lamport: 4 },
    true, // remote prev-walk reaches local
    false
  );
  assert.equal(r.action, 'adopt-remote');
});

test('noop: local already contains the remote', () => {
  const r = classifyIndexSync(
    { cid: 'l', height: 5, lamport: 5 },
    { cid: 'r', height: 3, lamport: 3 },
    false,
    true // local prev-walk reaches remote
  );
  assert.equal(r.action, 'noop');
});

test('divergence: merge entry with max+1 height and max+1 lamport', () => {
  const r = classifyIndexSync(
    { cid: 'l', height: 3, lamport: 7 },
    { cid: 'r', height: 5, lamport: 2 },
    false,
    false
  );
  assert.equal(r.action, 'merge');
  assert.equal(r.height, 6); // max(3,5)+1
  assert.equal(r.lamport, 8); // max(7,2)+1
});

test('symmetric: same inputs classify identically from either side', () => {
  const local = { cid: 'a', height: 1, lamport: 1 };
  const remote = { cid: 'b', height: 1, lamport: 1 };
  const fromLocal = classifyIndexSync(local, remote, false, false);
  const fromRemote = classifyIndexSync(remote, local, false, false);
  assert.equal(fromLocal.action, 'merge');
  assert.equal(fromRemote.action, 'merge');
  assert.equal(fromLocal.height, fromRemote.height);
  assert.equal(fromLocal.lamport, fromRemote.lamport);
});
