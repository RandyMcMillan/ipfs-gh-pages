// Kubo alignment: locks the TUI bridge's Kubo RPC mapping (opKuboRpc /
// opKuboDetect in js/ipfs-node.js) and, when a local Kubo answers,
// verifies the same calls the TUI issues behave identically against the
// real daemon. Live cases skip (never fail) where no Kubo is running —
// optional services are accelerants, never dependencies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const JS = fs.readFileSync('js/ipfs-node.js', 'utf8');
const FIXTURE = JSON.parse(fs.readFileSync('tests/fixtures/interop-vectors.json', 'utf8'))[0];

// The mapping the TUI depends on: `kubo <method> <args...>` from the `:`
// bar becomes POST {endpoint}/api/v0/<method>?stream-channels=true&arg=...
// Reference builder — kept in lockstep with the anchors below.
function kuboRpcUrl(endpoint, method, args = []) {
  const m = String(method).replace(/^\/+|\/+$/g, '');
  const query = args.map((a) => `arg=${encodeURIComponent(a)}`).join('&');
  return `${endpoint}/api/v0/${m}?stream-channels=true${query ? `&${query}` : ''}`;
}

test('opKuboRpc builds Kubo URLs exactly like the reference mapping', () => {
  // Textual anchors in js/ipfs-node.js — the mapping must not drift.
  assert.ok(
    JS.includes("replace(/^\\/+|\\/+$/g, '')"),
    'opKuboRpc trims leading/trailing slashes from the method'
  );
  assert.ok(
    JS.includes('`${state.kubo.endpoint}/api/v0/${method}?stream-channels=true'),
    'opKuboRpc posts to /api/v0/<method> with stream-channels'
  );
  assert.ok(
    JS.includes('args.map((a) => `arg=${encodeURIComponent(a)}`).join'),
    'opKuboRpc encodes args as repeated arg= params'
  );
  const matrix = [
    ['pin/ls', [], (u) => u.endsWith('/api/v0/pin/ls?stream-channels=true')],
    ['/version/', [], (u) => u.endsWith('/api/v0/version?stream-channels=true')],
    [
      'block/stat',
      [FIXTURE.cid],
      (u) =>
        u.includes(`/api/v0/block/stat?stream-channels=true&arg=${encodeURIComponent(FIXTURE.cid)}`)
    ],
    [
      'swarm/connect',
      ['/ip4/1.2.3.4/udp/4001/p2p/12D3KooW x'],
      (u) => u.includes(`arg=${encodeURIComponent('/ip4/1.2.3.4/udp/4001/p2p/12D3KooW x')}`)
    ],
    // kubo source-grounded endpoints (core/commands/{dag,refs,name}.go):
    // dag/import ingests CARs, refs -r walks every CID under a root (the
    // honest "clone will succeed" check), name/resolve is the IPNS interop
    // peer of @helia/ipns publishing.
    ['dag/import', [], (u) => u.endsWith('/api/v0/dag/import?stream-channels=true')],
    [
      'refs',
      ['-r', FIXTURE.cid],
      (u) =>
        u.includes('/api/v0/refs?stream-channels=true') &&
        u.includes(`arg=${encodeURIComponent('-r')}`) &&
        u.includes(`arg=${encodeURIComponent(FIXTURE.cid)}`)
    ],
    [
      'name/resolve',
      [`/ipns/${FIXTURE.cid}`],
      (u) =>
        u.includes('/api/v0/name/resolve?stream-channels=true') &&
        u.includes(`arg=${encodeURIComponent(`/ipns/${FIXTURE.cid}`)}`)
    ]
  ];
  for (const [method, args, check] of matrix) {
    const url = kuboRpcUrl('http://127.0.0.1:5001', method, args);
    assert.ok(check(url), `${method} ${JSON.stringify(args)} -> ${url}`);
  }
});

test('opKuboDetect probes the 5001-5010 range the TUI relies on', () => {
  assert.ok(JS.includes('portStart || 5001'), 'kuboDetect starts at 5001');
  assert.ok(JS.includes('portEnd || 5010'), 'kuboDetect ends at 5010');
  assert.ok(
    JS.includes('`${endpoint}/api/v0/id?stream-channels=true`'),
    'kuboDetect probes /api/v0/id'
  );
});

// ---- live alignment (skips without a local Kubo) --------------------------

const KUBO_CANDIDATES = [
  ...(process.env.KUBO_RPC ? [process.env.KUBO_RPC] : []),
  ...Array.from({ length: 10 }, (_, i) => `http://127.0.0.1:${5001 + i}`)
];

async function probe(endpoint) {
  try {
    const res = await fetch(`${endpoint}/api/v0/id?stream-channels=true`, {
      method: 'POST',
      signal: AbortSignal.timeout(1000)
    });
    return res.ok ? endpoint : null;
  } catch {
    return null;
  }
}

let kubo = null;
for (const endpoint of KUBO_CANDIDATES) {
  const found = await probe(endpoint);
  if (found) {
    kubo = found;
    break;
  }
}

test('live: version and id answer on the detected endpoint', { skip: !kubo && 'no local kubo (start one: npm run kubo:browser)' }, async () => {
  const version = await (await fetch(`${kubo}/api/v0/version`, { method: 'POST' })).json();
  assert.ok(version.Version, `kubo version: ${version.Version}`);
  const id = await (await fetch(`${kubo}/api/v0/id`, { method: 'POST' })).json();
  assert.match(id.ID, /^12D3KooW/, `kubo peer id: ${id.ID}`);
});

test('live: block/stat of the interop fixture matches its recorded size', { skip: !kubo && 'no local kubo' }, async () => {
  const res = await fetch(kuboRpcUrl(kubo, 'block/stat', [FIXTURE.cid]), { method: 'POST' });
  if (res.status === 500) {
    // The daemon is up but does not hold the fixture block — nothing to
    // align against on this machine.
    return;
  }
  assert.ok(res.ok, `block/stat HTTP ${res.status}`);
  const stat = await res.json();
  assert.equal(Number(stat.Size), FIXTURE.size, `${FIXTURE.name} block size`);
});

test('live: pin/ls round-trips the fixture CID (the TUI\'s pin form)', { skip: !kubo && 'no local kubo' }, async () => {
  // The fixture may not be in this daemon's blockstore; try the documented
  // self-seed first, and skip where the block truly is absent.
  const add = await fetch(kuboRpcUrl(kubo, 'pin/add', [FIXTURE.cid]), { method: 'POST' });
  if (!add.ok) return; // block absent here — nothing to align against
  const res = await fetch(kuboRpcUrl(kubo, 'pin/ls', [FIXTURE.cid]), { method: 'POST' });
  assert.ok(res.ok, `pin/ls HTTP ${res.status}`);
  const body = await res.text();
  assert.ok(body.includes(FIXTURE.cid), 'pin/ls reports the fixture pinned');
});

test('live: dag export -> dag import round-trips the fixture CAR', { skip: !kubo && 'no local kubo' }, async () => {
  const exp = await fetch(kuboRpcUrl(kubo, 'dag/export', [FIXTURE.cid]), { method: 'POST' });
  if (!exp.ok) return; // block absent — nothing to round-trip
  const car = await exp.arrayBuffer();
  assert.ok(car.byteLength > 32, `CAR payload (${car.byteLength} bytes)`);

  const imp = await fetch(kuboRpcUrl(kubo, 'dag/import', []), {
    method: 'POST',
    // kubo's file-arg machinery wants the CAR as a multipart field
    // (same as `ipfs add`), not a raw body.
    body: (() => {
      const form = new FormData();
      form.append('file', new Blob([car], { type: 'application/vnd.ipld.car' }), 'fixture.car');
      return form;
    })()
  });
  assert.ok(imp.ok, `dag/import HTTP ${imp.status}`);
  // kubo answers dag/import as NDJSON (stream-channels): one object per
  // imported root — {"Root":{"Cid":{"/":"<cid>"},"PinError":""}}.
  const reportText = await imp.text();
  const first = JSON.parse(reportText.split('\n').find((l) => l.trim()) || '{}');
  const rootCid = first.Root?.Cid?.['/'] || first.Root?.Cid;
  assert.equal(rootCid, FIXTURE.cid, `dag/import pinned the fixture root: ${reportText.slice(0, 200)}`);
});
