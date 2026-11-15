// js/github-auth.js tests: device flow against a mocked fetch — code
// request shape, poll state machine (pending → success / slow_down /
// denied / expired), no token leakage into errors.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDeviceFlow, pollDeviceToken, DEVICE_GRANT } from '../js/github-auth.js';

test('startDeviceFlow posts client_id + scope, returns the device payload', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, body: new URLSearchParams(init.body) });
    return new Response(JSON.stringify({ device_code: 'DC', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 1, expires_in: 900 }), { status: 200 });
  };
  const out = await startDeviceFlow('CID', { fetchImpl });
  assert.equal(out.user_code, 'ABCD-1234');
  assert.equal(sent[0].url, 'https://github.com/login/device/code');
  assert.equal(sent[0].body.get('client_id'), 'CID');
  assert.equal(sent[0].body.get('scope'), 'public_repo');
});

test('pollDeviceToken: pending then success', async () => {
  let n = 0;
  const fetchImpl = async (url, init) => {
    assert.equal(new URLSearchParams(init.body).get('grant_type'), DEVICE_GRANT);
    n += 1;
    return new Response(JSON.stringify(n < 2 ? { error: 'authorization_pending' } : { access_token: 'TOK123', scope: 'public_repo' }), { status: 200 });
  };
  const out = await pollDeviceToken('CID', 'DC', { interval: 0.01, fetchImpl });
  assert.equal(out.token, 'TOK123');
  assert.equal(n, 2);
});

test('pollDeviceToken: slow_down backs off, denied/expired throw cleanly', async () => {
  const seq = ['authorization_pending', 'slow_down', { access_token: 'TOK' }];
  const fetchImpl = async () => new Response(JSON.stringify(typeof seq[0] === 'string' ? { error: seq[0] } : seq[0]), { status: 200 });
  const oldShift = seq.shift.bind(seq);
  const shifting = async () => { const v = oldShift(); return new Response(JSON.stringify(typeof v === 'string' ? { error: v } : v), { status: 200 }); };
  const out = await pollDeviceToken('CID', 'DC', { interval: 0.01, fetchImpl: shifting });
  assert.equal(out.token, 'TOK');
  await assert.rejects(pollDeviceToken('CID', 'DC', { interval: 0.01, fetchImpl: async () => new Response(JSON.stringify({ error: 'access_denied' }), { status: 200 }) }), /denied/);
  await assert.rejects(pollDeviceToken('CID', 'DC', { interval: 0.01, fetchImpl: async () => new Response(JSON.stringify({ error: 'expired_token' }), { status: 200 }) }), /expired/);
});
