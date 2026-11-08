import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatSize,
  base64ToUint8Array,
  buildRepoTree,
  isBrowserDialable,
  normalizeAddressForProxy
} from '../lib/shared.mjs';

test('formatSize scales through B, kB, MB, GB and handles null/bigint', () => {
  assert.equal(formatSize(null), '');
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(2048), '2.0 kB');
  assert.equal(formatSize(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatSize(3n * 1024n * 1024n * 1024n), '3.0 GB');
});

test('base64ToUint8Array decodes base64', () => {
  const bytes = base64ToUint8Array(btoa('hello ipfs'));
  assert.equal(new TextDecoder().decode(bytes), 'hello ipfs');
  assert.deepEqual(Array.from(base64ToUint8Array('AAEC')), [0, 1, 2]);
});

test('buildRepoTree nests directories and marks files', () => {
  const tree = buildRepoTree(['README.md', 'src/app.js', 'src/lib/util.js']);
  assert.equal(tree.isDir, true);
  assert.equal(tree.children['README.md'].isDir, false);
  assert.equal(tree.children['src'].isDir, true);
  assert.deepEqual(Object.keys(tree.children['src'].children).sort(), ['app.js', 'lib']);
  assert.equal(tree.children['src'].children['lib'].children['util.js'].isDir, false);

  // a path that is a file elsewhere under the same prefix still promotes the node to a dir
  const t2 = buildRepoTree(['a', 'a/b.js']);
  assert.equal(t2.children['a'].isDir, true);
});

test('isBrowserDialable recognizes browser-capable transports only', () => {
  assert.equal(isBrowserDialable('/ip4/127.0.0.1/tcp/4002/ws/p2p/x'), true);
  assert.equal(isBrowserDialable('/dns4/a.libp2p.direct/tcp/443/wss/p2p/x'), true);
  assert.equal(isBrowserDialable('/ip4/1.2.3.4/udp/4001/webrtc-direct/certhash/uXi/p2p/x'), true);
  assert.equal(isBrowserDialable('/ip4/1.2.3.4/udp/4001/quic-v1/webtransport/certhash/uXi/p2p/x'), true);
  assert.equal(isBrowserDialable('/ip4/127.0.0.1/tcp/4001/p2p/x'), false);
  assert.equal(isBrowserDialable('/ip4/127.0.0.1/udp/4001/quic-v1/p2p/x'), false);
});

test('normalizeAddressForProxy rewrites only a trailing /ws', () => {
  assert.equal(
    normalizeAddressForProxy('/ip4/192.168.1.74/tcp/4002/ws', 4003),
    '/ip4/192.168.1.74/tcp/4003/wss'
  );
  assert.equal(
    normalizeAddressForProxy('/ip4/127.0.0.1/tcp/4001/ws/p2p/12D3KooWabc', 4003),
    '/ip4/127.0.0.1/tcp/4001/ws/p2p/12D3KooWabc'
  );
});
