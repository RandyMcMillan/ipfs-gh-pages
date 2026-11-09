import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createHelia } from 'helia';
import { unixfs } from '@helia/unixfs';

// Public gateway reachability for THIS repository's root CID.
// The CID is computed at runtime with the same recipe the app and
// build-car use (git ls-files + wrapWithDirectory), never hardcoded.
// Not part of test:all — needs the public gateways AND a provider for
// the root (pin it first: ipfs dag import dist/ipfs-gh-pages.car).
// 429/5xx/504 count as SKIP (rate limit / no reachable provider);
// a 200 whose listing lacks a known repo file is a hard FAIL.

if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function () {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}

async function repoRootCid() {
  const root = process.env.REPO_ROOT ? path.resolve(process.env.REPO_ROOT) : process.cwd();
  const files = execSync('git ls-files -z', { cwd: root, encoding: 'buffer' })
    .toString('utf8').split('\0').filter(Boolean)
    .filter((f) => { try { return fs.statSync(path.join(root, f)).isFile(); } catch { return false; } })
    .map((f) => ({ path: f, content: new Uint8Array(fs.readFileSync(path.join(root, f))) }));
  const helia = await createHelia({ libp2p: { addresses: { listen: [] } } });
  try {
    let cid = null;
    for await (const entry of unixfs(helia).addAll(files, { wrapWithDirectory: true })) {
      cid = entry.cid;
    }
    return cid.toString();
  } finally {
    await helia.stop();
  }
}

const CID = await repoRootCid();
console.log(`repo root CID: ${CID}`);

// Dynamic gate: only assert gateway reachability when the provider list
// says someone is serving this CID. Empty list = skip with a clear reason.
let providerCount = null;
try {
  const res = await fetch(`https://delegated-ipfs.dev/routing/v1/providers/${CID}`, {
    headers: { accept: 'application/json' }
  });
  if (res.ok) {
    const data = await res.json();
    providerCount = (data.Providers || []).length;
  }
} catch {}
console.log(`providers announced: ${providerCount === null ? 'lookup failed' : providerCount}`);

const GATEWAYS = [
  { name: 'subdomain', url: `https://${CID}.ipfs.dweb.link` },
  { name: 'path', url: `https://ipfs.io/ipfs/${CID}` }
];

for (const gw of GATEWAYS) {
  test(`public gateway (${gw.name}) serves the repo root`, { timeout: 90000 }, async (t) => {
    if (providerCount === 0) {
      t.skip('no providers announced for this root — pin it first (ipfs dag import dist/ipfs-gh-pages.car)');
      return;
    }
    let res;
    try {
      res = await fetch(gw.url, { redirect: 'follow' });
    } catch (e) {
      t.skip(`gateway unreachable: ${e.message}`);
      return;
    }
    if (res.status === 429 || res.status >= 500) {
      t.skip(`gateway rate-limited/unavailable (${res.status})`);
      return;
    }
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const body = await res.text();
    assert.ok(body.includes('index.html'), 'directory listing shows a known repo file');
  });
}
