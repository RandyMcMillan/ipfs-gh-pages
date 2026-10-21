import http from 'node:http';

const RPC_HOST = process.env.KUBO_RPC_HOST || '127.0.0.1';
const RPC_PORT = parseInt(process.env.KUBO_RPC_PORT || '5001', 10);

function rpcRequest(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: RPC_HOST, port: RPC_PORT, path, method: 'POST' },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`Invalid JSON from Kubo RPC: ${e.message}`));
            }
          } else {
            reject(new Error(`Kubo RPC returned ${res.statusCode}: ${data}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

export async function getKuboId() {
  return rpcRequest('/api/v0/id');
}

export function formatWssMultiaddr(host, port, peerId) {
  const ip = host === '0.0.0.0' ? '127.0.0.1' : host;
  return `/ip4/${ip}/tcp/${port}/wss/p2p/${peerId}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const info = await getKuboId();
    console.log('Peer ID:', info.ID);
    console.log('Addresses:');
    for (const addr of info.Addresses || []) {
      console.log(' ', addr);
    }
  } catch (err) {
    console.error('Failed to fetch Kubo ID:', err.message);
    console.error('Make sure Kubo is running with the RPC API on', `${RPC_HOST}:${RPC_PORT}`);
    process.exit(1);
  }
}
