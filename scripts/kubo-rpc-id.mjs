import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const RPC_HOST = process.env.KUBO_RPC_HOST || '127.0.0.1';
const RPC_PORT = parseInt(process.env.KUBO_RPC_PORT || '5001', 10);
const RPC_PROBE_PORTS = Array.from({ length: 10 }, (_, i) => 5001 + i);
const RPC_PROBE_TIMEOUT_MS = 2000;

// Ask the local Kubo through the `ipfs` CLI — it locates the running daemon
// itself, so usually no ports are needed.
export function getKuboIdFromCli() {
  const out = execSync('ipfs id', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out); // { ID, Addresses, ... }
}

async function rpcRequest(pathname, host = RPC_HOST, port = RPC_PORT, timeoutMs = 0) {
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`http://${host}:${port}${pathname}`, { method: 'POST', signal: controller.signal });
    const data = await res.text();
    if (!res.ok) throw new Error(`Kubo RPC returned ${res.status}: ${data}`);
    try {
      return JSON.parse(data);
    } catch (e) {
      throw new Error(`Invalid JSON from Kubo RPC: ${e.message}`);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Single request to one host:port (defaults: KUBO_RPC_HOST / KUBO_RPC_PORT).
export async function getKuboId({ host, port } = {}) {
  return rpcRequest('/api/v0/id', host, port);
}

// Find Kubo's RPC API by scanning ports 5001-5010 in parallel (2s each).
// Returns { info, port }. Throws if nothing answers.
export async function findKuboId({ host = RPC_HOST, ports = RPC_PROBE_PORTS } = {}) {
  const results = await Promise.all(ports.map(async (port) => {
    try {
      return { port, info: await rpcRequest('/api/v0/id', host, port, RPC_PROBE_TIMEOUT_MS) };
    } catch (error) {
      return { port, error };
    }
  }));
  const found = results.find((r) => r.info);
  if (found) return found;
  throw new Error(`No Kubo RPC answered on ${host} ports ${ports.join(', ')}`);
}

// Best-effort Kubo info: `ipfs id` CLI first, then an RPC probe of 5001-5010.
export async function getKuboInfo() {
  try {
    return { info: getKuboIdFromCli(), via: 'ipfs id' };
  } catch {}
  const found = await findKuboId();
  return { info: found.info, via: `RPC port ${found.port}` };
}

// Find Kubo's WebSocket listen port from its advertised addresses, or null.
export function detectKuboWsPort(info) {
  const wsAddr = (info.Addresses || []).find((a) => a.includes('/ws') && !a.includes('/wss'));
  const m = wsAddr && wsAddr.match(/\/tcp\/(\d+)\/ws/);
  return m ? parseInt(m[1], 10) : null;
}

export function formatWssMultiaddr(host, port, peerId) {
  const ip = host === '0.0.0.0' ? '127.0.0.1' : host;
  return `/ip4/${ip}/tcp/${port}/wss/p2p/${peerId}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const { info, via } = await getKuboInfo();
    console.log('Peer ID:', info.ID, `(${via})`);
    console.log('Addresses:');
    for (const addr of info.Addresses || []) {
      console.log(' ', addr);
    }
  } catch (err) {
    console.error('Failed to query Kubo:', (err.message || String(err)).trim());
    console.error('Tried: ipfs CLI, then RPC ports 5001-5010 on ' + RPC_HOST);
    process.exit(1);
  }
}
