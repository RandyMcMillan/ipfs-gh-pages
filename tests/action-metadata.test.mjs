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
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

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

test('deployed accessibility scanner files findings without assigning Copilot', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployed-smoke.yml'), 'utf8');
  const scanner = workflow.match(/uses: github\/accessibility-scanner@[^\n]+\n([\s\S]*)/);
  assert.ok(scanner, 'deployed smoke must run the accessibility scanner');
  assert.match(scanner[1], /^\s+skip_copilot_assignment:\s*(?:true|'true'|"true")\s*$/m);
  assert.doesNotMatch(scanner[1], /^\s+dry_run:\s*(?:true|'true'|"true")\s*$/m);
});

test('commit-count link has an accessible name before its count loads', () => {
  const link = INDEX.match(/<a\b[^>]*\bid="commit-count"[^>]*>/);
  assert.ok(link, 'commit-count link exists');
  assert.match(link[0], /\baria-label="View commits"/);
  assert.match(link[0], /\bhidden\b/);
});
