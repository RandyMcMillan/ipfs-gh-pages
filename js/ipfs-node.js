// Helia node for the ratzilla shell (index-rust.html).
//
// Bundled to a single ESM file by scripts/build-ipfs-js.mjs (esbuild) and
// copied into dist by trunk's copy-file link. Mirrors the proven browser
// config from main.js: helia's libp2p defaults + gossipsub +
// pubsubPeerDiscovery on the repo topic, bootstrap dialing, and the node
// exposed on window.__heliaNode.

import { createHelia, libp2pDefaults } from 'helia';
import { createLibp2p } from 'libp2p';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery';

const BOOTSTRAP_PEERS = [
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
  '/dnsaddr/va1.bootstrap.libp2p.io/p2p/12D3KooWKnDdG3iXw9eTFijk3EWSunZcFi54Zka4wmtqtt6rPxc8'
];

const TOPIC = 'repo-gossip:ipfs-gh-pages';

function statusLine(text) {
  const el = document.getElementById('ipfs-status');
  if (el) el.textContent = text;
}

async function main() {
  statusLine('Starting IPFS node...');

  const lpDefaults = libp2pDefaults();
  const libp2p = await createLibp2p({
    ...lpDefaults,
    peerDiscovery: [
      ...lpDefaults.peerDiscovery,
      pubsubPeerDiscovery({ topics: [TOPIC] })
    ],
    services: {
      ...lpDefaults.services,
      pubsub: gossipsub({ emitSelf: false })
    }
  });
  const helia = await createHelia({ libp2p });
  window.__heliaNode = helia;

  libp2p.addEventListener('connection:open', () => {
    statusLine(`IPFS online — peer ${libp2p.peerId} — ${libp2p.getConnections().length} connection(s)`);
  });
  libp2p.addEventListener('connection:close', () => {
    statusLine(`IPFS online — peer ${libp2p.peerId} — ${libp2p.getConnections().length} connection(s)`);
  });

  const pubsub = libp2p.services?.pubsub;
  if (pubsub) {
    try { pubsub.subscribe(TOPIC); } catch {}
  }

  statusLine(`IPFS online — peer ${libp2p.peerId} — dialing bootstrap peers...`);

  await Promise.allSettled(BOOTSTRAP_PEERS.map((addr) => libp2p.dial(addr)));
}

main().catch((err) => {
  statusLine(`IPFS node failed: ${err.message || err}`);
});
