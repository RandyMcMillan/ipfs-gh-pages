import { requireIpfs, readConfig, writeConfig, addSwarmAddress } from './kubo-config-utils.mjs';

const ADDRESSES = [
  process.env.KUBO_WS_ADDR_V4 || '/ip4/0.0.0.0/tcp/4002/ws',
  process.env.KUBO_WS_ADDR_V6 || '/ip6/::/tcp/4002/ws',
  process.env.KUBO_WEBRTC_ADDR_V4 || '/ip4/0.0.0.0/udp/4002/webrtc-direct',
  process.env.KUBO_WEBRTC_ADDR_V6 || '/ip6/::/udp/4002/webrtc-direct'
];

requireIpfs();

console.log('Configuring Kubo for browser connections (WebSocket + WebRTC Direct)...');
console.log('Addresses to add:', ADDRESSES.join(', '));

const config = readConfig();
let changed = false;
for (const addr of ADDRESSES) {
  if (addSwarmAddress(config, addr)) {
    console.log('Added:', addr);
    changed = true;
  } else {
    console.log('Address already present:', addr);
  }
}

if (changed) {
  writeConfig(config);
} else {
  console.log('Nothing to change.');
}

console.log('');
console.log('Run `ipfs daemon` (or restart Kubo) for the change to take effect.');
console.log('Then in this app either:');
console.log('  - click "Detect Kubo" in Peer > Settings, or');
console.log('  - copy the /webrtc-direct/certhash/... address from `ipfs id`.');
console.log('WebRTC Direct works from both https:// (GitHub Pages) and local dev origins.');
