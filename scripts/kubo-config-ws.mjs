import { execSync } from 'node:child_process';

const WS_ADDR = process.env.KUBO_WS_ADDR || '/ip4/0.0.0.0/tcp/4002/ws';

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

console.log('Configuring Kubo WebSocket listener...');
console.log('Address to add:', WS_ADDR);

const swarm = ipfsConfigGet('Addresses.Swarm') || [];
if (swarm.includes(WS_ADDR)) {
  console.log('Address already present:', WS_ADDR);
} else {
  swarm.push(WS_ADDR);
  ipfsConfig('Addresses.Swarm', swarm);
  console.log('Added:', WS_ADDR);
}

console.log('Run `ipfs daemon` (or restart Kubo) for the change to take effect.');
console.log('After restart, use an address like:');
console.log('  /ip4/127.0.0.1/tcp/4002/ws/p2p/<KUBO_PEER_ID>');
