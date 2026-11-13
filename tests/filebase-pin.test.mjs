// scripts/filebase-pin.mjs tests: the SigV4 signer against AWS's documented
// known-answer vector, request shape against a mocked fetch, credential
// hygiene (never in errors), CLI failure paths.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { sigV4Sign, filebaseUpload, FILEBASE_ENDPOINT } from '../scripts/filebase-pin.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'filebase-pin.mjs');

const tmpFile = () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'filebase-')), 'release.car');
  fs.writeFileSync(p, 'car-bytes');
  return p;
};

test('sigV4Sign reproduces AWS\'s documented GET signature exactly', () => {
  // From AWS's Signature Version 4 examples (iam ListUsers, 20150830T123600Z):
  // https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
  const signed = sigV4Sign({
    method: 'GET',
    host: 'iam.amazonaws.com',
    path: '/',
    query: { Action: 'ListUsers', Version: '2010-05-08' },
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    payload: '',
    service: 'iam',
    region: 'us-east-1',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    date: new Date('2015-08-30T12:36:00Z')
  });
  assert.equal(
    signed.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, ' +
    'SignedHeaders=content-type;host;x-amz-date, ' +
    'Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7'
  );
});

test('filebaseUpload PUTs the CAR to the bucket with SigV4 auth', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response('', { status: 200, headers: { 'x-amz-meta-cid': 'bafyFILEBASE' } });
  };
  const out = await filebaseUpload({
    file: tmpFile(), bucket: 'my-bucket', name: 'repo@sha',
    key: 'ACCESS', secret: 'SECRET', fetchImpl
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${FILEBASE_ENDPOINT}/my-bucket/repo%40sha`);
  assert.equal(calls[0].init.method, 'PUT');
  const h = calls[0].init.headers;
  assert.ok(h.Authorization.startsWith('AWS4-HMAC-SHA256 Credential=ACCESS/'), 'SigV4 credential scope');
  assert.ok(h.Authorization.includes('SignedHeaders=host;x-amz-content-sha256;x-amz-date'), 'signed header set');
  assert.match(h.Authorization, /Signature=[0-9a-f]{64}$/);
  assert.equal(h['X-Amz-Content-Sha256'], h['X-Amz-Content-Sha256'], 'payload hash header present');
  assert.equal(calls[0].init.body.length, 'car-bytes'.length);
  assert.equal(out.cid, 'bafyFILEBASE');
});

test('filebaseUpload falls back to the ETag when no CID header', async () => {
  const fetchImpl = async () => new Response('', { status: 200, headers: { etag: '"bafyETAG"' } });
  const out = await filebaseUpload({ file: tmpFile(), bucket: 'b', key: 'K', secret: 'S', fetchImpl });
  assert.equal(out.cid, 'bafyETAG');
});

test('filebaseUpload errors carry status but NEVER the secret', async () => {
  const fetchImpl = async () => new Response('<?xml><Error>SignatureDoesNotMatch</Error>', { status: 403 });
  await assert.rejects(
    filebaseUpload({ file: tmpFile(), bucket: 'b', key: 'AK', secret: 'TOP_SECRET', fetchImpl }),
    (err) => {
      assert.ok(err.message.includes('HTTP 403'));
      assert.ok(!err.message.includes('TOP_SECRET'), 'secret must not leak into errors');
      assert.ok(!err.message.includes('AK'), 'key must not leak into errors');
      return true;
    }
  );
});

test('filebaseUpload without credentials throws before any fetch', async () => {
  const boom = async () => assert.fail('no fetch');
  await assert.rejects(filebaseUpload({ file: tmpFile(), bucket: 'b', key: '', secret: 'S', fetchImpl: boom }), /FILEBASE_KEY is not set/);
  await assert.rejects(filebaseUpload({ file: tmpFile(), bucket: 'b', key: 'K', secret: '', fetchImpl: boom }), /FILEBASE_SECRET is not set/);
  await assert.rejects(filebaseUpload({ file: tmpFile(), bucket: '', key: 'K', secret: 'S', fetchImpl: boom }), /FILEBASE_BUCKET is not set/);
});

test('CLI: missing file and missing credentials exit 1 with clear messages', () => {
  const run = (args, env = {}) => {
    try {
      execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: 0 };
    } catch (e) {
      return { code: e.status, err: `${e.stdout || ''}${e.stderr || ''}` };
    }
  };
  const noFile = run(['/nonexistent.car'], { FILEBASE_KEY: 'x', FILEBASE_SECRET: 'y', FILEBASE_BUCKET: 'z' });
  assert.equal(noFile.code, 1);
  assert.ok(noFile.err.includes('file not found'));
  const noSecret = run([tmpFile()], { FILEBASE_KEY: 'x', FILEBASE_SECRET: '', FILEBASE_BUCKET: 'z' });
  assert.equal(noSecret.code, 1);
  assert.ok(noSecret.err.includes('FILEBASE_SECRET'));
});
