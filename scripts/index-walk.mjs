// Issues-index DAG collector (docs/issues-car.md build phase 6): from index
// tip CID(s), walk the hash-chained index entries (prev / merge parents) and
// every note/comment reachable via `added` + `parent`, staging the blocks
// into the local blockstore so a CAR export can carry the whole tracker.
// Fetching is injected — callers pass fetchBlock(cid) -> Uint8Array | null;
// build-car.mjs wires Kubo RPC + trustless gateways, tests wire an in-memory
// store. Missing blocks are reported, never fatal (partial chains still
// carry the entries that resolved).
import { CID } from 'multiformats/cid';
import * as dagJson from '@ipld/dag-json';

function asCid(value) {
  if (value instanceof CID) return value;
  return CID.parse(String(value));
}

// helia: any { blockstore } with has/get/put; tips: index tip CIDs (strings
// or CIDs); fetchBlock: async cid -> bytes | null. options.maxBlocks bounds
// the walk (default 2000). Returns { collected, missing, seen } counts.
export async function collectIndexBlocks(helia, tips, fetchBlock, options = {}) {
  const maxBlocks = options.maxBlocks ?? 2000;
  const seen = new Set();
  const missing = [];
  let collected = 0;

  async function getBlock(cid) {
    if (await helia.blockstore.has(cid)) return helia.blockstore.get(cid);
    const key = cid.toString();
    if (seen.has(key)) return null;
    seen.add(key);
    let bytes = null;
    try { bytes = await fetchBlock(cid); } catch { bytes = null; }
    if (!bytes) { missing.push(key); return null; }
    await helia.blockstore.put(cid, bytes);
    collected++;
    return bytes;
  }

  async function walkEntry(cid) {
    if (collected >= maxBlocks) return;
    const bytes = await getBlock(cid);
    if (!bytes) return;
    let entry;
    try { entry = dagJson.decode(bytes); } catch { return; }
    for (const p of Array.isArray(entry?.prev) ? entry.prev : []) {
      try { await walkEntry(asCid(p)); } catch {}
    }
    for (const a of Array.isArray(entry?.added) ? entry.added : []) {
      try { await walkNote(asCid(a)); } catch {}
    }
  }

  async function walkNote(cid) {
    if (collected >= maxBlocks) return;
    const bytes = await getBlock(cid);
    if (!bytes) return;
    let note;
    try { note = dagJson.decode(bytes); } catch { return; }
    if (note?.parent) {
      try { await walkNote(asCid(note.parent)); } catch {}
    }
    // `anchors` names code-DAG CIDs (repo root/dir/file) — intentionally not
    // followed: the release CAR carries the current tree, and pulling old
    // roots in through the tracker would bloat it with stale snapshots.
  }

  for (const tip of tips) {
    try { await walkEntry(asCid(tip)); } catch {}
  }
  return { collected, missing, seen: seen.size };
}
