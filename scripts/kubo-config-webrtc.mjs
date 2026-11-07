import { requireIpfs, readConfig, writeConfig, addSwarmAddress } from './kubo-config-utils.mjs';

const WS_ADDRS = [
  process.env.KUBO_WEBRTC_ADDR_V4 || '/ip4/0.0.0.0/udp/4002/webrtc-direct',
  process.env.KUBO_WEBRTC_ADDR_V6 || '/ip6/::/udp/4002/webrtc-direct'
];

requireIpfs();

console.log('Configuring Kubo WebRTC Direct listener...');
console.log('Addresses to add:', WS_ADDRS.join(', '));

const config = readConfig();
let changed = false;
for (const addr of WS_ADDRS) {
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
console.log('After restart, `ipfs id` advertises an address like:');
console.log('  /ip4/127.0.0.1/udp/4002/webrtc-direct/certhash/uXi.../p2p/<KUBO_PEER_ID>');
console.log('WebRTC Direct dials work from both https:// (GitHub Pages) and local dev origins.');
console.log('Requires Kubo >= 0.24 (0.33+ recommended for reliability fixes).');
