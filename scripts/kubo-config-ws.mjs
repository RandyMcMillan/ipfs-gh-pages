import { requireIpfs, readConfig, writeConfig, addSwarmAddress } from './kubo-config-utils.mjs';

const WS_ADDR = process.env.KUBO_WS_ADDR || '/ip4/0.0.0.0/tcp/4002/ws';

requireIpfs();

console.log('Configuring Kubo WebSocket listener...');
console.log('Address to add:', WS_ADDR);

const config = readConfig();
const added = addSwarmAddress(config, WS_ADDR);

if (added) {
  writeConfig(config);
  console.log('Added:', WS_ADDR);
} else {
  console.log('Address already present:', WS_ADDR);
}

console.log('Run `ipfs daemon` (or restart Kubo) for the change to take effect.');
console.log('After restart, use an address like:');
console.log('  /ip4/127.0.0.1/tcp/4002/ws/p2p/<KUBO_PEER_ID>');
