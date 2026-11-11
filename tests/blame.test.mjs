import test from 'node:test';
import assert from 'node:assert/strict';
import { asRelease, collectReleases, blameLines, blameCommentMatches } from '../js/blame.js';

test('asRelease: keeps valid records, drops malformed', () => {
  assert.deepEqual(asRelease({ cid: 'baguqA', root: 'bafyR', timestamp: 't1' }), { cid: 'baguqA', root: 'bafyR', timestamp: 't1' });
  assert.equal(asRelease({ cid: '', root: 'bafyR' }), null);
  assert.equal(asRelease({ cid: 'baguqA', root: '' }), null);
  assert.equal(asRelease(null), null);
  assert.equal(asRelease('nope'), null);
});

test('collectReleases: dedups by cid, preserves newest-first order', () => {
  const out = collectReleases([
    { cid: 'c2', root: 'r2', timestamp: 't2' },
    { cid: 'c1', root: 'r1', timestamp: 't1' },
    { cid: 'c2', root: 'r2dup', timestamp: 'tx' },
    null,
    { cid: 'c3', root: '' }
  ]);
  assert.deepEqual(out.map((r) => r.cid), ['c2', 'c1']);
  assert.equal(out[0].root, 'r2', 'first occurrence wins');
});

test('blameLines: attributes each line to the OLDEST release containing it', async () => {
  const releases = [
    { cid: 'c2', root: 'r2', timestamp: 't2' },
    { cid: 'c1', root: 'r1', timestamp: 't1' },
    { cid: 'c0', root: 'r0', timestamp: 't0' }
  ];
  const files = {
    r0: ['a', 'b'],
    r1: ['a', 'b', 'c'],
    r2: ['a', 'b', 'c', 'd']
  };
  const origins = await blameLines(['a', 'b', 'c', 'd'], releases, async (root) => files[root] || null);
  assert.deepEqual(origins.map((o) => o && o.root), ['r0', 'r0', 'r1', 'r2']);
});

test('blameLines: multiset matching — duplicate lines need duplicate occurrences', async () => {
  const releases = [{ cid: 'c0', root: 'r0', timestamp: 't0' }];
  const single = await blameLines(['x', 'x'], releases, async () => ['x']);
  assert.deepEqual(single.map((o) => o && o.root), ['r0', null], 'second unmatched line stays null');
  const both = await blameLines(['x', 'x'], releases, async () => ['x', 'x']);
  assert.deepEqual(both.map((o) => o && o.root), ['r0', 'r0']);
});

test('blameLines: skips unfetchable roots, all-failed yields nulls', async () => {
  const releases = [
    { cid: 'c1', root: 'r1', timestamp: 't1' },
    { cid: 'c0', root: 'r0', timestamp: 't0' }
  ];
  const origins = await blameLines(['a', 'b'], releases, async (root) => (root === 'r0' ? ['a', 'b'] : null));
  assert.deepEqual(origins.map((o) => o && o.root), ['r0', 'r0'], 'null fetch skipped, older root attributes');
  const allFailed = await blameLines(['a'], releases, async () => null);
  assert.deepEqual(allFailed, [null]);
  assert.deepEqual(await blameLines([], releases, async () => { throw new Error('never called'); }), []);
});

test('blameCommentMatches: origin root + line number, both must match', () => {
  const c = { origin: 'bafyROOT', line: 7 };
  assert.ok(blameCommentMatches(c, 'bafyROOT', 7));
  assert.ok(blameCommentMatches(c, 'bafyROOT', '7'), 'numeric strings coerce');
  assert.ok(!blameCommentMatches(c, 'bafyOTHER', 7));
  assert.ok(!blameCommentMatches(c, 'bafyROOT', 8));
  assert.ok(!blameCommentMatches(null, 'bafyROOT', 7));
});
