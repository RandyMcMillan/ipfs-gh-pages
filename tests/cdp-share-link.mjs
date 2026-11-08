import WebSocket from 'ws';
import { spawn } from 'child_process';
import { findChrome, isVerbose, vlog, testUrl } from './utils.mjs';

const chrome = findChrome();
const PORT_A = 9232; // sender node
const PORT_B = 9233; // recipient node (opens the share link)

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) {
    console.log(`PASS: ${label}`);
  } else {
    failures++;
    console.log(`FAIL: ${label}${detail ? ' — ' + detail : ''}`);
  }
}

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
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
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

  const evalJson = async (expression, awaitPromise = false) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }))?.result?.value;

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

vlog('Starting sender node (A) on port', PORT_A);
const A = await launchNode(PORT_A);
await A.send('Page.navigate', { url: testUrl });
vlog('Waiting for node A to finish adding repo files...');
const aReady = await waitFor(
  A.evalJson,
  `/Online & (All repository|Publishing|Root CID|Added files)/.test(document.getElementById('node-status').textContent)`,
  120000
);
check('node A online with repo files added', aReady === true);

const peerIdA = await A.evalJson('window.__heliaNode?.libp2p?.peerId?.toString()');
console.log('PEER A:', peerIdA);
check('node A has a peer id', Boolean(peerIdA));

// Wait for a relayed (p2p-circuit) shareable address — relay reservation can take a while.
vlog('Waiting for node A to obtain a shareable relayed address...');
const multiaddr = await waitFor(
  A.evalJson,
  `(() => { const ma = window.__getShareableMultiaddr && window.__getShareableMultiaddr(); return (ma && ma.includes('/p2p-circuit')) ? ma : null; })()`,
  120000
);
console.log('SHAREABLE MULTIADDR:', multiaddr);
check('node A produced a relayed shareable address', Boolean(multiaddr));
if (multiaddr) {
  check('address carries a /p2p/ peer id', multiaddr.includes('/p2p/'));
  check('address terminates at peer A', multiaddr.trim().endsWith('/p2p/' + peerIdA));
}

let link = null;
let B = null;
if (multiaddr) {
  link = testUrl + (testUrl.includes('?') ? '&' : '?') + 'connect=' + encodeURIComponent(multiaddr);
  console.log('SHARE LINK:', link);

  vlog('Starting recipient node (B) on port', PORT_B);
  B = await launchNode(PORT_B);
  await B.send('Page.navigate', { url: link });

  // Auto-connect UX: opening the link must fill the multiaddr input and dial on its own.
  const filled = await waitFor(
    B.evalJson,
    `document.getElementById('input-multiaddr').value === ${JSON.stringify(multiaddr)}`,
    20000
  );
  check('share link auto-fills the multiaddr input', filled === true);

  const peerIdB = await B.evalJson('window.__heliaNode?.libp2p?.peerId?.toString()');
  console.log('PEER B:', peerIdB);

  const bConnected = await waitFor(
    B.evalJson,
    `document.getElementById('connect-status').textContent === 'Connected to peer from link.'`,
    90000,
    2000
  );
  check('node B auto-connected from share link', bConnected === true);

  // B dialed A, so A must now see B among its peers. On slow links A-side
  // identify can lag well behind B's dial success, so allow a long window
  // and accept either the connection manager or the UI peers list.
  const aSeesB = await waitFor(
    A.evalJson,
    `(() => {
      const id = ${JSON.stringify(peerIdB || '')};
      const viaLibp2p = window.__heliaNode.libp2p.getPeers().map(String).includes(id);
      const viaUi = document.getElementById('peers-list').textContent.includes(id);
      return viaLibp2p || viaUi;
    })()`,
    90000,
    2000
  );
  check('node A sees node B in its peer list', aSeesB === true);

  // Negative path: a stale/unreachable share link must fail visibly (after retries), not hang silently.
  vlog('Checking failure path with an unreachable share link...');
  const badAddr = '/ip4/127.0.0.1/tcp/1/ws/p2p/12D3KooWRx1BxMZ7nYyeM8RLyGaWAKyqv8GhMCT7KNW7TMkTVTVB';
  const badLink = testUrl + (testUrl.includes('?') ? '&' : '?') + 'connect=' + encodeURIComponent(badAddr);
  await B.send('Page.navigate', { url: badLink });
  const failedVisibly = await waitFor(
    B.evalJson,
    `document.getElementById('connect-status').textContent.startsWith('Auto-connect failed')`,
    45000,
    2000
  );
  check('unreachable share link fails visibly after retries', failedVisibly === true);
}

A.ws.close();
A.proc.kill();
if (B) {
  B.ws.close();
  B.proc.kill();
}

if (failures > 0) {
  console.log(`SHARE LINK TEST: ${failures} failure(s)`);
  process.exit(1);
}
console.log('SHARE LINK TEST: all checks passed');
process.exit(0);
