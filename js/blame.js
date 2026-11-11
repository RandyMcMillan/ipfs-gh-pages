// Blame attribution (docs/issues-car.md phase 11): the root chain makes
// history walkable; blame maps each line of the current file to the
// OLDEST release whose version of the file contains that exact line text
// (exact line-text match is the MVP correlation heuristic — git's blame
// uses content + context; see the doc's open questions). Pure logic, no
// DOM/network: file contents are fetched through an injected callback so
// tests stay offline. Unit-tested in tests/blame.test.mjs.

// Normalize a stored/fetched release record. Returns
// { cid, root, timestamp } or null. `cid` is the release object's own CID
// (the chain link); `root` is the published repo root it names.
export function asRelease(record) {
  if (!record || typeof record !== 'object') return null;
  const cid = String(record.cid || '').trim();
  const root = String(record.root || '').trim();
  if (!cid || !root) return null;
  return { cid, root, timestamp: record.timestamp || null };
}

// Newest-first tip list; dedups by cid, keeps order, drops malformed.
export function collectReleases(tips) {
  const seen = new Set();
  const out = [];
  for (const tip of tips || []) {
    const rel = asRelease(tip);
    if (rel && !seen.has(rel.cid)) {
      seen.add(rel.cid);
      out.push(rel);
    }
  }
  return out;
}

// Per-line origin attribution.
//   currentLines: string[] — the file as rendered now.
//   releases: newest-first [{ cid, root, timestamp }].
//   fetchFileLines(root) -> Promise<string[] | null> — the file's lines in
//     that release's root, or null when absent/unfetchable.
// Resolves to an array parallel to currentLines: the release each line
// attributes to, or null when nothing matched (only possible when every
// fetch failed). Matching is multiset-exact: a run of N identical lines
// needs N occurrences in the older version before the oldest extras are
// consumed.
export async function blameLines(currentLines, releases, fetchFileLines) {
  const origins = new Array(currentLines.length).fill(null);
  const unmatched = new Set(currentLines.map((_, i) => i));
  for (let i = releases.length - 1; i >= 0 && unmatched.size > 0; i--) {
    let lines = null;
    try { lines = await fetchFileLines(releases[i].root); } catch { lines = null; }
    if (!Array.isArray(lines)) continue;
    const counts = new Map();
    for (const line of lines) counts.set(line, (counts.get(line) || 0) + 1);
    for (const idx of unmatched) {
      const line = currentLines[idx];
      const remaining = counts.get(line) || 0;
      if (remaining > 0) {
        counts.set(line, remaining - 1);
        origins[idx] = releases[i];
        unmatched.delete(idx);
      }
    }
  }
  return origins;
}

// blame-comment coordinate match (docs/issues-car.md): a blame comment
// filed as { origin: <root CID>, line: { start } } surfaces on any later
// version whose blame attributes that same line number to the same origin.
export function blameCommentMatches(comment, originRoot, lineNumber) {
  return Boolean(
    comment &&
    String(comment.origin || '') === String(originRoot || '') &&
    Number(comment.line) === Number(lineNumber)
  );
}
