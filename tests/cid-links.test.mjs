// js/cid-links.js tests: CID token detection (accept/reject shapes,
// offsets) and the affordance model (full values, never truncated).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CID_RE, findCidTokens, cidAffordanceModel } from '../js/cid-links.js';

const DAG_JSON = 'baguqiger3qvmvq5b3tm5x4vbgwls5k3li63jumdifywczijqh5wfjvqp7oa';
const RAW_LEAF = 'bafkreie6rnrpqhvfyzx2a3xfhwqde5itq2zxoaqvgbymbykn2hjrmkbpu4'; // CIDv1 raw of "# hello\n"
const UNIXFS = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const CIDV0 = 'QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o';
const PEER_ID = '12D3KooWRnFNEVmgXnNC7cEGCW4TBRX7qzwx4sNZhTbuDp3BHvGk';

test('findCidTokens accepts every CID shape the app produces', () => {
  const text = `tip ${DAG_JSON}\nfile ${RAW_LEAF} root ${UNIXFS} legacy ${CIDV0}`;
  const tokens = findCidTokens(text);
  assert.deepEqual(tokens.map((t) => t.cid), [DAG_JSON, RAW_LEAF, UNIXFS, CIDV0]);
  // offsets point at the exact spans
  for (const t of tokens) {
    assert.equal(text.slice(t.start, t.end), t.cid);
  }
});

test('findCidTokens rejects peer IDs and near-misses', () => {
  assert.deepEqual(findCidTokens(PEER_ID), []);
  assert.deepEqual(findCidTokens('baf short bag'), []);
  assert.deepEqual(findCidTokens('Qm'), []);
  assert.deepEqual(findCidTokens('xbafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'), []);
  assert.deepEqual(findCidTokens(''), []);
  assert.deepEqual(findCidTokens(null), []);
});

test('CID_RE state does not leak across calls (global regex)', () => {
  assert.equal(findCidTokens(DAG_JSON).length, 1);
  assert.equal(findCidTokens(DAG_JSON).length, 1, 'second call still matches');
});

test('cidAffordanceModel carries full values for every affordance', () => {
  const providers = [
    { ID: PEER_ID, Addrs: ['/ip4/203.0.113.7/tcp/4001/p2p/' + PEER_ID, '/ip4/203.0.113.7/udp/4001/quic-v1/p2p/' + PEER_ID] },
    { ID: '12D3KooWBf3VynKfWXdPSrCQeBfSZ5GvDzd7b1eXvWvs7X9xj2yu', Addrs: [] }
  ];
  const m = cidAffordanceModel(DAG_JSON, providers);
  assert.equal(m.ipfsUri, `ipfs://${DAG_JSON}`);
  assert.equal(m.gatewayUrl, `https://ipfs.io/ipfs/${DAG_JSON}`);
  assert.equal(m.subdomainUrl, `https://${DAG_JSON}.ipfs.dweb.link`);
  assert.equal(m.pinCmd, `ipfs pin add ${DAG_JSON}`);
  assert.equal(m.providers.length, 2);
  assert.equal(m.swarmConnects.length, 2, 'one swarm connect per provider addr');
  assert.equal(m.swarmConnects[0].id, PEER_ID);
  assert.equal(m.swarmConnects[0].cmd, `ipfs swarm connect '/ip4/203.0.113.7/tcp/4001/p2p/${PEER_ID}'`);
  assert.equal(m.swarmConnects[1].cmd, `ipfs swarm connect '/ip4/203.0.113.7/udp/4001/quic-v1/p2p/${PEER_ID}'`);
  // no providers -> empty swarm list, other affordances intact
  const bare = cidAffordanceModel(DAG_JSON);
  assert.deepEqual(bare.swarmConnects, []);
  assert.equal(bare.pinCmd, `ipfs pin add ${DAG_JSON}`);
});
