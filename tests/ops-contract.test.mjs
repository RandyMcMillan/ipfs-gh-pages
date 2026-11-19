// Ops contract: every bridge op the Rust TUI can emit (fixed keys, tab
// affordances, and the `:` bar's kubo/services routing) must be
// registered in js/ipfs-node.js's ops table — an unknown op is the
// bridge's error path, not a silent no-op.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const APP_RS = fs.readFileSync('src/app.rs', 'utf8');
const JS = fs.readFileSync('js/ipfs-node.js', 'utf8');

// Ops the Rust side emits: direct ipfs::cmd("...") calls plus the
// `=> "..."` arms of submit_input's op match. "raw-command" is a dead arm
// (the `:` bar passes the head word through as the op instead), so it is
// excluded from the contract.
const emitted = new Set();
for (const m of APP_RS.matchAll(/ipfs::cmd\("([^"]+)"/g)) emitted.add(m[1]);
for (const m of APP_RS.matchAll(/=> "(connect|fetch|publish|chatSend|kubo\.rpc|services\.set|git\.[a-zA-Z]+|issues\.[a-zA-Z]+|repo\.publishAll)"/g)) {
  emitted.add(m[1]);
}
emitted.delete('raw-command');

// Ops the JS side registers: keys of the `const ops = {...}` table
// (quoted or bare identifiers).
const table = JS.match(/const ops = \{([\s\S]*?)\n\};/);
assert.ok(table, 'ops table found in js/ipfs-node.js');
const registered = new Set();
for (const m of table[1].matchAll(/^\s*'?(?:[a-zA-Z0-9._-]+)'?:/gm)) {
  registered.add(m[0].trim().replace(/[':]/g, ''));
}

test('every op the TUI emits is registered in the bridge ops table', () => {
  assert.ok(emitted.size >= 10, `expected the emitted op set, got ${[...emitted].join(', ')}`);
  for (const op of emitted) {
    assert.ok(registered.has(op), `js/ipfs-node.js ops table must register "${op}"`);
  }
});

test('the bridge reports unknown ops as errors (the `:` bar relies on it)', () => {
  assert.ok(
    JS.includes('state.results[id] = { ok: false, error: `unknown op: ${op}` }'),
    'unknown op writes an error result'
  );
});

test('emitted op set matches the documented tab affordances', () => {
  // Lock the surface explicitly so a removed key affordance is a
  // deliberate contract change, not an accidental deletion.
  const expected = [
    'connect', 'fetch', 'publish', 'chatSend', 'kubo.rpc', 'services.set',
    'git.clone', 'git.advertise', 'git.cloneSmart', 'git.pullSmart', 'git.clones',
    'issues.create', 'issues.sync', 'repo.publishAll'
  ];
  for (const op of expected) {
    assert.ok(emitted.has(op), `src/app.rs emits "${op}"`);
    assert.ok(registered.has(op), `bridge registers "${op}"`);
  }
});
