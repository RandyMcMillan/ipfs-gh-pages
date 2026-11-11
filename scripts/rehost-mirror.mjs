// rehost-mirror (docs/ipfs-rehost-service.md phase 4): walk an issues
// chain from a tip CID, collect the rehost notes ({ns:'rehost', url,
// cid}), and pin every CID they name on Kubo — availability for the
// rehosted set without the origin or the original rehoster.
//
// Usage: node scripts/rehost-mirror.mjs <tipCid> [--dry-run]
// Env: KUBO_RPC (default http://127.0.0.1:5001), INDEX_GATEWAYS
// (comma-separated, default https://ipfs.io) as the fallback block
// source when Kubo doesn't have a block. --dry-run lists, pins nothing.
import { CID } from 'multiformats/cid';
import * as dagJson from '@ipld/dag-json';

const KUBO_RPC = (process.env.KUBO_RPC || 'http://127.0.0.1:5001').replace(/\/$/, '');
const GATEWAYS = (process.env.INDEX_GATEWAYS || 'https://ipfs.io')
  .split(',').map((s) => s.trim()).filter(Boolean);

async function fetchBlock(cidStr) {
  const cid = CID.parse(cidStr);
  try {
    const res = await fetch(`${KUBO_RPC}/api/v0/block/get?arg=${cid}`, { method: 'POST', signal: AbortSignal.timeout(5000) });
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
  } catch {}
  for (const gw of GATEWAYS) {
    try {
      const res = await fetch(`${gw}/ipfs/${cid}?format=raw`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
    } catch {}
  }
  throw new Error(`block not found: ${cidStr}`);
}

const getDagJson = async (cidStr) => dagJson.decode(await fetchBlock(cidStr));

// Collect {url, cid} pairs from the chain reachable from tipCid:
// entries via `prev`, notes via `added`; only ns='rehost' notes count.
export async function collectRehosts(tipCid, { maxBlocks = 2000, get = getDagJson } = {}) {
  const out = new Map(); // url -> cid (first writer wins, deterministic)
  let cursor = tipCid;
  let blocks = 0;
  while (cursor && blocks < maxBlocks) {
    const entry = await get(cursor);
    blocks++;
    for (const noteCid of entry?.added || []) {
      try {
        const note = await get(noteCid);
        blocks++;
        if (note && note.ns === 'rehost' && note.url && note.cid && !out.has(note.url)) {
          out.set(note.url, note.cid);
        }
      } catch {}
    }
    const prev = Array.isArray(entry?.prev) ? entry.prev[0] : null;
    cursor = prev || null;
  }
  return out;
}

const isMain = process.argv[1] && process.argv[1].endsWith('rehost-mirror.mjs');
if (isMain) {
  const tip = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  if (!tip) {
    console.error('usage: node scripts/rehost-mirror.mjs <tipCid> [--dry-run]');
    process.exit(1);
  }
  const rehosts = await collectRehosts(tip);
  console.log(`${rehosts.size} rehost(s) on the chain from ${tip}`);
  let pinned = 0;
  for (const [url, cid] of rehosts) {
    if (dryRun) {
      console.log(`dry-run: ${cid}  ${url}`);
      continue;
    }
    try {
      const res = await fetch(`${KUBO_RPC}/api/v0/pin/add?arg=${cid}`, { method: 'POST', signal: AbortSignal.timeout(30000) });
      if (res.ok) {
        pinned++;
        console.log(`pinned ${cid}  ${url}`);
      } else {
        console.error(`pin failed HTTP ${res.status}: ${cid}  ${url}`);
      }
    } catch (e) {
      console.error(`pin error ${cid}: ${e.message}`);
    }
  }
  console.log(`${pinned} pinned of ${rehosts.size}`);
}
