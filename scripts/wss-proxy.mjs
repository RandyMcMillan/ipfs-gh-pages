import tls from 'node:tls';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';

const USAGE = `Usage: npm run proxy:wss -- [kuboWsPort] [proxyPort]

  kuboWsPort  Kubo's WebSocket port to forward to (auto-detected from 'ipfs id' if omitted)
  proxyPort   port for the TLS proxy to listen on (default 4003)

Examples:
  npm run proxy:wss                  # find Kubo's /ws port automatically
  npm run proxy:wss -- 5001          # Kubo ws on 5001, proxy on 4003
  npm run proxy:wss -- 5001 4004     # ...and proxy on 4004`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
const badArgs = argv.filter((a) => !/^\d+$/.test(a));
if (badArgs.length > 0) {
  console.error(`Unknown argument(s): ${badArgs.join(', ')}\n`);
  console.error(USAGE);
  process.exit(1);
}
const { getKuboInfo, detectKuboWsPort, formatWssMultiaddr } = await import('./kubo-rpc-id.mjs');

const PROXY_PORT = parseInt(process.env.PROXY_PORT || argv[1] || '4003', 10);
const PROXY_HOST = process.env.PROXY_HOST || '0.0.0.0';
const KUBO_HOST = process.env.KUBO_HOST || '127.0.0.1';
const CERT_FILE = process.env.WSS_CERT || './certs/cert.pem';
const KEY_FILE = process.env.WSS_KEY || './certs/key.pem';

// Resolve which Kubo ws port to forward to. An explicit arg wins; otherwise
// ask Kubo directly (ipfs CLI, else RPC probe of 5001-5010) and read the /ws
// port from its addresses. Falls back to the conventional 4002 with a note.
let kuboInfo = null;
let kuboVia = null;
let KUBO_PORT = null;
if (argv[0]) {
  KUBO_PORT = parseInt(argv[0], 10);
  try {
    ({ info: kuboInfo, via: kuboVia } = await getKuboInfo());
  } catch {}
} else {
  try {
    ({ info: kuboInfo, via: kuboVia } = await getKuboInfo());
  } catch (err) {
    console.error('Could not query Kubo:', (err.message || String(err)).trim());
    console.error('Tried: ipfs CLI, then RPC ports 5001-5010.');
    console.error('Start Kubo first, or pass the ws port explicitly: npm run proxy:wss -- <kuboWsPort>');
    process.exit(1);
  }
  KUBO_PORT = detectKuboWsPort(kuboInfo);
  if (!KUBO_PORT) {
    KUBO_PORT = 4002;
    console.warn('Note: Kubo advertises no /ws listener — forwarding to the conventional ws port 4002.');
    console.warn('If connections fail: npm run kubo:ws, restart Kubo, or pass the port (npm run proxy:wss -- <kuboWsPort>).');
    console.warn('');
  }
}

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

server.listen(PROXY_PORT, PROXY_HOST, () => {
  console.log(`WSS proxy listening on wss://${PROXY_HOST}:${PROXY_PORT}`);
  console.log(`Forwarding to Kubo WS at ws://${KUBO_HOST}:${KUBO_PORT}`);
  if (kuboInfo) {
    console.log('');
    console.log('Kubo Peer ID:', kuboInfo.ID);
    console.log('Dial the proxy using one of these addresses:');
    if (PROXY_HOST === '0.0.0.0' || PROXY_HOST === '127.0.0.1') {
      console.log(' ', formatWssMultiaddr('127.0.0.1', PROXY_PORT, kuboInfo.ID));
    }
    for (const ip of getLanIps()) {
      console.log(' ', formatWssMultiaddr(ip, PROXY_PORT, kuboInfo.ID));
    }
    if (PROXY_HOST !== '0.0.0.0' && PROXY_HOST !== '127.0.0.1') {
      console.log(' ', formatWssMultiaddr(PROXY_HOST, PROXY_PORT, kuboInfo.ID));
    }
  } else {
    console.log('(Kubo peer ID unavailable — is the daemon running? The proxy still forwards.)');
  }
});

server.on('error', (err) => {
  console.error('WSS proxy error:', err.message);
  process.exit(1);
});
