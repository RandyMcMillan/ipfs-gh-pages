import { requireIpfs, readConfig, writeConfig, addSwarmAddress } from './kubo-config-utils.mjs';

const WS_ADDRS = [
  process.env.KUBO_WS_ADDR_V4 || process.env.KUBO_WS_ADDR || '/ip4/0.0.0.0/tcp/4002/ws',
  process.env.KUBO_WS_ADDR_V6 || '/ip6/::/tcp/4002/ws'
];

requireIpfs();

console.log('Configuring Kubo WebSocket listeners...');
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
console.log('After restart, use an address like:');
console.log('  /ip4/127.0.0.1/tcp/4002/ws/p2p/<KUBO_PEER_ID>');
console.log('Note: plain ws:// dials only work from http://127.0.0.1 / http://localhost pages.');
console.log('From https:// pages (GitHub Pages) use `npm run kubo:webrtc` instead.');
console.log('Kubo 0.33+ shares the TCP 4001 listener with WebSocket when AutoTLS is enabled (npm run kubo:wss).');
