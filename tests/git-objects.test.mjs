// Phase 9 step 1 tests (docs/git-over-ipfs.md): the git object primitives
// in js/git-objects.js, exercised against REAL repos built with the git
// CLI — loose objects, repacked packfiles with delta chains, packed-refs,
// and annotated tags. Every assertion is cross-checked against git's own
// output, so a parser bug can't pass by matching its own wrong answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GitStore, parsePackIdx, readPackObject, applyDelta } from '../js/git-objects.js';

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function makeRepo({ repack }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitstore-'));
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  // Hermetic fixtures: this machine globally signs commits.
  git(['config', 'commit.gpgsign', 'false'], dir);
  git(['config', 'tag.gpgsign', 'false'], dir);

  // Big highly-compressible file, then a small edit — classic delta bait.
  const lines = Array.from({ length: 2000 }, (_, i) => `line ${i} of the big file`);
  fs.writeFileSync(path.join(dir, 'big.txt'), lines.join('\n'));
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello world\n');
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', 'first commit'], dir);

  lines[1000] = 'line 1000 EDITED';
  fs.writeFileSync(path.join(dir, 'big.txt'), lines.join('\n'));
  fs.writeFileSync(path.join(dir, 'second.txt'), 'second file\n');
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', 'second commit'], dir);

  git(['tag', '-a', '-m', 'release one', 'v1.0'], dir);
  git(['branch', 'feature'], dir);
  git(['pack-refs', '--all'], dir);
  // A branch created after packing stays a loose ref file — covers the
  // loose-ref path alongside packed-refs.
  git(['branch', 'later-branch'], dir);
  if (repack) git(['repack', '-adq'], dir);

  // Load .git into a path->bytes Map (the shape the bridge builds from unixfs).
  const gitDir = path.join(dir, '.git');
  const files = new Map();
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(gitDir, rel))) {
      const relPath = rel ? `${rel}/${name}` : name;
      const full = path.join(gitDir, relPath);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(relPath);
      else if (!relPath.startsWith('logs/')) files.set(relPath, new Uint8Array(fs.readFileSync(full)));
    }
  };
  walk('');
  return { dir, files, store: new GitStore(files) };
}

function headSha(repoDir) {
  return git(['rev-parse', 'HEAD'], repoDir);
}

for (const variant of ['loose', 'repacked']) {
  const { dir, files, store } = makeRepo({ repack: variant === 'repacked' });

  test(`${variant}: refs match git for-each-ref + HEAD`, () => {
    const expected = new Map();
    for (const line of git(['for-each-ref', '--format=%(refname) %(objectname)'], dir).split('\n')) {
      const sp = line.indexOf(' ');
      expected.set(line.slice(0, sp), line.slice(sp + 1));
    }
    const got = store.refs();
    assert.equal(got.head.ref, 'refs/heads/main');
    assert.equal(got.head.sha, headSha(dir));
    assert.equal(got.refs.length, expected.size, 'ref count');
    for (const { name, sha } of got.refs) {
      assert.equal(sha, expected.get(name), `ref ${name}`);
    }
    assert.ok(got.refs.some((r) => r.name === 'refs/tags/v1.0'), 'annotated tag ref present');
    assert.ok(got.refs.some((r) => r.name === 'refs/heads/feature'), 'branch ref present');
    const later = got.refs.find((r) => r.name === 'refs/heads/later-branch');
    assert.ok(later, 'loose ref present');
    assert.equal(later.sha, git(['rev-parse', 'later-branch'], dir));
  });

  test(`${variant}: catFile commit parses and matches git cat-file`, () => {
    const sha = headSha(dir);
    const expected = git(['cat-file', 'commit', sha], dir);
    const obj = store.catFile(sha);
    assert.equal(obj.type, 'commit');
    assert.ok(obj.text.includes('second commit'), 'message');
    // git cat-file strips the payload's trailing newline; we don't.
    assert.equal(obj.text.trimEnd(), expected.trimEnd(), 'commit content');
  });

  test(`${variant}: catFile tree entries match git ls-tree`, () => {
    const sha = headSha(dir);
    const treeSha = git(['rev-parse', `${sha}^{tree}`], dir);
    const expected = new Map();
    for (const line of git(['ls-tree', treeSha], dir).split('\n')) {
      const m = line.match(/^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/);
      expected.set(m[4], { mode: m[1], type: m[2], sha: m[3] });
    }
    const obj = store.catFile(treeSha);
    assert.equal(obj.type, 'tree');
    assert.equal(obj.entries.length, expected.size, 'entry count');
    for (const e of obj.entries) {
      const exp = expected.get(e.name);
      assert.ok(exp, `entry ${e.name}`);
      assert.equal(e.type, exp.type, `${e.name} type`);
      assert.equal(e.sha, exp.sha, `${e.name} sha`);
    }
  });

  test(`${variant}: catFile blob content is byte-exact`, () => {
    const sha = headSha(dir);
    const blobSha = git(['rev-parse', `${sha}:big.txt`], dir);
    const obj = store.catFile(blobSha);
    assert.equal(obj.type, 'blob');
    assert.ok(obj.text.includes('line 1000 EDITED'), 'edited line present');
    assert.equal(obj.text.split('\n').length, 2000, 'line count');
    // Byte-exact against git's own output for this blob.
    const expected = git(['cat-file', 'blob', blobSha], dir);
    assert.equal(obj.text, expected, 'blob content');
  });

  test(`${variant}: annotated tag object reads with message`, () => {
    const tagSha = git(['rev-parse', 'refs/tags/v1.0'], dir);
    const obj = store.catFile(tagSha);
    assert.equal(obj.type, 'tag');
    assert.ok(obj.text.includes('release one'), 'tag message');
  });

  test(`${variant}: annotated tag peels to the commit`, () => {
    // The tag object targets the first commit; verify the target sha
    // resolves and is a commit.
    const tagSha = git(['rev-parse', 'refs/tags/v1.0'], dir);
    const target = store.catFile(tagSha).text.split('\n').find((l) => l.startsWith('object ')).slice(7);
    assert.equal(store.catFile(target).type, 'commit');
  });
}

test('unit: applyDelta copy + literal sequence', () => {
  const base = new TextEncoder().encode('hello world');
  // delta: srcSize 11, outSize 15, copy(base[0..5]), insert " big ",
  // copy(base[6..11]) -> "hello big world"
  const delta = new Uint8Array([
    11, 15,
    0x90, 5, // copy: no offset bytes (offset 0), size byte 5
    5, ...new TextEncoder().encode(' big '), // literal insert
    0x91, 6, 5, // copy: offset byte 6, size byte 5
  ]);
  assert.equal(new TextDecoder().decode(applyDelta(base, delta)), 'hello big world');
});

test('repacked: pack idx + delta resolution sanity', () => {
  const { files, store } = makeRepo({ repack: true });
  const packCount = [...files.keys()].filter((k) => k.endsWith('.idx')).length;
  assert.ok(packCount >= 1, 'a pack exists after repack');
  const head = store.refs().head.sha;
  assert.equal(store.catFile(head).type, 'commit');
});
