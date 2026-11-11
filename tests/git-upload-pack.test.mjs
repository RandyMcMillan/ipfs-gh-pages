// Phase 9 step 2 tests: the REAL proof that js/git-upload-pack.js speaks
// git smart protocol — serve a fixture repo with it over a node HTTP stub
// and clone/fetch with the actual git CLI, then fsck the results.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

// Async variant for the clone/fetch steps: execFileSync BLOCKS the event
// loop, which would starve our in-process HTTP server mid-handshake.
const execFileP = promisify(execFile);
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { GitStore } from '../js/git-objects.js';
import { uploadPackRefs, parseUploadPackRequest, uploadPack } from '../js/git-upload-pack.js';

// maintenance.auto=false / gc.auto=0: git's detached auto-maintenance
// grandchild inherits our pipes and execFileSync would block forever
// waiting for EOF. Not a protocol issue — a test-harness pitfall.
const git = (args, cwd, opts = {}) =>
  execFileSync(
    'git',
    ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...opts }
  );

const src = fs.mkdtempSync(path.join(os.tmpdir(), 'upk-src-'));
const cloneDest = path.join(os.tmpdir(), `upk-clone-${Date.now()}`);

git(['init', '-q', '-b', 'main'], src);
git(['config', 'user.email', 'test@example.com'], src);
git(['config', 'user.name', 'Test'], src);
git(['config', 'commit.gpgsign', 'false'], src);
git(['config', 'tag.gpgsign', 'false'], src);

fs.writeFileSync(path.join(src, 'a.txt'), 'alpha\n');
git(['add', '.'], src);
git(['commit', '-q', '-m', 'one'], src);
fs.writeFileSync(path.join(src, 'b.txt'), 'beta\n');
git(['add', '.'], src);
git(['commit', '-q', '-m', 'two'], src);
git(['tag', '-a', '-m', 'v1', 'v1'], src);
git(['branch', 'side'], src);

let store = buildStore();

function buildStore() {
  const files = new Map();
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(src, '.git', rel))) {
      const relPath = rel ? `${rel}/${name}` : name;
      const full = path.join(src, '.git', relPath);
      if (fs.statSync(full).isDirectory()) walk(relPath);
      else if (!relPath.startsWith('logs/')) files.set(relPath, new Uint8Array(fs.readFileSync(full)));
    }
  };
  walk('');
  return new GitStore(files);
}

let server;
let baseUrl;
let lastPackObjects = 0;

before(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      try {
        if (req.url.startsWith('/info/refs')) {
          res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' });
          res.end(Buffer.from(uploadPackRefs(store)));
        } else if (req.url.startsWith('/git-upload-pack')) {
          const { wants, haves, done, caps } = parseUploadPackRequest(body);
          const out = uploadPack(store, wants, haves, { done, caps });
          lastPackObjects = out.objectCount;
          res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
          res.end(Buffer.from(out.body));
        } else {
          res.writeHead(404);
          res.end('nope');
        }
      } catch (err) {
        res.writeHead(500);
        res.end(String(err.stack || err));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(cloneDest, { recursive: true, force: true });
});

test('real git clone through our upload-pack', async () => {
  await execFileP(
    'git',
    ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', 'clone', '-q', baseUrl, cloneDest],
    { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
  );
  // fsck proves the pack we serialized is structurally valid.
  git(['fsck', '--strict'], cloneDest);
  const head = git(['rev-parse', 'HEAD'], cloneDest);
  assert.equal(head, git(['rev-parse', 'HEAD'], src), 'HEAD matches');
  assert.equal(fs.readFileSync(path.join(cloneDest, 'a.txt'), 'utf8'), 'alpha\n');
  assert.equal(fs.readFileSync(path.join(cloneDest, 'b.txt'), 'utf8'), 'beta\n');
  const tag = git(['rev-parse', 'v1'], cloneDest);
  assert.equal(tag, git(['rev-parse', 'v1'], src), 'annotated tag fetched');
  assert.equal(
    git(['rev-parse', 'origin/side'], cloneDest),
    git(['rev-parse', 'side'], src),
    'branch fetched as remote-tracking ref'
  );
});

test('incremental fetch sends haves; only new objects transfer', async () => {
  // Commit 3 in the source after the clone.
  fs.writeFileSync(path.join(src, 'c.txt'), 'gamma\n');
  git(['add', '.'], src);
  git(['commit', '-q', '-m', 'three'], src);
  // The repo moved on (new publish) — rebuild the object store, as the
  // bridge would when pointed at a newer CID.
  store = buildStore();

  lastPackObjects = -1;
  await execFileP('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', 'fetch', '-q', 'origin'], {
    cwd: cloneDest,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  git(['merge', '-q', '--ff-only', 'origin/main'], cloneDest);
  git(['fsck', '--strict'], cloneDest);
  assert.equal(fs.readFileSync(path.join(cloneDest, 'c.txt'), 'utf8'), 'gamma\n');
  assert.equal(git(['rev-parse', 'HEAD'], cloneDest), git(['rev-parse', 'HEAD'], src), 'HEAD advanced');
  // The haves path: one commit + its tree + one blob, not the whole repo.
  assert.ok(lastPackObjects > 0 && lastPackObjects <= 5,
    `incremental pack should carry only new objects, got ${lastPackObjects}`);
});

test('negotiation round without done gets NAK', () => {
  const { wants, haves, done } = parseUploadPackRequest(
    `0032want ${git(['rev-parse', 'HEAD'], src)} multi_ack\n0000`
  );
  assert.equal(wants.length, 1);
  assert.equal(done, false);
  const out = uploadPack(store, wants, haves, { done });
  const text = new TextDecoder().decode(out.body);
  assert.ok(text.includes('NAK'), 'NAK response');
  assert.equal(out.pack, null);
});
