// rehost-service tests (docs/ipfs-rehost-service.md tier 1): camo's rulebook
// against a fixture origin — round trip (fetch → CID → bytes back), MIME /
// size / redirect / SSRF / Via-loop / HMAC rules, and the URL→CID cache.
// Hermetic: fixture origin on loopback (REHOST_ALLOW_PRIVATE=1), in-process
// Helia for the add, no network.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHelia } from 'helia';
import { unixfs } from '@helia/unixfs';
import { CID } from 'multiformats/cid';
import { createRehostServer } from '../scripts/rehost-service.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050201a371cbd00000000049454e44ae426082', 'hex');

let origin;
let originHits;
let originPort;
let helia;
let server;
let serverPort;
let cacheFile;
let caseCounter = 0;
const uniqueUrl = (p) => `http://127.0.0.1:${originPort}${p}?case=${++caseCounter}`;

const startOrigin = () => new Promise((resolve) => {
  originHits = {};
  origin = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    originHits[req.url] = (originHits[req.url] || 0) + 1;
    if (pathname === '/img.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length });
      res.end(PNG);
    } else if (pathname === '/page.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html></html>');
    } else if (pathname === '/big.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': 6 * 1024 * 1024 });
      res.end(Buffer.alloc(6 * 1024 * 1024));
    } else if (pathname === '/stream-big.png') {
      res.writeHead(200, { 'content-type': 'image/png' }); // chunked, no declared length
      res.write(Buffer.alloc(4 * 1024 * 1024));
      res.end(Buffer.alloc(2 * 1024 * 1024));
    } else if (pathname === '/redirect') {
      res.writeHead(302, { location: `http://127.0.0.1:${originPort}/img.png` });
      res.end();
    } else if (pathname === '/loop') {
      res.writeHead(302, { location: `http://127.0.0.1:${originPort}/loop` });
      res.end();
    } else {
      res.writeHead(404);
      res.end('nope');
    }
  });
  origin.listen(0, '127.0.0.1', () => {
    originPort = origin.address().port;
    resolve();
  });
});

const startServer = async () => {
  cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rehost-')), 'cache.json');
  server = createRehostServer({ cacheFile, helia });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  serverPort = server.address().port;
};

const rehost = (body, headers = {}) =>
  fetch(`http://127.0.0.1:${serverPort}/rehost`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });

before(async () => {
  await startOrigin();
  helia = await createHelia();
  process.env.REHOST_ALLOW_PRIVATE = '1';
  await startServer();
});

after(async () => {
  server?.close();
  origin?.close();
  await helia?.stop();
  delete process.env.REHOST_ALLOW_PRIVATE;
  delete process.env.CAMO_KEY;
});

beforeEach(() => {
  delete process.env.CAMO_KEY;
});

test('round trip: fetch → CID → byte-identical read back', async () => {
  const res = await rehost({ url: uniqueUrl('/img.png') });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.ok(CID.parse(out.cid), 'valid CID');
  assert.equal(out.size, PNG.length);
  assert.equal(out.contentType, 'image/png');
  assert.ok(out.gateways.includes(`ipfs://${out.cid}`));
  // read the bytes back through the same helia — byte identity
  const chunks = [];
  for await (const chunk of unixfs(helia).cat(CID.parse(out.cid))) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), PNG);
});

test('cache: second request is served without re-fetching the origin', async () => {
  const url = uniqueUrl('/img.png');
  const first = await (await rehost({ url })).json();
  const second = await (await rehost({ url })).json();
  assert.equal(second.cached, true);
  assert.equal(first.cid, second.cid);
  assert.equal(originHits[new URL(url).pathname + new URL(url).search], 1, 'origin hit exactly once');
});

test('non-image MIME is rejected (415)', async () => {
  const res = await rehost({ url: uniqueUrl('/page.html') });
  assert.equal(res.status, 415);
});

test('declared and streamed oversize are rejected (413)', async () => {
  const declared = await rehost({ url: uniqueUrl('/big.png') });
  assert.equal(declared.status, 413);
  const streamed = await rehost({ url: uniqueUrl('/stream-big.png') });
  assert.equal(streamed.status, 413);
});

test('redirects are followed within depth; loops die at 508', async () => {
  const ok = await rehost({ url: uniqueUrl('/redirect') });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).finalUrl, `http://127.0.0.1:${originPort}/img.png`);
  const loop = await rehost({ url: uniqueUrl('/loop') });
  assert.equal(loop.status, 508);
});

test('SSRF guard: private/loopback hosts refused when REHOST_ALLOW_PRIVATE is unset', async () => {
  delete process.env.REHOST_ALLOW_PRIVATE;
  const res = await rehost({ url: uniqueUrl('/img.png') });
  assert.equal(res.status, 403);
  process.env.REHOST_ALLOW_PRIVATE = '1';
});

test('Via self-guard: a request carrying our own Via is a loop (508)', async () => {
  const res = await rehost({ url: `http://127.0.0.1:${originPort}/img.png` }, { via: 'ipfs-rehost/1.0' });
  assert.equal(res.status, 508);
});

test('HMAC minting: CAMO_KEY gates /rehost on the digest', async () => {
  process.env.CAMO_KEY = 'test-key';
  const url = uniqueUrl('/img.png');
  const denied = await rehost({ url });
  assert.equal(denied.status, 403);
  const digest = crypto.createHmac('sha256', 'test-key').update(url, 'utf8').digest('hex');
  const allowed = await fetch(`http://127.0.0.1:${serverPort}/rehost?url=${encodeURIComponent(url)}&digest=${digest}`);
  assert.equal(allowed.status, 200);
});

test('origin never sees a cookie header', async () => {
  let sawCookie = null;
  const probe = http.createServer((req, res) => {
    sawCookie = req.headers.cookie || null;
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PNG);
  });
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  await rehost({ url: `http://127.0.0.1:${probe.address().port}/x.png` });
  probe.close();
  assert.equal(sawCookie, null);
});
