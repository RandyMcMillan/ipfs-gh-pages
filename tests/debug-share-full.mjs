import WebSocket from 'ws';
import { spawn } from 'child_process';
import { findChrome, testUrl } from './utils.mjs';

// Replicate the full share-link test scenario (nodes A, B, then C on a bad
// link) and dump node C's libp2p state transitions to catch how a dial to an
// unreachable address can report success.
const chrome = findChrome();
const PORT_A = 9232;
const PORT_B = 9233;
const PORT_C = 9234;
const badAddr = '/ip4/127.0.0.1/tcp/1/ws/p2p/12D3KooWRx1BxMZ7nYyeM8RLyGaWAKyqv8GhMCT7KNW7TMkTVTVB';

async function launchNode(port) {
  const proc = spawn(chrome, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 30; i++) {
    try {
      targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
      if (targets.find((t) => t.type === 'page')) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let msgId = 1;
  const pending = new Map();
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
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
    if (r.result?.exceptionDetails) return { __exception: r.result.exceptionDetails.exception?.description };
    return r.result?.result?.value;
  };
  return { proc, ws, send, evalJson };
}

async function waitFor(evalJson, expression, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evalJson(expression);
    if (value) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

console.log('== launching A ==');
const A = await launchNode(PORT_A);
await A.send('Page.navigate', { url: testUrl });
const aReady = await waitFor(A.evalJson, `/Online & (All repository|Publishing|Root CID|Added files)/.test(document.getElementById('node-status').textContent)`, 120000);
console.log('A ready:', aReady === true);
const multiaddr = await waitFor(A.evalJson, `(() => { const ma = window.__getShareableMultiaddr && window.__getShareableMultiaddr(); return (ma && ma.includes('/p2p-circuit')) ? ma : null; })()`, 120000);
console.log('A shareable addr:', multiaddr);

if (multiaddr) {
  const link = testUrl + '?connect=' + encodeURIComponent(multiaddr);
  console.log('== launching B on good link ==');
  const B = await launchNode(PORT_B);
  await B.send('Page.navigate', { url: link });
  const bConnected = await waitFor(B.evalJson, `document.getElementById('connect-status').textContent === 'Connected to peer from link.'`, 90000, 2000);
  console.log('B connected:', bConnected === true);

  // Instrument the A-side view of B: what does A actually see, and when?
  const peerIdB = await B.evalJson('window.__heliaNode?.libp2p?.peerId?.toString()');
  console.log('peerIdB:', peerIdB);
  console.log('B connections:', await B.evalJson(`window.__heliaNode.libp2p.getConnections().map(c => c.remotePeer.toString() + ' @ ' + c.remoteAddr.toString())`));
  const aProbe = `JSON.stringify({
    peers: window.__heliaNode.libp2p.getPeers().map(String),
    conns: window.__heliaNode.libp2p.getConnections().map(c => c.remotePeer.toString()),
    ui: document.getElementById('peers-list').textContent
  })`;
  const aDeadline = Date.now() + 90000;
  let aLast = '';
  while (Date.now() < aDeadline) {
    const state = JSON.parse(await A.evalJson(aProbe) || '{}');
    const seesB = (state.peers || []).includes(peerIdB);
    const key = `peers=${state.peers?.length} seesB=${seesB}`;
    if (key !== aLast) { console.log(new Date().toISOString().slice(11, 19), 'A:', key); aLast = key; }
    if (seesB) {
      console.log('A sees B — conns sample:', JSON.stringify((state.conns || []).slice(0, 5)));
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!aLast.includes('seesB=true')) console.log('A NEVER saw B within 90s');

  console.log('== launching C on bad link (instrumented) ==');
  const C = await launchNode(PORT_C);
  const badLink = testUrl + '?connect=' + encodeURIComponent(badAddr) + '&_cb=' + Date.now();
  await C.send('Page.navigate', { url: badLink });
  const loaded = await waitFor(C.evalJson, `new URLSearchParams(location.search).get('connect') === ${JSON.stringify(badAddr)}`, 30000, 1000);
  console.log('C on bad link page:', loaded === true);

  const probe = `JSON.stringify({
    cs: document.getElementById('connect-status')?.textContent,
    ss: document.getElementById('share-status')?.textContent,
    peers: window.__heliaNode ? window.__heliaNode.libp2p.getPeers().map(String) : [],
    conns: window.__heliaNode ? window.__heliaNode.libp2p.getConnections().map(c => c.remotePeer.toString() + ' @ ' + c.remoteAddr.toString()) : []
  })`;
  let last = '';
  const deadline = Date.now() + 100000;
  while (Date.now() < deadline) {
    const state = JSON.parse(await C.evalJson(probe) || '{}');
    const key = state.cs + '|' + state.ss;
    if (key !== last) {
      console.log(new Date().toISOString().slice(11, 19), 'cs:', JSON.stringify(state.cs), 'ss:', JSON.stringify(state.ss));
      last = key;
      if (state.cs && (state.cs.startsWith('Auto-connect failed') || state.cs.startsWith('Connected to peer from link'))) {
        console.log('TERMINAL STATE REACHED — dumping C libp2p state:');
        console.log('peers:', JSON.stringify(state.peers, null, 1));
        console.log('conns:', JSON.stringify(state.conns, null, 1));
        console.log('connect param:', await C.evalJson(`new URLSearchParams(location.search).get('connect')`));
        console.log('input field:', await C.evalJson(`document.getElementById('input-multiaddr').value`));
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  C.ws.close(); C.proc.kill();
  B.ws.close(); B.proc.kill();
}
A.ws.close(); A.proc.kill();
process.exit(0);
