// js/markdown.js tests: the GitHub-like pipeline — GFM output,
// sanitization (scripts/handlers/SVG/MathML stripped, align kept, scheme
// filtering incl. ipfs: kept + data:/javascript: killed), URL
// classification, and repo-path resolution. Pure parts only (no DOM).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarked, classifyUrl, resolveRepoPath } from '../js/markdown.js';

test('GFM constructs render: tables, task lists, strikethrough, autolinks', () => {
  const html = renderMarked(`| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n~~gone~~\n\nvisit https://example.com now`);
  assert.ok(html.includes('<table>'), 'table');
  assert.ok(/type="checkbox"/.test(html), 'task list checkbox');
  assert.ok(html.includes('<s>gone</s>') || html.includes('<del>gone</del>'), 'strikethrough');
  assert.ok(html.includes('https://example.com'), 'autolink');
});

test('classifyUrl: the full decision table', () => {
  const dir = 'docs';
  assert.deepEqual(classifyUrl('./img/x.png', { mdDirPath: dir }), { kind: 'embed', path: 'docs/img/x.png' });
  assert.deepEqual(classifyUrl('../top.png', { mdDirPath: 'docs/sub' }), { kind: 'embed', path: 'docs/top.png' });
  assert.deepEqual(classifyUrl('/root.png', { mdDirPath: dir }), { kind: 'embed', path: 'root.png' });
  assert.deepEqual(classifyUrl('guide.md', { mdDirPath: dir }), { kind: 'repo', path: 'docs/guide.md' });
  assert.equal(classifyUrl('https://img.shields.io/x.svg').kind, 'rehost');
  assert.equal(classifyUrl('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi').kind, 'link');
  assert.equal(classifyUrl('mailto:a@b.c').kind, 'link');
  assert.equal(classifyUrl('javascript:alert(1)').kind, 'block');
  assert.equal(classifyUrl('data:text/html,x').kind, 'block');
  assert.equal(classifyUrl('ftp://x/y').kind, 'block');
  assert.equal(classifyUrl('').kind, 'block');
});

test('resolveRepoPath: ./, ../, /, bare, query/fragment stripped', () => {
  assert.equal(resolveRepoPath('./a/b.png', 'x/y'), 'x/y/a/b.png');
  assert.equal(resolveRepoPath('../c.png', 'x/y'), 'x/c.png');
  assert.equal(resolveRepoPath('/top.png', 'x/y'), 'top.png');
  assert.equal(resolveRepoPath('bare.png', 'x'), 'x/bare.png');
  assert.equal(resolveRepoPath('p.png?raw=1#frag', 'x'), 'x/p.png');
  assert.equal(resolveRepoPath('../../../escape.png', 'x'), 'escape.png'); // can't pop past root
});
