// Helia node for the ratzilla shell (index-rust.html).
//
// Runs alongside the ratzilla wasm app — it does NOT own the page. Ratzilla
// injects the TUI canvas and the fixed footer; this module writes IPFS
// connection status into the LEFT side of that footer
// (#ratzilla-ipfs-status, created by inject_backend_footer in src/utils.rs).
// The footer is injected by wasm asynchronously, so status writes go through
// a MutationObserver-backed buffer rather than getElementById at call time.
//
// Bundled to a single ESM file by scripts/build-ipfs-js.mjs (esbuild) and
// copied into dist/assets by trunk's copy-file link. Mirrors the proven
// browser config from main.js: helia's libp2p defaults + gossipsub +
// pubsubPeerDiscovery on the repo topic, bootstrap dialing.

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

// The ratzilla footer (with our target span) is injected by wasm at runtime;
// load order vs this module is a race. Buffer the latest message and flush
// it via a MutationObserver once the span exists.
let statusEl = null;
let pendingStatus = null;

function statusLine(text) {
  const value = `IPFS: ${text}`;
  const el = statusEl ?? document.getElementById('ratzilla-ipfs-status');
  if (el) {
    statusEl = el;
    el.textContent = value;
  } else {
    pendingStatus = value;
  }
}

new MutationObserver((mutations, observer) => {
  if (statusEl) {
    observer.disconnect();
    return;
  }
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.id === 'ratzilla-ipfs-status') statusEl = node;
      else if (node.querySelector) {
        statusEl = node.querySelector('#ratzilla-ipfs-status') ?? statusEl;
      }
      if (statusEl) break;
    }
    if (statusEl) break;
  }
  if (statusEl && pendingStatus) {
    statusEl.textContent = pendingStatus;
    pendingStatus = null;
  }
}).observe(document.documentElement, { childList: true, subtree: true });

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
    statusLine(`peer ${libp2p.peerId} — ${libp2p.getConnections().length} connection(s)`);
  });
  libp2p.addEventListener('connection:close', () => {
    statusLine(`peer ${libp2p.peerId} — ${libp2p.getConnections().length} connection(s)`);
  });

  const pubsub = libp2p.services?.pubsub;
  if (pubsub) {
    try { pubsub.subscribe(TOPIC); } catch {}
  }

  statusLine(`peer ${libp2p.peerId} — dialing bootstrap peers...`);

  await Promise.allSettled(BOOTSTRAP_PEERS.map((addr) => libp2p.dial(addr)));
}

main().catch((err) => {
  statusLine(`IPFS node failed: ${err.message || err}`);
});
