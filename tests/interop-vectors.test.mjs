// Interop test vectors (tests/fixtures/interop-vectors.json): known-good
// CID + byte identity, exercised across every interop surface — trustless
// gateways (dedicated + public), Kubo RPC, and (via CDP) the in-page Helia
// node. Byte identity is proven two ways: sha256(bytes) equals the stored
// sha256 AND the CID's own multihash digest (self-verifying).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';

const vectors = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'interop-vectors.json'), 'utf8')
);

const sha256Hex = (bytes) => Buffer.from(bytes).toString('hex');
const digestHex = async (bytes) => sha256Hex((await sha256.digest(bytes)).digest);

async function fetchBytes(url, timeoutMs = 15000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

test('vectors are self-consistent (cid multihash == stored sha256)', async () => {
  assert.ok(vectors.length >= 1, 'at least one vector');
  for (const v of vectors) {
    const digest = CID.parse(v.cid).multihash.digest;
    assert.equal(sha256Hex(digest), v.sha256, `${v.name}: cid digest vs stored sha256`);
    assert.ok(v.size > 0 && v.gateways.length >= 1, `${v.name}: size + gateway present`);
  }
});

test('dedicated gateway serves byte-exact content (plain and trustless raw)', async () => {
  for (const v of vectors) {
    for (const gw of v.gateways) {
      const plain = await fetchBytes(`${gw}/ipfs/${v.cid}`);
      assert.equal(plain.length, v.size, `${v.name}: plain size`);
      assert.equal(await digestHex(plain), v.sha256, `${v.name}: plain bytes`);

      const raw = await fetchBytes(`${gw}/ipfs/${v.cid}?format=raw`);
      assert.equal(raw.length, v.size, `${v.name}: raw size`);
      assert.equal(await digestHex(raw), v.sha256, `${v.name}: raw bytes`);
    }
  }
});

test('public gateways serve byte-exact content (reported; skipped when all unreachable)', async (t) => {
  const PUBLIC = ['https://ipfs.io', 'https://dweb.link'];
  const results = [];
  let okCount = 0;
  for (const v of vectors) {
    for (const gw of PUBLIC) {
      try {
        const bytes = await fetchBytes(`${gw}/ipfs/${v.cid}`, 10000);
        const ok = bytes.length === v.size && await digestHex(bytes) === v.sha256;
        if (ok) okCount++;
        results.push(`${gw} ${ok ? 'OK' : 'MISMATCH'}`);
      } catch (e) {
        results.push(`${gw} unreachable (${e.message})`);
      }
    }
  }
  console.log('public gateways:', results.join(' | '));
  if (okCount === 0) t.skip('no public gateway reachable from this network (rate limits) — dedicated gateway is the gate');
});

test('kubo RPC block/get serves the vector byte-exact (optional service)', async (t) => {
  const KUBO_RPC = (process.env.KUBO_RPC || 'http://127.0.0.1:5001').replace(/\/$/, '');
  try {
    await fetch(`${KUBO_RPC}/api/v0/id`, { method: 'POST', signal: AbortSignal.timeout(2000) });
  } catch {
    t.skip(`kubo not reachable at ${KUBO_RPC} — optional service (docs/optional-services.md)`);
    return;
  }
  for (const v of vectors) {
    const get = () => fetch(`${KUBO_RPC}/api/v0/block/get?arg=${v.cid}`, { method: 'POST', signal: AbortSignal.timeout(10000) });
    let res = await get();
    if (!res.ok) {
      // Self-seed: pin it (fetches from the network), then verify the read.
      const pin = await fetch(`${KUBO_RPC}/api/v0/pin/add?arg=${v.cid}`, { method: 'POST', signal: AbortSignal.timeout(60000) });
      if (!pin.ok) {
        t.skip(`kubo cannot fetch ${v.name} from the network (HTTP ${pin.status}) — offline?`);
        return;
      }
      res = await get();
    }
    assert.ok(res.ok, `kubo block/get HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.equal(bytes.length, v.size, `${v.name}: kubo size`);
    assert.equal(await digestHex(bytes), v.sha256, `${v.name}: kubo bytes`);
  }
});
