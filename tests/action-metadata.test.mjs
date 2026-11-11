// action.yml metadata guard (plugin contract): the composite action must
// parse, every `inputs.<name>` referenced in steps must be declared, and
// no `${{ secrets.* }}` may appear anywhere — `secrets` is not a valid
// context in action metadata and its presence made every `uses: ./` step
// fail in seconds (run 43093477485).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACTION = fs.readFileSync(path.join(ROOT, 'action.yml'), 'utf8');

test('action.yml parses as YAML', () => {
  // no yaml dep here — structural sanity: balanced inputs/runs blocks
  assert.ok(ACTION.includes('runs:') && ACTION.includes('inputs:'));
  assert.ok(!/\t/.test(ACTION), 'no tabs (YAML)');
});

test('no secrets context in action metadata', () => {
  assert.ok(!ACTION.includes('${{ secrets.'), 'secrets context is invalid in action.yml — describe it in prose instead');
  assert.ok(!ACTION.includes('${{secrets.'), 'secrets context is invalid in action.yml');
});

test('every inputs.<name> used in steps is declared', () => {
  const declared = new Set([...ACTION.matchAll(/^  ([a-z0-9-]+):\s*$/gim)].map((m) => m[1]));
  const used = new Set([...ACTION.matchAll(/inputs\.([a-z0-9-]+)/g)].map((m) => m[1]));
  const missing = [...used].filter((u) => !declared.has(u));
  assert.deepEqual(missing, [], `undeclared inputs used: ${missing.join(', ')}`);
});
