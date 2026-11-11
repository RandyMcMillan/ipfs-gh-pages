// Builds CAR archives for the repo and each of its submodules:
//   - dist/ipfs-gh-pages.car            (main repo, exact app root CID)
//   - <submodule-path>/<basename>.car   (one per submodule, checked out)
// Root CIDs match what an in-browser addAll of the same files produces.
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
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createHelia } from 'helia';
import { unixfs } from '@helia/unixfs';
import { car } from '@helia/car';
import { CarWriter } from '@ipld/car/writer';
import { CID } from 'multiformats/cid';
import { collectIndexBlocks } from './index-walk.mjs';

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

function listFiles(dir) {
  let files = [];
  try {
    const out = execSync('git ls-files -z', { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
    files = out.toString('utf8').split('\0').filter(Boolean);
  } catch {
    const walk = (d) => {
      for (const name of fs.readdirSync(d)) {
        if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
        const full = path.join(d, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) walk(full);
        else files.push(path.relative(dir, full));
      }
    };
    walk(dir);
  }
  return files
    .filter((f) => {
      try { return fs.statSync(path.join(dir, f)).isFile(); } catch { return false; }
    })
    .map((f) => ({ path: f, content: new Uint8Array(fs.readFileSync(path.join(dir, f))) }));
}

async function exportCar(helia, roots) {
  const rootArray = Array.isArray(roots) ? roots : [roots];
  const { writer, out } = await CarWriter.create(rootArray);
  const chunks = [];
  const collect = (async () => {
    for await (const chunk of out) chunks.push(chunk);
  })();
  await car(helia).export(rootArray, writer);
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

const helia = await createHelia();
const heliaUnixfs = unixfs(helia);

async function buildCar(dir, outFile, extraRoots = []) {
  const candidates = listFiles(dir);
  let rootCid = null;
  for await (const entry of heliaUnixfs.addAll(candidates, { wrapWithDirectory: true })) {
    rootCid = entry.cid;
  }
  const bytes = await exportCar(helia, [rootCid, ...extraRoots]);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, bytes);
  console.log(`Wrote ${outFile} (${(bytes.length / 1024).toFixed(1)} kB, ${candidates.length} files)`);
  console.log(`Root CID: ${rootCid.toString()}`);
  return rootCid;
}

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

await helia.stop();
