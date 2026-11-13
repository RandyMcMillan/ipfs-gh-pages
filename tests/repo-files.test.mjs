import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// helia/@ipld/car use Promise.withResolvers (Node 22+); CI runs Node 20.
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function () {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}

const { listRepoFiles, repoByteTotal, EMBED_THRESHOLD_BYTES } = await import('../scripts/lib/repo-files.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeRepo(dir, { bytes = 0, files = 1 } = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  git(['init', '-q'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), `# fixture ${path.basename(dir)}\n`);
  for (let i = 0; i < files; i++) {
    fs.writeFileSync(path.join(dir, `src/f${i}.bin`), Buffer.alloc(Math.ceil(bytes / files), i));
  }
  git(['add', '-A'], dir);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], dir);
  return dir;
}

test('listRepoFiles flattens a checked-out submodule as <sub>/<file>', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-files-test-'));
  try {
    const parent = makeRepo(path.join(tmp, 'parent'));
    const sub = makeRepo(path.join(tmp, 'sub-src'));
    // git refuses file:// submodule adds without explicit allowance.
    git(['-c', 'protocol.file.allow=always', 'submodule', '-q', 'add', sub, 'vendor-sub'], parent);
    const paths = [...listRepoFiles(parent)].map((e) => e.path).sort();
    assert.deepEqual(paths, ['.gitmodules', 'README.md', 'src/f0.bin', 'vendor-sub/README.md', 'vendor-sub/src/f0.bin']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('repoByteTotal sums the flattened set', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-bytes-test-'));
  try {
    const parent = makeRepo(path.join(tmp, 'parent'), { bytes: 1000 });
    const sub = makeRepo(path.join(tmp, 'sub-src'), { bytes: 500 });
    git(['-c', 'protocol.file.allow=always', 'submodule', '-q', 'add', sub, 'sub'], parent);
    assert.equal(repoByteTotal(parent) >= 1500, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

async function runBuildCar(repo, outDir) {
  const script = path.resolve(import.meta.dirname, '../scripts/build-car.mjs');
  execFileSync('node', [script, outDir], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, REPO_ROOT: repo },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('build-car: under-threshold repo embeds (no repo.car), manifest still written', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'car-embed-test-'));
  try {
    const repo = makeRepo(path.join(tmp, 'repo'), { bytes: 1024 });
    const out = path.join(tmp, 'dist');
    await runBuildCar(repo, out);
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'repo-manifest.json'), 'utf8'));
    assert.equal(manifest.version, 1);
    assert.equal(manifest.files.length, 2);
    assert.ok(manifest.root, 'manifest has a root CID');
    assert.equal(fs.existsSync(path.join(out, 'repo.car')), false, 'no repo.car under threshold');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('build-car: over-threshold repo writes repo.car whose roots match the manifest', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'car-mode-test-'));
  try {
    assert.ok(EMBED_THRESHOLD_BYTES > 0);
    const repo = makeRepo(path.join(tmp, 'repo'), { bytes: EMBED_THRESHOLD_BYTES + 1024, files: 8 });
    const out = path.join(tmp, 'dist');
    await runBuildCar(repo, out);
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'repo-manifest.json'), 'utf8'));
    const { CarReader } = await import('@ipld/car/reader');
    const reader = await CarReader.fromBytes(new Uint8Array(fs.readFileSync(path.join(out, 'repo.car'))));
    const roots = (await reader.getRoots()).map(String);
    assert.deepEqual(roots, [manifest.root], 'repo.car roots == manifest root');
    assert.ok(manifest.files.every((f) => typeof f.cid === 'string' && typeof f.size === 'number'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
