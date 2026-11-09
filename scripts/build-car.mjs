// Builds dist/ipfs-gh-pages.car — a CAR archive of the whole embedded
// repository, preserving the exact root CID the app computes in the browser.
// Runs after `vite build`; the release workflow archives it with dist/.
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
const outDir = path.resolve(process.argv[2] || path.join(root, 'dist'));

let files = [];
try {
  const out = execSync('git ls-files -z', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
  files = out.toString('utf8').split('\0').filter(Boolean);
} catch {
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else files.push(path.relative(root, full));
    }
  };
  walk(root);
}

const candidates = files
  .filter((f) => {
    try { return fs.statSync(path.join(root, f)).isFile(); } catch { return false; }
  })
  .map((f) => ({ path: f, content: new Uint8Array(fs.readFileSync(path.join(root, f))) }));

const helia = await createHelia();
const heliaUnixfs = unixfs(helia);
let rootCid = null;
for await (const entry of heliaUnixfs.addAll(candidates, { wrapWithDirectory: true })) {
  rootCid = entry.cid;
}

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

fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'ipfs-gh-pages.car');
fs.writeFileSync(outFile, bytes);
console.log(`Wrote ${outFile} (${(bytes.length / 1024).toFixed(1)} kB, ${candidates.length} files)`);
console.log(`Root CID: ${rootCid.toString()}`);
console.log('Seed it on any Kubo: ipfs dag import --pin ipfs-gh-pages.car');

await helia.stop();
