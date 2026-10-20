import tls from 'node:tls';
import net from 'node:net';
import fs from 'node:fs';

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

server.listen(PROXY_PORT, PROXY_HOST, () => {
  console.log(`WSS proxy listening on wss://${PROXY_HOST}:${PROXY_PORT}`);
  console.log(`Forwarding to Kubo WS at ws://${KUBO_HOST}:${KUBO_PORT}`);
  console.log('Use an address like:');
  console.log(`  /ip4/${PROXY_HOST === '0.0.0.0' ? 'YOUR_IP' : PROXY_HOST}/tcp/${PROXY_PORT}/wss/p2p/<KUBO_PEER_ID>`);
});

server.on('error', (err) => {
  console.error('WSS proxy error:', err.message);
  process.exit(1);
});
