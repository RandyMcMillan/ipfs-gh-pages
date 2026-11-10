// Builds CAR archives for the repo and each of its submodules:
//   - dist/ipfs-gh-pages.car            (main repo, exact app root CID)
//   - <submodule-path>/<basename>.car   (one per submodule, checked out)
// Root CIDs match what an in-browser addAll of the same files produces.
//
// Note: the in-browser addAll itself embeds submodule contents too (see the
// "Virtual submodule support" block in vite.config.js's repoFilesPlugin).
// This script's per-submodule CARs are a transport convenience for
// `ipfs dag import` on Kubo; the app's file set comes only from the plugin.
// Usage: node scripts/build-car.mjs [outDir]   (default: <repo>/dist)
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createHelia } from 'helia';
import { unixfs } from '@helia/unixfs';
import { car } from '@helia/car';
import { CarWriter } from '@ipld/car/writer';

// helia/@ipld/car use Promise.withResolvers (Node 22+); CI builds on Node 20.
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function () {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}

const root = process.env.REPO_ROOT ? path.resolve(process.env.REPO_ROOT) : process.cwd();
const outDir = path.resolve(process.env.OUT_DIR || process.argv[2] || path.join(root, 'dist'));

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

async function exportCar(helia, rootCid) {
  const { writer, out } = await CarWriter.create([rootCid]);
  const chunks = [];
  const collect = (async () => {
    for await (const chunk of out) chunks.push(chunk);
  })();
  await car(helia).export(rootCid, writer);
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

async function buildCar(dir, outFile) {
  const candidates = listFiles(dir);
  let rootCid = null;
  for await (const entry of heliaUnixfs.addAll(candidates, { wrapWithDirectory: true })) {
    rootCid = entry.cid;
  }
  const bytes = await exportCar(helia, rootCid);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, bytes);
  console.log(`Wrote ${outFile} (${(bytes.length / 1024).toFixed(1)} kB, ${candidates.length} files)`);
  console.log(`Root CID: ${rootCid.toString()}`);
  return rootCid;
}

// Main repo CAR.
const mainRoot = await buildCar(root, path.join(outDir, 'ipfs-gh-pages.car'));
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
