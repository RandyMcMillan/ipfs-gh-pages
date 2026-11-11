import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLineRange, makeLineCommentFields, isLineCommentNote, commentsByLine } from '../js/line-comments.js';

test('normalizeLineRange: orders, clamps, floors, rejects non-finite', () => {
  assert.deepEqual(normalizeLineRange(3, 7), { start: 3, end: 7 });
  assert.deepEqual(normalizeLineRange(7, 3), { start: 3, end: 7 }, 'reversed selection swaps');
  assert.deepEqual(normalizeLineRange(0, -4), { start: 1, end: 1 }, 'clamped to >= 1');
  assert.deepEqual(normalizeLineRange(2.9, 5.1), { start: 2, end: 5 }, 'floored');
  assert.equal(normalizeLineRange('x', 5), null);
  assert.equal(normalizeLineRange(null, null), null);
  assert.equal(normalizeLineRange(undefined, 5), null);
  assert.equal(normalizeLineRange(Infinity, 5), null);
});

test('makeLineCommentFields: full data-model shape, invalid input -> null', () => {
  const fields = makeLineCommentFields({
    fileCid: 'bafyFILE', start: 9, end: 4, body: '  looks wrong  ',
    timestamp: '2026-11-10T00:00:00.000Z'
  });
  assert.deepEqual(fields, {
    ns: 'review',
    type: 'line-comment',
    anchors: ['bafyFILE'],
    line: { start: 4, end: 9 },
    body: 'looks wrong',
    timestamp: '2026-11-10T00:00:00.000Z'
  });
  assert.equal(makeLineCommentFields({ fileCid: '', start: 1, end: 2, body: 'x', timestamp: 't' }), null);
  assert.equal(makeLineCommentFields({ fileCid: 'c', start: 1, end: 2, body: '   ', timestamp: 't' }), null, 'blank body');
  assert.equal(makeLineCommentFields({ fileCid: 'c', start: 1, end: 2, body: 'x', timestamp: '' }), null);
  assert.equal(makeLineCommentFields({ fileCid: 'c', start: 'a', end: 2, body: 'x', timestamp: 't' }), null);
});

test('isLineCommentNote: accepts valid notes, rejects malformed or wrong-namespace', () => {
  const valid = {
    ns: 'review', type: 'line-comment', anchors: ['bafyFILE'],
    line: { start: 2, end: 2 }, body: 'x'
  };
  assert.ok(isLineCommentNote(valid));
  assert.ok(!isLineCommentNote({ ...valid, ns: 'issues' }), 'issue namespace is not a line comment');
  assert.ok(!isLineCommentNote({ ...valid, type: 'comment' }));
  assert.ok(!isLineCommentNote({ ...valid, anchors: [] }), 'needs an anchor');
  assert.ok(!isLineCommentNote({ ...valid, line: null }), 'needs a line range');
  assert.ok(!isLineCommentNote({ ...valid, line: { start: 'x', end: 3 } }), 'line must be numeric');
  assert.ok(!isLineCommentNote(null));
});

test('commentsByLine: expands ranges per line, sorts deterministically, skips invalid', () => {
  const a = { cid: 'a', start: 2, end: 4 };
  const b = { cid: 'b', start: 3, end: 3 };
  const c = { cid: 'c', start: 1, end: 2 };
  const bad = { cid: 'x', start: 'nope', end: 3 };
  const map = commentsByLine([a, b, c, bad]);
  assert.equal(map.size, 4, 'lines 1–4 covered');
  assert.deepEqual(map.get(1).map((x) => x.cid), ['c']);
  assert.deepEqual(map.get(2).map((x) => x.cid), ['c', 'a'], 'per-line lists sorted by start');
  assert.deepEqual(map.get(3).map((x) => x.cid), ['a', 'b']);
  assert.deepEqual(map.get(4).map((x) => x.cid), ['a']);
  assert.ok(!map.has(5));
  assert.ok([...map.values()].every((list) => list.every((x) => x.cid !== 'x')), 'invalid ranges skipped');
  assert.deepEqual([...commentsByLine([]).keys()], []);
});
