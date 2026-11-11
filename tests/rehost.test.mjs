// js/rehost.js tests: URL classification, src mapping, and the full
// rehostAndRewrite flow with an injectable fetch/cache — no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRehost, rehostedSrc, rehostAndRewrite } from '../js/rehost.js';

test('shouldRehost: only plain remote http(s) URLs qualify', () => {
  assert.equal(shouldRehost('https://img.shields.io/badge.svg'), true);
  assert.equal(shouldRehost('http://example.com/x.png'), true);
  assert.equal(shouldRehost('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'), false);
  assert.equal(shouldRehost('https://ipfs.io/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'), true); // a gateway URL is still a remote fetch
  assert.equal(shouldRehost('data:image/png;base64,iVBOR'), false);
  assert.equal(shouldRehost('./build/icon.png'), false); // relative — repo bundle, no third party
  assert.equal(shouldRehost('javascript:alert(1)'), false);
  assert.equal(shouldRehost('not a url'), false);
});

test('rehostedSrc: gateway URL for the img, full CID inside', () => {
  const cid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
  assert.equal(rehostedSrc({ cid }), `https://ipfs.io/ipfs/${cid}`);
  assert.equal(rehostedSrc({ cid }, 'https://ipfs.gnostr.org/'), `https://ipfs.gnostr.org/ipfs/${cid}`);
  assert.equal(rehostedSrc(null), null);
  assert.equal(rehostedSrc({}), null);
});

test('rehostAndRewrite: posts to the service and maps the result', async () => {
  const cid = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ cid, size: 123, contentType: 'image/png' }), { status: 200 });
  };
  const out = await rehostAndRewrite('https://img.shields.io/badge.svg', { endpoint: 'http://127.0.0.1:8081', fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8081/rehost');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(JSON.parse(calls[0].init.body).url, 'https://img.shields.io/badge.svg');
  assert.equal(out.cid, cid);
  assert.equal(out.src, `https://ipfs.io/ipfs/${cid}`);
  assert.equal(out.ipfsUri, `ipfs://${cid}`);
});

test('rehostAndRewrite: caches — second call never hits the service', async () => {
  let hits = 0;
  const fetchImpl = async () => {
    hits++;
    return new Response(JSON.stringify({ cid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' }), { status: 200 });
  };
  const map = new Map();
  const cache = { get: (k) => map.get(k), set: (k, v) => map.set(k, v) };
  const opts = { endpoint: 'http://x', fetchImpl, cache };
  await rehostAndRewrite('https://a.example/x.png', opts);
  const second = await rehostAndRewrite('https://a.example/x.png', opts);
  assert.equal(hits, 1);
  assert.ok(second.src.includes('ipfs'));
});

test('rehostAndRewrite: null on any failure (caller falls back)', async () => {
  assert.equal(await rehostAndRewrite('https://x.example/a.png', { endpoint: '', fetchImpl: async () => { throw new Error('no'); } }), null);
  assert.equal(await rehostAndRewrite('https://x.example/a.png', { endpoint: 'http://x', fetchImpl: async () => new Response('nope', { status: 502 }) }), null);
  assert.equal(await rehostAndRewrite('https://x.example/a.png', { endpoint: 'http://x', fetchImpl: async () => { throw new Error('down'); } }), null);
  assert.equal(await rehostAndRewrite('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi', { endpoint: 'http://x', fetchImpl: async () => { throw new Error('should not fetch'); } }), null);
});
