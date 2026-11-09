import test from 'node:test';
import assert from 'node:assert/strict';
import { createHelia } from 'helia';
import { unixfs } from '@helia/unixfs';
import { car } from '@helia/car';
import { CarWriter } from '@ipld/car/writer';
import { CarReader } from '@ipld/car/reader';

// helia/@ipld/car use Promise.withResolvers (Node 22+); CI runs Node 20.
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function () {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}

const enc = new TextEncoder();
const FILES = [
  { path: 'README.md', content: enc.encode('hello car\n') },
  { path: 'src/index.js', content: enc.encode('export const x = 1;\n') },
  { path: 'src/deep/nested.txt', content: enc.encode('nested content') }
];

async function exportCarBytes(heliaCar, rootCid) {
  const { writer, out } = await CarWriter.create([rootCid]);
  const chunks = [];
  const collect = (async () => {
    for await (const chunk of out) chunks.push(chunk);
  })();
  await heliaCar.export(rootCid, writer);
  await collect;
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function catAll(fsx, cid) {
  const chunks = [];
  for await (const chunk of fsx.cat(cid)) chunks.push(chunk);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

test('CAR round-trip: export, import into a fresh node, identical files and root CID', async () => {
  const src = await createHelia({ libp2p: { addresses: { listen: [] } } });
  const dst = await createHelia({ libp2p: { addresses: { listen: [] } } });
  try {
    const srcFs = unixfs(src);
    let root = null;
    for await (const entry of srcFs.addAll(FILES, { wrapWithDirectory: true })) {
      root = entry.cid;
    }

    const bytes = await exportCarBytes(car(src), root);
    assert.ok(bytes.length > 0, 'CAR has bytes');

    const reader = await CarReader.fromBytes(bytes);
    assert.deepEqual((await reader.getRoots()).map(String), [root.toString()], 'CAR root matches');

    await car(dst).import(reader);
    const dstFs = unixfs(dst);

    for (const f of FILES) {
      const stat = await dstFs.stat(root, { path: f.path });
      const text = await catAll(dstFs, stat.cid);
      assert.equal(text, new TextDecoder().decode(f.content), `file content matches: ${f.path}`);
    }

    // CID stability: re-adding the same bytes in the destination yields the same root.
    let reRoot = null;
    for await (const entry of dstFs.addAll(FILES, { wrapWithDirectory: true })) {
      reRoot = entry.cid;
    }
    assert.equal(reRoot.toString(), root.toString(), 'root CID is stable across nodes');
  } finally {
    await src.stop();
    await dst.stop();
  }
});
