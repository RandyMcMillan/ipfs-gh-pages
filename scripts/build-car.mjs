// Builds CAR archives for the repo and each of its submodules:
//   - dist/ipfs-gh-pages.car            (main repo, exact app root CID)
//   - <submodule-path>/<basename>.car   (one per submodule, checked out)
//   - dist/repo-manifest.json           (file paths + CIDs + sizes, see below)
// Root CIDs match what an in-browser addAll of the same files produces.
//
// Memory profile: file bytes stream through a disk-backed blockstore in
// 1 MiB chunks and CAR bytes stream straight to disk, so the build handles
// repos of any size in bounded RAM. (The vite bundle is the other half of
// that story — repo-manifest.json exists so the app can stop embedding
// file contents base64-in-bundle; see vite.config.js repoFilesPlugin.)
//
// Note: the in-browser addAll itself embeds submodule contents too (see the
// "Virtual submodule support" block in vite.config.js's repoFilesPlugin).
// This script's per-submodule CARs are a transport convenience for
// `ipfs dag import` on Kubo; the app's file set comes only from the plugin.
// Usage: node scripts/build-car.mjs [outDir] [--index-tip <cid> ...]
//   (outDir default: <repo>/dist)
// --index-tip (repeatable) or INDEX_TIPS=<cid,cid> bundles the issues
// tracker (docs/issues-car.md phase 6): the index DAG + all reachable
// notes/comments are merged into dist/ipfs-gh-pages.car, whose roots then
// are the repo root PLUS each index tip. Without a tip the CAR is repo-only,
// exactly as before.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execSync } from 'node:child_process';
import { createHelia } from 'helia';
import { unixfs } from '@helia/unixfs';
import { car } from '@helia/car';
import { CarWriter } from '@ipld/car/writer';
import { CID } from 'multiformats/cid';
import { FsBlockstore } from 'blockstore-fs';
import { collectIndexBlocks } from './index-walk.mjs';
import { listRepoFiles, listTrackedFiles, EMBED_THRESHOLD_BYTES } from './lib/repo-files.mjs';

// helia/@ipld/car use Promise.withResolvers (Node 22+); CI builds on Node 20.
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function () {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}

const root = process.env.REPO_ROOT ? path.resolve(process.env.REPO_ROOT) : process.cwd();

// Positional args: [outDir] plus --index-tip <cid> (repeatable). --index-tip
// also falls back to INDEX_TIPS=<cid,cid>. Values stay strings until the walk
// parses them.
const positionalArgs = [];
const indexTips = [];
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--index-tip' && argv[i + 1]) { indexTips.push(argv[i + 1]); i++; }
    else if (!argv[i].startsWith('--')) positionalArgs.push(argv[i]);
  }
  if (indexTips.length === 0 && process.env.INDEX_TIPS) {
    indexTips.push(...process.env.INDEX_TIPS.split(',').map((s) => s.trim()).filter(Boolean));
  }
}
const outDir = path.resolve(process.env.OUT_DIR || positionalArgs[0] || path.join(root, 'dist'));
const parsedIndexTips = indexTips.map((t) => {
  try { return CID.parse(t); } catch { console.warn(`Ignoring unparsable --index-tip: ${t}`); return null; }
}).filter(Boolean);

// Block sources for the index walk, in resolution order
// (docs/optional-services.md): the local Kubo RPC first — the app hands users
// `ipfs pin add <tip>`, so a release build on the maintainer's machine finds
// everything pinned there — then trustless gateways. Best effort: an
// unreachable source is skipped, never fatal.
const KUBO_RPC = (process.env.KUBO_RPC || 'http://127.0.0.1:5001').replace(/\/$/, '');
const INDEX_GATEWAYS = (process.env.INDEX_GATEWAYS || 'https://ipfs.io')
  .split(',').map((s) => s.trim()).filter(Boolean);

async function fetchBlockKubo(cid) {
  const res = await fetch(`${KUBO_RPC}/api/v0/block/get?arg=${cid}`, { method: 'POST', signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}

async function fetchBlockGateway(gateway, cid) {
  const res = await fetch(`${gateway}/ipfs/${cid}?format=raw`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}

async function fetchIndexBlock(cid) {
  try { const bytes = await fetchBlockKubo(cid); if (bytes) return bytes; } catch {}
  for (const gateway of INDEX_GATEWAYS) {
    try { const bytes = await fetchBlockGateway(gateway, cid); if (bytes) return bytes; } catch {}
  }
  return null;
}

// Stream a file in 1 MiB chunks so addAll never holds a whole repo in RAM.
async function* streamFile(full) {
  const handle = await fs.promises.open(full, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (bytesRead === 0) return;
      yield new Uint8Array(buf.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}

// {path, content} entries with lazy content streams, for a plain
// `git ls-files` set (the historical main-CAR / per-submodule-CAR set).
function* trackedEntries(dir) {
  for (const f of listTrackedFiles(dir)) {
    yield { path: f, content: streamFile(path.join(dir, f)) };
  }
}

async function exportCar(helia, roots, outFile) {
  const rootArray = Array.isArray(roots) ? roots : [roots];
  const { writer, out } = await CarWriter.create(rootArray);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  // Stream CAR chunks to disk; starting the pipeline before export()
  // matters — awaiting it first would deadlock on backpressure.
  const sink = pipeline(out, fs.createWriteStream(outFile));
  await car(helia).export(rootArray, writer);
  await sink;
  return fs.statSync(outFile).size;
}

const blockstorePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ipfs-gh-pages-car-'));
const helia = await createHelia({ blockstore: new FsBlockstore(blockstorePath) });
const heliaUnixfs = unixfs(helia);

async function buildCar(dir, outFile, extraRoots = []) {
  let count = 0;
  const candidates = [];
  for (const entry of trackedEntries(dir)) { candidates.push(entry); count++; }
  let rootCid = null;
  for await (const entry of heliaUnixfs.addAll(candidates, { wrapWithDirectory: true })) {
    rootCid = entry.cid;
  }
  const size = await exportCar(helia, [rootCid, ...extraRoots], outFile);
  console.log(`Wrote ${outFile} (${(size / 1024).toFixed(1)} kB, ${count} files)`);
  console.log(`Root CID: ${rootCid.toString()}`);
  return rootCid;
}

// dist/repo-manifest.json: {path, cid, size} per file over the virtual-
// flattened file set (superproject + checked-out submodules — exactly what
// vite.config.js's repoFilesPlugin lists), plus the wrapped root CID. Small
// and file-count-bound, unlike the base64 bundle map: it is the manifest the
// app switches to so repos of any size build.
async function buildManifest(outFile) {
  const candidates = [];
  const sizes = new Map();
  let totalBytes = 0;
  for (const { path: p, full } of listRepoFiles(root)) {
    candidates.push({ path: p, content: streamFile(full) });
    const size = fs.statSync(full).size;
    sizes.set(p, size);
    totalBytes += size;
  }
  const cids = new Map();
  let manifestRoot = null;
  for await (const entry of heliaUnixfs.addAll(candidates, { wrapWithDirectory: true })) {
    if (entry.path) cids.set(entry.path, entry.cid.toString());
    else manifestRoot = entry.cid; // wrap-with-directory root yields last, empty path
  }
  const files = [...sizes.keys()].sort().map((p) => ({ path: p, cid: cids.get(p), size: sizes.get(p) }));
  const manifest = { version: 1, root: manifestRoot ? manifestRoot.toString() : null, files };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(manifest));
  console.log(`Wrote ${outFile} (${files.length} files, root ${manifest.root})`);
  return { manifest, totalBytes };
}

try {
  // Main repo CAR. With index tips the CAR also carries the issues tracker
  // (docs/issues-car.md phase 6): walk each tip's chain + notes into the
  // blockstore, then export with roots = repo root + tips. A tip whose DAG
  // did not fully resolve is not added as a root (export traversal would
  // fail) — its resolved blocks are still bundled.
  const bundledTips = [];
  if (parsedIndexTips.length > 0) {
    let staged = 0;
    for (const tip of parsedIndexTips) {
      const walk = await collectIndexBlocks(helia, [tip], fetchIndexBlock);
      staged += walk.collected;
      if (walk.missing.length > 0) {
        console.warn(`Index tip ${tip}: ${walk.missing.length} block(s) unresolved, not a CAR root:`);
        for (const m of walk.missing) console.warn(`  ${m}`);
      } else {
        bundledTips.push(tip);
      }
    }
    console.log(`Issues index: ${staged} block(s) staged, ${bundledTips.length}/${parsedIndexTips.length} tip(s) rooted`);
  }
  const mainRoot = await buildCar(root, path.join(outDir, 'ipfs-gh-pages.car'), bundledTips);
  console.log('Seed it on any Kubo:');
  console.log('ipfs dag import --pin ipfs-gh-pages.car');

  // One CAR per submodule, written inside the submodule directory.
  let submoduleOutput = '';
  try {
    const status = execSync('git submodule status --recursive', { cwd: root, encoding: 'utf8' });
    const submodules = status.split('\n').filter(Boolean).map((line) => {
      const m = line.trim().match(/^[+-U]?[0-9a-f]+\s+(\S+)/);
      return m ? m[1] : null;
    }).filter(Boolean);
    for (const rel of submodules) {
      const dir = path.resolve(root, rel);
      if (!fs.existsSync(path.join(dir, '.git'))) continue;
      const base = rel.split('/').pop();
      await buildCar(dir, path.join(dir, `${base}.car`));
      submoduleOutput += `  ${rel} -> ${rel}/${base}.car\n`;
    }
    if (submoduleOutput) console.log('Submodule CARs:\n' + submoduleOutput.trimEnd());
  } catch (e) {
    console.warn('Submodule scan skipped:', e.message);
  }

  // Repo manifest: the bundle's future file source (kept file-count-bound).
  const { manifest, totalBytes } = await buildManifest(path.join(outDir, 'repo-manifest.json'));

  // Car mode (same threshold as vite.config.js): ship the full-tree CAR the
  // app fetches bytes from. Embedded repos never need it.
  if (totalBytes > EMBED_THRESHOLD_BYTES && manifest.root) {
    const size = await exportCar(helia, [CID.parse(manifest.root)], path.join(outDir, 'repo.car'));
    console.log(`Wrote ${path.join(outDir, 'repo.car')} (${(size / 1024 / 1024).toFixed(1)} MiB, car mode)`);
  }

  // GitHub Pages has no SPA fallback for unknown paths, so a deep path link
  // like /ipfs-gh-pages/issues would 404 on refresh. Pages serves 404.html
  // for those — ship a copy of the app; its router reads the path, activates
  // the matching view, and normalizes to the canonical hash URL. Relative
  // asset base ('./') keeps the copy working from the 404 response.
  try {
    fs.copyFileSync(path.join(outDir, 'index.html'), path.join(outDir, '404.html'));
    console.log('SPA fallback: 404.html written');
  } catch (e) {
    console.warn('404.html skipped:', e.message);
  }
} finally {
  await helia.stop();
  fs.rmSync(blockstorePath, { recursive: true, force: true });
}
