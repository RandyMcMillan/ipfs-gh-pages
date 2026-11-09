import WebSocket from 'ws';
import { testUrl, launchChrome } from './utils.mjs';

// Repro: open the app with an unreachable ?connect= link and watch what autoConnectFromUrl does.
const PORT = 9242;
const badPeer = '12D3KooWRx1BxMZ7nYyeM8RLyGaWAKyqv8GhMCT7KNW7TMkTVTVB';
const badAddr = `/ip4/127.0.0.1/tcp/1/ws/p2p/${badPeer}`;
const badLink = `${testUrl}?connect=${encodeURIComponent(badAddr)}&_cb=${Date.now()}`;

const { proc, page } = await launchChrome(PORT);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

let msgId = 1;
const pending = new Map();
ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const id = msgId++;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
await send('Page.enable');
await send('Runtime.enable');

const evalJson = async (expression, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, timeout: 120000 });
  if (r.error) return { __error: r.error.message };
  if (r.result?.exceptionDetails) return { __exception: r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails) };
  return r.result?.result?.value;
};

console.log('navigating to:', badLink);
await send('Page.navigate', { url: badLink });

const deadline = Date.now() + 90000;
let last = '';
while (Date.now() < deadline) {
  const state = await evalJson(`JSON.stringify({
    cs: document.getElementById('connect-status')?.textContent,
    ss: document.getElementById('share-status')?.textContent,
    badConn: window.__heliaNode ? window.__heliaNode.libp2p.getConnections().filter(c => c.remotePeer.toString() === ${JSON.stringify(badPeer)}).map(c => c.remoteAddr.toString()) : null,
    peerCount: window.__heliaNode ? window.__heliaNode.libp2p.getPeers().length : -1
  })`);
  const s = JSON.stringify(state);
  if (s !== last) { console.log(new Date().toISOString().slice(11, 19), s); last = s; }
  if (state && typeof state === 'object' && state.cs && (state.cs.startsWith('Auto-connect failed') || state.cs.startsWith('Connected to peer'))) break;
  await new Promise((r) => setTimeout(r, 2000));
}

ws.close();
proc.kill();
process.exit(0);
