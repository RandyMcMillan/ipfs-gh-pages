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

if (!fs.existsSync(CERT_FILE) || !fs.existsSync(KEY_FILE)) {
  console.error('Certificate files not found:');
  console.error('  CERT:', CERT_FILE);
  console.error('  KEY:', KEY_FILE);
  console.error('Generate them first with: npm run cert:generate');
  process.exit(1);
}

console.log('Configuring Kubo WSS listener...');
console.log('Address to add:', WSS_ADDR);
console.log('Certificate:', CERT_FILE);
console.log('Key:', KEY_FILE);

const swarm = ipfsConfigGet('Addresses.Swarm') || [];
if (swarm.includes(WSS_ADDR)) {
  console.log('Address already present:', WSS_ADDR);
} else {
  swarm.push(WSS_ADDR);
  ipfsConfig('Addresses.Swarm', swarm);
  console.log('Added:', WSS_ADDR);
}

ipfsConfig('Swarm.Transports.Network.Websocket', {
  Cert: CERT_FILE,
  Key: KEY_FILE
});

console.log('Run `ipfs daemon` (or restart Kubo) for the change to take effect.');
console.log('After restart, use an address like:');
console.log('  /ip4/192.168.1.74/tcp/4003/wss/p2p/<KUBO_PEER_ID>');
