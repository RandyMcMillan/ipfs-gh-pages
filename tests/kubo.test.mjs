// js/kubo.js tests: probe (present/absent/CORS), dag import + pin URL
// shapes, full hand-off against a mocked fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeKubo, importCar, pinAdd, kuboHandoff, KUBO_RPC_DEFAULT } from '../js/kubo.js';

test('probeKubo returns peer info on 200, null on any failure', async () => {
  const ok = await probeKubo({ fetchImpl: async (url, init) => {
    assert.equal(url, `${KUBO_RPC_DEFAULT}/api/v0/id`);
    assert.equal(init.method, 'POST');
    return new Response(JSON.stringify({ ID: '12D3KooWpeer', AgentVersion: 'kubo/0.35.0' }), { status: 200 });
  } });
  assert.equal(ok.peerId, '12D3KooWpeer');
  assert.equal(ok.agentVersion, 'kubo/0.35.0');
  assert.equal(await probeKubo({ fetchImpl: async () => new Response('nope', { status: 500 }) }), null);
  assert.equal(await probeKubo({ fetchImpl: async () => { throw new TypeError('fetch failed'); } }), null);
});

test('probeKubo scans the common RPC port range, not just 5001', async () => {
  const tried = [];
  const hit = await probeKubo({ fetchImpl: async (url) => {
    tried.push(url);
    if (url.includes(':5003')) return new Response(JSON.stringify({ ID: '12D3KooWpeer' }), { status: 200 });
    throw new TypeError('refused');
  }, timeoutMs: 1 });
  assert.equal(hit.peerId, '12D3KooWpeer');
  assert.equal(hit.endpoint, 'http://127.0.0.1:5003');
  assert.deepEqual(tried, ['http://127.0.0.1:5001/api/v0/id', 'http://127.0.0.1:5002/api/v0/id', 'http://127.0.0.1:5003/api/v0/id'], 'stops at the first answer');
});

test('importCar posts a multipart CAR; pinAdd posts to the pin endpoint', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, hasForm: init.body instanceof FormData });
    return new Response(JSON.stringify({ Pin: {} }), { status: 200 });
  };
  await importCar(new Uint8Array([1, 2, 3]), { fetchImpl });
  assert.ok(sent[0].url.startsWith(`${KUBO_RPC_DEFAULT}/api/v0/dag/import`));
  assert.equal(sent[0].hasForm, true);
  await pinAdd('baguqeeramzfy', { fetchImpl });
  assert.ok(sent[1].url.includes('/api/v0/pin/add?arg=baguqeeramzfy'));
  await assert.rejects(pinAdd('x', { fetchImpl: async () => new Response('err', { status: 500 }) }), /500/);
});

test('kuboHandoff: export → import → pin, byte count returned', async () => {
  const order = [];
  const exportCarBytes = async (cid) => { order.push('export:' + cid); if (!(cid && typeof cid === 'object')) throw new Error('expected CID object'); return new Uint8Array(9); };
  const fetchImpl = async (url) => { order.push(url.split('/api/v0/')[1].split('?')[0]); return new Response('{}', { status: 200 }); };
  const out = await kuboHandoff('baguqeeraysmhpxmndt46ozalqpelnugs4ssekrgcojby3k3uz3crtzcopqmq', { exportCarBytes, fetchImpl });
  assert.deepEqual(order, ['export:baguqeeraysmhpxmndt46ozalqpelnugs4ssekrgcojby3k3uz3crtzcopqmq', 'dag/import', 'pin/add']);
  assert.equal(out.bytes, 9);
});
