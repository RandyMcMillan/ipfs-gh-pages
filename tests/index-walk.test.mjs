import test from 'node:test';
import assert from 'node:assert/strict';
import { createHelia } from 'helia';
import { car } from '@helia/car';
import { CarWriter } from '@ipld/car/writer';
import { CarReader } from '@ipld/car/reader';
import { CID } from 'multiformats/cid';
import * as dagJson from '@ipld/dag-json';
import { sha256 } from 'multiformats/hashes/sha2';
import { collectIndexBlocks } from '../scripts/index-walk.mjs';

// helia/@ipld/car use Promise.withResolvers (Node 22+); CI runs Node 20.
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function () {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}

// Same construction as main.js addDagJson: dag-json block, CIDv1, sha256.
async function putDagJson(store, obj) {
  const bytes = dagJson.encode(obj);
  const cid = CID.create(1, dagJson.code, await sha256.digest(bytes));
  await store.put(cid, bytes);
  return cid;
}

async function getDagJson(store, cid) {
  return dagJson.decode(await store.get(cid));
}

// A source "network": fetchBlock serves from this blockstore (or null).
function sourceFetcher(store) {
  return async (cid) => {
    if (!(await store.has(cid))) return null;
    return store.get(cid);
  };
}

// Fixture tracker (docs/issues-car.md shapes):
//   E1 genesis --added--> (nothing)
//   E2 (prev E1) --added--> commentB (parent issueA), commentD (parent commentB)
//   E2' (prev E1) --added--> issueC         (divergent fork)
//   E3 merge (prev [E2, E2']) --added--> []
// issueA is in NO entry's `added` — reachable only by following commentB's
// parent link (its own entry was never published / withheld).
async function buildFixture(store) {
  const anchor = new Uint8Array([1, 2, 3, 4]);
  const anchorCid = CID.create(1, 0x55, await sha256.digest(anchor)); // raw
  await store.put(anchorCid, anchor); // available, but the walk must NOT follow anchors

  const issueA = await putDagJson(store, { ns: 'issues', type: 'issue', anchors: [anchorCid], title: 'A' });
  const commentB = await putDagJson(store, { ns: 'issues', type: 'comment', parent: issueA, body: 'b' });
  const commentD = await putDagJson(store, { ns: 'issues', type: 'comment', parent: commentB, body: 'd' });
  const issueC = await putDagJson(store, { ns: 'issues', type: 'issue', anchors: [], title: 'C' });
  const e1 = await putDagJson(store, { type: 'index-entry', added: [], prev: [], height: 1, lamport: 1 });
  const e2 = await putDagJson(store, { type: 'index-entry', added: [commentB, commentD], prev: [e1], height: 2, lamport: 2 });
  const e2f = await putDagJson(store, { type: 'index-entry', added: [issueC], prev: [e1], height: 2, lamport: 3 });
  const e3 = await putDagJson(store, { type: 'index-entry', added: [], prev: [e2, e2f], height: 3, lamport: 4 });
  return { anchorCid, issueA, commentB, commentD, issueC, e1, e2, e2f, tip: e3 };
}

test('index walk: merges chain + notes into blockstore, skips anchors, exports multi-root CAR', async () => {
  const src = await createHelia({ libp2p: { addresses: { listen: [] } } });
  const dst = await createHelia({ libp2p: { addresses: { listen: [] } } });
  const third = await createHelia({ libp2p: { addresses: { listen: [] } } });
  try {
    const fx = await buildFixture(src.blockstore);

    const walk = await collectIndexBlocks(dst, [fx.tip], sourceFetcher(src.blockstore));
    // 4 entries + 4 notes; the anchor block must stay unfetched.
    assert.equal(walk.collected, 8, 'entry + note blocks staged');
    assert.deepEqual(walk.missing, [], 'nothing missing');
    for (const cid of [fx.tip, fx.e2, fx.e2f, fx.e1, fx.issueA, fx.commentB, fx.commentD, fx.issueC]) {
      assert.ok(await dst.blockstore.has(cid), `staged: ${cid}`);
    }
    assert.ok(!(await dst.blockstore.has(fx.anchorCid)), 'anchors are not followed');
    assert.ok(!walk.missing.includes(fx.anchorCid.toString()), 'anchor not reported missing');

    // Parent-following: issueA sits in no entry's `added` — commentB's
    // parent link is what recovers it.
    const a = await getDagJson(dst.blockstore, fx.issueA);
    assert.equal(a.title, 'A', 'issue recovered via comment parent link');
    const b = await getDagJson(dst.blockstore, fx.commentB);
    assert.equal(b.parent.toString(), fx.issueA.toString(), 'thread chain intact');

    // Round-trip: export the tracker as a CAR rooted at the tip, import
    // into a fresh node, verify the chain and notes decode there.
    const { writer, out } = await CarWriter.create([fx.tip]);
    const chunks = [];
    const collect = (async () => { for await (const c of out) chunks.push(c); })();
    await car(dst).export([fx.tip], writer);
    await collect;
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    chunks.reduce((off, c) => { bytes.set(c, off); return off + c.length; }, 0);

    const reader = await CarReader.fromBytes(bytes);
    assert.deepEqual((await reader.getRoots()).map(String), [fx.tip.toString()], 'tip is the CAR root');
    await car(third).import(reader);

    const tipEntry = await getDagJson(third.blockstore, fx.tip);
    assert.equal(tipEntry.height, 3, 'tip decodes after import');
    const prevs = tipEntry.prev.map(String);
    assert.ok(prevs.includes(fx.e2.toString()) && prevs.includes(fx.e2f.toString()), 'both merge parents linked');
    for (const [entryCid, noteCids] of [[fx.e2, [fx.commentB, fx.commentD]], [fx.e2f, [fx.issueC]]]) {
      const entry = await getDagJson(third.blockstore, entryCid);
      assert.deepEqual(entry.added.map(String), noteCids.map(String), `entry ${entryCid} adds its notes`);
    }
    const comment = await getDagJson(third.blockstore, fx.commentB);
    assert.equal(comment.parent.toString(), fx.issueA.toString(), 'comment parent link intact');
  } finally {
    await src.stop();
    await dst.stop();
    await third.stop();
  }
});

test('index walk: unresolved blocks are reported, resolvable parts still staged, walk survives', async () => {
  const src = await createHelia({ libp2p: { addresses: { listen: [] } } });
  const dst = await createHelia({ libp2p: { addresses: { listen: [] } } });
  try {
    const note = await putDagJson(src.blockstore, { ns: 'issues', type: 'issue', title: 'orphan' });
    const ghost = CID.parse('bafkreigh2akiscaildc2jz24jwdmt7aq3hfj6j3q2qh34rp3gf2rgbna64'); // raw, not served
    const tip = await putDagJson(src.blockstore, { type: 'index-entry', added: [note], prev: [ghost], height: 2, lamport: 2 });

    const walk = await collectIndexBlocks(dst, [tip], sourceFetcher(src.blockstore));
    assert.equal(walk.collected, 2, 'tip + note staged despite broken prev');
    assert.deepEqual(walk.missing, [ghost.toString()], 'unresolvable prev reported');
    assert.ok(await dst.blockstore.has(note), 'note staged');
  } finally {
    await src.stop();
    await dst.stop();
  }
});

test('index walk: maxBlocks bounds the walk', async () => {
  const src = await createHelia({ libp2p: { addresses: { listen: [] } } });
  const dst = await createHelia({ libp2p: { addresses: { listen: [] } } });
  try {
    const fx = await buildFixture(src.blockstore);
    const walk = await collectIndexBlocks(dst, [fx.tip], sourceFetcher(src.blockstore), { maxBlocks: 3 });
    assert.ok(walk.collected <= 3, 'walk bounded');
  } finally {
    await src.stop();
    await dst.stop();
  }
});
