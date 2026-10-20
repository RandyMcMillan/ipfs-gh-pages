import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const WSS_ADDR = process.env.KUBO_WSS_ADDR || '/ip4/0.0.0.0/tcp/4003/wss';
const CERT_DIR = process.env.KUBO_CERT_DIR || path.join(process.cwd(), 'certs');
const CERT_FILE = process.env.KUBO_CERT_FILE || path.join(CERT_DIR, 'cert.pem');
const KEY_FILE = process.env.KUBO_KEY_FILE || path.join(CERT_DIR, 'key.pem');

function ipfsConfig(key, value) {
  execSync(`ipfs config ${key} --json ${JSON.stringify(JSON.stringify(value))}`, { stdio: 'inherit' });
}

function ipfsConfigGet(key) {
  try {
    const out = execSync(`ipfs config ${key} --json`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

console.log('Configuring Kubo WSS listener...');
console.log('Address to add:', WSS_ADDR);

const swarm = ipfsConfigGet('Addresses.Swarm') || [];
if (swarm.includes(WSS_ADDR)) {
  console.log('Address already present:', WSS_ADDR);
} else {
  swarm.push(WSS_ADDR);
  ipfsConfig('Addresses.Swarm', swarm);
  console.log('Added:', WSS_ADDR);
}

console.log('');
console.log('NOTE: Kubo does not support custom TLS certificates for WSS listeners.');
console.log('Native WSS uses AutoTLS and advertises a *.libp2p.direct address.');
console.log('');

const autoTLS = ipfsConfigGet('AutoTLS') || {};
if (!autoTLS.Enabled) {
  console.log('Enabling AutoTLS so Kubo can obtain a WSS certificate...');
  ipfsConfig('AutoTLS', { Enabled: true, AutoWSS: true });
  console.log('AutoTLS enabled with AutoWSS.');
} else if (!autoTLS.AutoWSS) {
  console.log('AutoTLS is already enabled; enabling AutoWSS...');
  autoTLS.AutoWSS = true;
  ipfsConfig('AutoTLS', autoTLS);
} else {
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
