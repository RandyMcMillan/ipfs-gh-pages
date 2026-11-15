// Local Kubo RPC probe + CAR hand-off. The app runs next to a Kubo on the
// user's machine more often than not (the deploy docs assume one); probing
// 127.0.0.1:5001 lets the page offer live actions instead of dead commands.
// The CSP already permits connect-src http://127.0.0.1:5001.
//
// kuboHandoff is the loop-closer: exportCarBytes(cid) from the in-page node
// → POST /api/v0/dag/import (any codec) → pin/add. What the user just hit —
// "ipfs pin add" failing on a block only the browser has — disappears: the
// page pushes the block, then pins it. Pure + injectable for tests.
import { CID } from 'multiformats/cid';

export const KUBO_RPC_DEFAULT = 'http://127.0.0.1:5001';
// The user's Kubo is NOT always on 5001 (custom configs, parallel daemons,
// dev setups) — probe the whole common RPC range, same list as the
// Peer-settings probe. First answer wins; ports after it never fire.
export const KUBO_RPC_PORTS = Array.from({ length: 10 }, (_, i) => String(5001 + i));

export async function probeKubo({ endpoint = '', fetchImpl = fetch, timeoutMs = 1200 } = {}) {
  if (endpoint) return probeEndpoint(endpoint, fetchImpl, timeoutMs);
  for (const port of KUBO_RPC_PORTS) {
    const hit = await probeEndpoint(`http://127.0.0.1:${port}`, fetchImpl, timeoutMs);
    if (hit) return hit;
  }
  return null;
}

async function probeEndpoint(endpoint, fetchImpl, timeoutMs) {
  try {
    const res = await fetchImpl(`${endpoint}/api/v0/id`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j && j.ID ? { endpoint, peerId: j.ID, agentVersion: j.AgentVersion || '' } : null;
  } catch {
    return null; // nothing there / not a Kubo RPC — try the next port
  }
}

export async function importCar(carBytes, { endpoint = KUBO_RPC_DEFAULT, fetchImpl = fetch } = {}) {
  const form = new FormData();
  form.append('file', new Blob([carBytes], { type: 'application/vnd.ipfs.car' }), 'export.car');
  const res = await fetchImpl(`${endpoint}/api/v0/dag/import`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`dag import HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

export async function pinAdd(cid, { endpoint = KUBO_RPC_DEFAULT, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${endpoint}/api/v0/pin/add?arg=${encodeURIComponent(cid)}`, { method: 'POST' });
  if (!res.ok) throw new Error(`pin add HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

// Full hand-off: export the DAG from the in-page node, import to Kubo, pin.
export async function kuboHandoff(cid, { exportCarBytes, endpoint = KUBO_RPC_DEFAULT, fetchImpl = fetch } = {}) {
  if (typeof exportCarBytes !== 'function') throw new Error('exportCarBytes is required');
  // exportCarBytes feeds CarWriter.create — it needs a CID object, not the
  // string that callers naturally have.
  const root = typeof cid === 'string' ? CID.parse(cid) : cid;
  const carBytes = await exportCarBytes(root);
  await importCar(carBytes, { endpoint, fetchImpl });
  await pinAdd(cid, { endpoint, fetchImpl });
  return { bytes: carBytes.length };
}
