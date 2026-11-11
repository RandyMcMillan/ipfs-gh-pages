// Line comments (docs/issues-car.md phase 9): pure helpers shared shape
// logic between the web app and anything else that renders `line-comment`
// notes. A line comment anchors to ONE exact blob CID plus a 1-based,
// inclusive line range — the (cid, line) coordinate is immutable because
// the CID pins the content. Unit-tested in tests/line-comments.test.mjs.

// Order-agnostic range: accepts reversed selections, clamps to >= 1,
// floors fractions. Returns { start, end } or null when either side is
// missing (null/undefined) or not a finite number.
export function normalizeLineRange(start, end) {
  if (start == null || end == null) return null;
  let s = Number(start);
  let e = Number(end);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  s = Math.max(1, Math.floor(s));
  e = Math.max(1, Math.floor(e));
  return s <= e ? { start: s, end: e } : { start: e, end: s };
}

// The signed-note payload for a line comment (signature/signer are added
// by the caller's signNote). Null when any required field is missing.
export function makeLineCommentFields({ fileCid, start, end, body, timestamp }) {
  const line = normalizeLineRange(start, end);
  const text = String(body || '').trim();
  if (!fileCid || !line || !text || !timestamp) return null;
  return {
    ns: 'review',
    type: 'line-comment',
    anchors: [String(fileCid)],
    line,
    body: text,
    timestamp
  };
}

// Shape guard for a decoded note object (used before rendering fetched
// comments — a valid signature on a malformed note still must not render
// as a line comment).
export function isLineCommentNote(note) {
  return Boolean(
    note &&
    note.ns === 'review' &&
    note.type === 'line-comment' &&
    Array.isArray(note.anchors) &&
    note.anchors.length > 0 &&
    normalizeLineRange(note.line?.start, note.line?.end)
  );
}

// comments: [{ cid, start, end, ... }] (stored index entries or decoded
// notes). Returns Map<lineNumber, comment[]> covering every line in each
// comment's range; per-line lists sorted by (start, cid) so rendering is
// deterministic.
export function commentsByLine(comments) {
  const map = new Map();
  for (const comment of comments) {
    const range = normalizeLineRange(comment.start, comment.end);
    if (!range) continue;
    for (let line = range.start; line <= range.end; line++) {
      if (!map.has(line)) map.set(line, []);
      map.get(line).push(comment);
    }
  }
  for (const list of map.values()) {
    list.sort((a, b) => (a.start - b.start) || String(a.cid).localeCompare(String(b.cid)));
  }
  return map;
}
