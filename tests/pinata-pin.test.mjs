// scripts/pinata-pin.mjs tests: request shape against a mocked fetch,
// JWT hygiene (never in errors), CLI failure paths.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { pinataUpload, PINATA_UPLOAD_URL } from '../scripts/pinata-pin.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'pinata-pin.mjs');

const tmpFile = () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pinata-')), 'release.car');
  fs.writeFileSync(p, 'car-bytes');
  return p;
};

test('pinataUpload posts multipart to the v3 files endpoint with Bearer auth', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ data: { id: 'id-1', cid: 'bafyabc', name: 'repo@sha' } }), { status: 200 });
  };
  const out = await pinataUpload({ file: tmpFile(), name: 'repo@sha', car: true, jwt: 'SECRET_JWT', fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, PINATA_UPLOAD_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer SECRET_JWT');
  const form = calls[0].init.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('network'), 'public');
  assert.equal(form.get('name'), 'repo@sha');
  assert.equal(form.get('car'), 'true');
  assert.equal(form.get('file').name, 'release.car');
  assert.equal(out.data.cid, 'bafyabc');
});

test('pinataUpload omits name/car when not given', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(init);
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  };
  await pinataUpload({ file: tmpFile(), jwt: 'J', fetchImpl });
  const form = calls[0].body;
  assert.equal(form.get('name'), null);
  assert.equal(form.get('car'), null);
});

test('pinataUpload errors carry status + body but NEVER the JWT', async () => {
  const fetchImpl = async () => new Response('{"error":"invalid token"}', { status: 401 });
  await assert.rejects(
    pinataUpload({ file: tmpFile(), jwt: 'SUPER_SECRET', fetchImpl }),
    (err) => {
      assert.ok(err.message.includes('HTTP 401'));
      assert.ok(err.message.includes('invalid token'));
      assert.ok(!err.message.includes('SUPER_SECRET'), 'JWT must not leak into errors');
      return true;
    }
  );
});

test('pinataUpload without JWT throws before any fetch', async () => {
  await assert.rejects(pinataUpload({ file: tmpFile(), jwt: '', fetchImpl: async () => assert.fail('no fetch') }),
    /PINATA_JWT is not set/);
});

test('CLI: missing file and missing JWT exit 1 with clear messages', () => {
  const run = (args, env = {}) => {
    try {
      execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: 0 };
    } catch (e) {
      return { code: e.status, err: `${e.stdout || ''}${e.stderr || ''}` };
    }
  };
  const noFile = run(['/nonexistent.car'], { PINATA_JWT: 'x' });
  assert.equal(noFile.code, 1);
  assert.ok(noFile.err.includes('file not found'));
  const noJwt = run([tmpFile()], { PINATA_JWT: '' });
  assert.equal(noJwt.code, 1);
  assert.ok(noJwt.err.includes('PINATA_JWT'));
});
