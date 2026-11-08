import WebSocket from 'ws';
import { spawn } from 'child_process';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { findChrome, isVerbose, vlog, testUrl } from './utils.mjs';

const chrome = findChrome();
const PORT_A = 9232; // sender node
const PORT_B = 9233; // recipient node (opens the share link)
const PORT_C = 9234; // fresh browser for the negative-path (unreachable link) test

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

  // The link is proven if A lists B OR fresh content actually flows B<-A.
  // A's inbound relayed connection can be churn-pruned while B's dial still
  // reports success, so a single signal is flaky — accept either, and keep
  // the B<-A transfer going while we poll A's peer list.
  const cidBefore = await A.evalJson(`document.getElementById('output-cid').textContent.trim()`);
  await A.evalJson(`(() => {
    document.getElementById('input-content').value = 'share-link-e2e-${Date.now()}';
    document.getElementById('btn-publish').click();
    return true;
  })()`);
  const freshCid = await waitFor(
    A.evalJson,
    `(() => { const c = document.getElementById('output-cid').textContent.trim(); return c && c !== ${JSON.stringify(cidBefore)} ? c : null; })()`,
    30000,
    500
  );

  const aSeesBExpr = `(() => {
    const id = ${JSON.stringify(peerIdB || '')};
    const viaLibp2p = window.__heliaNode.libp2p.getPeers().map(String).includes(id);
    const viaUi = document.getElementById('peers-list').textContent.includes(id);
    return viaLibp2p || viaUi;
  })()`;

  let aSeesB = false;
  let e2eLen = 0;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline && !aSeesB && e2eLen === 0) {
    aSeesB = (await A.evalJson(aSeesBExpr)) === true;
    if (!aSeesB && freshCid) {
      await B.evalJson(`window.__runFetch(${JSON.stringify(freshCid)}, 'e2e.txt')`, true);
      e2eLen = (await B.evalJson(`window.__getLastFetched().len`)) || 0;
    }
    if (!aSeesB && e2eLen === 0) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  check('share link works end-to-end (A sees B or content flows B<-A)', aSeesB === true || e2eLen > 0, `aSeesB=${aSeesB} e2eLen=${e2eLen} freshCid=${freshCid}`);

  // Negative path: a stale/unreachable share link must fail visibly (after retries), not hang silently.
  // Use a fresh browser: re-navigating the tab that already runs a live libp2p node can
  // leave the old document in place, and the poll would read the previous session's status.
  // The peer id must come from a freshly generated key: dial() reuses an existing
  // connection when the peer id is already connected, and a previously hardcoded id
  // turned out to be a live network peer — which made this spuriously "succeed".
  vlog('Checking failure path with an unreachable share link...');
  const C = await launchNode(PORT_C);
  const deadKey = await generateKeyPair('Ed25519');
  const badAddr = `/ip4/127.0.0.1/tcp/1/ws/p2p/${peerIdFromPrivateKey(deadKey)}`;
  const badLink = testUrl + (testUrl.includes('?') ? '&' : '?') + 'connect=' + encodeURIComponent(badAddr) + '&_cb=' + Date.now();
  const nav = await C.send('Page.navigate', { url: badLink });
  check('bad link navigation accepted', !nav?.errorText, nav?.errorText || '');
  const badPageLoaded = await waitFor(
    C.evalJson,
    `new URLSearchParams(location.search).get('connect') === ${JSON.stringify(badAddr)}`,
    30000,
    1000
  );
  check('bad link page actually loaded', badPageLoaded === true);
  const failedVisibly = await waitFor(
    C.evalJson,
    `document.getElementById('connect-status').textContent.startsWith('Auto-connect failed')`,
    90000,
    2000
  );
  const csText = await C.evalJson(`document.getElementById('connect-status').textContent`);
  const ssText = await C.evalJson(`document.getElementById('share-status').textContent`);
  check('unreachable share link fails visibly after retries', failedVisibly === true, `connect-status="${csText}" share-status="${ssText}"`);
  C.ws.close();
  C.proc.kill();
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
