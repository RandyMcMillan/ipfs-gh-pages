import { requireIpfs, readConfig, writeConfig, addSwarmAddress } from './kubo-config-utils.mjs';

const WSS_ADDR = process.env.KUBO_WSS_ADDR || '/ip4/0.0.0.0/tcp/4003/wss';

requireIpfs();

console.log('Configuring Kubo WSS listener...');
console.log('Address to add:', WSS_ADDR);

const config = readConfig();
const added = addSwarmAddress(config, WSS_ADDR);

if (!config.AutoTLS) config.AutoTLS = {};
const autoTLSChanged =
  config.AutoTLS.Enabled !== true || config.AutoTLS.AutoWSS !== true;
config.AutoTLS.Enabled = true;
config.AutoTLS.AutoWSS = true;

if (added || autoTLSChanged) {
  writeConfig(config);
  if (added) console.log('Added:', WSS_ADDR);
  if (autoTLSChanged) console.log('Enabled AutoTLS with AutoWSS.');
} else {
  console.log('Address already present:', WSS_ADDR);
  console.log('AutoTLS + AutoWSS already enabled.');
}

console.log('');
console.log('Run `ipfs daemon` (or restart Kubo) for the change to take effect.');
console.log('If the node is publicly reachable, Kubo will advertise an address like:');
console.log('  /dns4/<PEER_ID>.libp2p.direct/tcp/443/wss/p2p/<PEER_ID>');
console.log('');
console.log('For a custom domain or LAN IP with your own certificate, use the reverse proxy instead:');
console.log('  npm run kubo:ws');
console.log('  npm run cert:generate');
console.log('  npm run proxy:wss');
