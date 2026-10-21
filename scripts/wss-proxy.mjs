import tls from 'node:tls';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import { getKuboId, formatWssMultiaddr } from './kubo-rpc-id.mjs';

const PROXY_PORT = parseInt(process.env.PROXY_PORT || '4003', 10);
const PROXY_HOST = process.env.PROXY_HOST || '0.0.0.0';
const KUBO_HOST = process.env.KUBO_HOST || '127.0.0.1';
const KUBO_PORT = parseInt(process.env.KUBO_PORT || '4002', 10);
const CERT_FILE = process.env.WSS_CERT || './certs/cert.pem';
const KEY_FILE = process.env.WSS_KEY || './certs/key.pem';

if (!fs.existsSync(CERT_FILE) || !fs.existsSync(KEY_FILE)) {
  console.error('Certificate files not found:');
  console.error('  CERT:', CERT_FILE);
  console.error('  KEY:', KEY_FILE);
  console.error('Generate them first with: npm run cert:generate');
  process.exit(1);
}

const server = tls.createServer(
  {
    cert: fs.readFileSync(CERT_FILE),
    key: fs.readFileSync(KEY_FILE)
  },
  (clientSocket) => {
    const kuboSocket = net.connect(KUBO_PORT, KUBO_HOST);

    kuboSocket.on('connect', () => {
      clientSocket.pipe(kuboSocket);
      kuboSocket.pipe(clientSocket);
    });

    kuboSocket.on('error', (err) => {
      console.error(`Kubo connection error (${KUBO_HOST}:${KUBO_PORT}):`, err.message);
      clientSocket.end();
    });

    clientSocket.on('error', (err) => {
      console.error('Client socket error:', err.message);
      kuboSocket.end();
    });

    kuboSocket.on('close', () => clientSocket.end());
    clientSocket.on('close', () => kuboSocket.end());
  }
);

function getLanIps() {
  const ips = [];
  for (const [name, ifaces] of Object.entries(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (!iface.internal && iface.family === 'IPv4') {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

server.listen(PROXY_PORT, PROXY_HOST, async () => {
  console.log(`WSS proxy listening on wss://${PROXY_HOST}:${PROXY_PORT}`);
  console.log(`Forwarding to Kubo WS at ws://${KUBO_HOST}:${KUBO_PORT}`);
  try {
    const info = await getKuboId();
    console.log('');
    console.log('Kubo Peer ID:', info.ID);
    console.log('Dial the proxy using one of these addresses:');
    if (PROXY_HOST === '0.0.0.0' || PROXY_HOST === '127.0.0.1') {
      console.log(' ', formatWssMultiaddr('127.0.0.1', PROXY_PORT, info.ID));
    }
    for (const ip of getLanIps()) {
      console.log(' ', formatWssMultiaddr(ip, PROXY_PORT, info.ID));
    }
    if (PROXY_HOST !== '0.0.0.0' && PROXY_HOST !== '127.0.0.1') {
      console.log(' ', formatWssMultiaddr(PROXY_HOST, PROXY_PORT, info.ID));
    }
  } catch (err) {
    console.error('');
    console.error('Could not fetch Kubo peer ID via RPC:', err.message);
    console.error('Make sure Kubo is running. You can also run:');
    console.error('  npm run kubo:id');
  }
});

server.on('error', (err) => {
  console.error('WSS proxy error:', err.message);
  process.exit(1);
});
