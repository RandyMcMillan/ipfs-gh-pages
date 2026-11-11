// Stego fixture tests (docs/markdown-rendering.md — attack vectors): the
// fixtures in tests/fixtures/stego/ must (a) derive from the pinned
// gnostr.svg carrier, (b) decode back to their manifest payloads via the
// exact gist techniques, (c) NOT expose the payload as plaintext — that
// is the smuggling property these fixtures exist to test against.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stego');
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const vectors = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'interop-vectors.json'), 'utf8'));
const read = (f) => fs.readFileSync(path.join(DIR, f));

// decoders — the inverse of scripts/build-stego-fixtures.mjs
const decodeMatrix = (svg) => {
  const m = svg.match(/<feColorMatrix[^>]*values='([^']+)'/);
  if (!m) return null;
  return m[1].split(/\s+/).map((f) => Math.round(parseFloat(f) * 1000));
};
const decodePhantom = (svg) => {
  const m = svg.match(/<polyline[^>]*points='([^']+)'/);
  if (!m) return null;
  return m[1].split(/\s+/).map((point) => {
    const x = point.split(',')[0];
    return parseInt(x.split('.')[1] || '0', 10);
  });
};
const decodeLsb = (ppm, byteCount) => {
  const text = ppm.toString('latin1');
  const headerEnd = text.indexOf('255\n') + 4;
  const pixels = ppm.subarray(headerEnd);
  const bits = [];
  for (let i = 0; i < pixels.length / 3 && bits.length < 8 * byteCount; i++) {
    bits.push(pixels[i * 3 + 2] & 1); // blue channel LSB
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));
  }
  return bytes;
};
const asString = (bytes) => Buffer.from(bytes).toString('utf8').replace(/\0+$/g, '');

test('clean carrier IS the pinned interop vector (provenance)', async () => {
  const clean = read('gnostr-clean.svg');
  const digest = await sha256.digest(clean);
  assert.equal(CID.create(1, 0x55, digest).toString(), vectors.find((v) => v.name === 'gnostr.svg').cid);
  assert.equal(manifest.carrier.cid, vectors.find((v) => v.name === 'gnostr.svg').cid);
});

test('matrix fixture decodes to its payload via feColorMatrix coefficients', () => {
  const f = manifest.fixtures.find((x) => x.technique === 'svg-feColorMatrix-coefficients');
  const decoded = asString(decodeMatrix(read(f.file).toString('utf8')));
  assert.equal(decoded, f.payload);
});

test('phantom fixture decodes to its payload via coordinate decimals', () => {
  const f = manifest.fixtures.find((x) => x.technique === 'svg-phantom-polyline-decimals');
  const decoded = asString(decodePhantom(read(f.file).toString('utf8')));
  assert.equal(decoded, f.payload);
});

test('lsb fixture decodes to its payload via blue-channel LSBs', () => {
  const f = manifest.fixtures.find((x) => x.technique === 'ppm-blue-channel-lsb');
  const decoded = asString(decodeLsb(read(f.file), f.payload.length));
  assert.equal(decoded, f.payload);
});

test('payloads are NOT plaintext in any fixture (the smuggling property)', () => {
  for (const f of manifest.fixtures) {
    const haystack = read(f.file).toString('latin1');
    assert.ok(!haystack.includes(f.payload), `${f.file} must not contain its payload as plaintext`);
  }
});

test('svg fixtures keep the carrier structure (same logo, injected elements only)', () => {
  const clean = read('gnostr-clean.svg').toString('utf8');
  for (const name of ['gnostr-matrix-stego.svg', 'gnostr-phantom-stego.svg']) {
    const svg = read(name).toString('utf8');
    assert.ok(svg.startsWith('<?xml'), `${name}: xml declaration`);
    assert.ok(svg.includes('<svg'), `${name}: svg root`);
    assert.ok(svg.trimEnd().endsWith('</svg>'), `${name}: closes`);
    // every line of the clean carrier that isn't the svg wrapper survives
    const cleanBody = clean.split('\n').filter((l) => l.trim() && !l.startsWith('<?xml')).join('\n');
    assert.ok(svg.includes(cleanBody.split('\n')[1].trim()), `${name}: carrier content preserved`);
  }
});
