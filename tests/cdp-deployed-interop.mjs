// Post-deploy interop smoke: load the DEPLOYED page twice in two isolated
// headless Chrome instances (separate storage dirs => separate Helia
// nodes + identities) and verify they discover and connect to each other
// over the repo-gossip gossipsub channel — no local services involved.
// Also verifies the local-service interop probe FAILS GRACEFULLY when no
// rust app is listening on 127.0.0.1:5050 (the CI case).
//
// Env: TEST_URL (default: the deployed Pages URL). WebRTC dials on CI can
// be slow — generous timeouts, and the workflow retries the whole test.

import { launchChrome, check, finish, vlog } from './utils.mjs';

const url = process.env.TEST_URL || 'https://randymcmillan.github.io/ipfs-gh-pages/';
const PEER_ONLINE_TIMEOUT_MS = 120_000;
const DISCOVERY_TIMEOUT_MS = 120_000;

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', (e) => reject(new Error(`ws error: ${e.message || e.type}`)));
  });
}

async function makeSession(port) {
  const { proc, page } = await launchChrome(port, [`--user-data-dir=/tmp/interop-chrome-${port}`]);
  const ws = await connect(page.webSocketDebuggerUrl);
  let msgId = 1;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = msgId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression, awaitPromise = false) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }))?.result?.value;

  await send('Page.enable');
  await send('Runtime.enable');
  vlog(`[${port}] navigating to ${url}`);
  await send('Page.navigate', { url });
  return { proc, send, evaluate, port };
}

async function waitForPeerId(session) {
  const deadline = Date.now() + PEER_ONLINE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const peerId = await session.evaluate(
      `window.__heliaNode && window.__heliaNode.libp2p.peerId.toString()`
    );
    if (peerId) return peerId;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`node did not come online within ${PEER_ONLINE_TIMEOUT_MS / 1000}s`);
}

async function waitForPeers(session) {
  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const n = await session.evaluate(`window.__heliaNode.libp2p.getPeers().length`);
    vlog(`[${session.port}] peers:`, n);
    if (n > 0) return n;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return 0;
}

let a, b;
try {
  // Two chrome instances so storage (and thus identity/localStorage) is
  // fully isolated — mimics two users opening the deployed page.
  a = await makeSession(9231);
  b = await makeSession(9232);

  const [peerA, peerB] = await Promise.all([waitForPeerId(a), waitForPeerId(b)]);
  console.log('Peer A:', peerA);
  console.log('Peer B:', peerB);
  check('node A online', Boolean(peerA));
  check('node B online', Boolean(peerB));
  check('distinct identities', peerA !== peerB);

  // The interop assertion: A and B share the repoFullName-derived gossip
  // topic, so pubsubPeerDiscovery should make them dial each other.
  const [nA, nB] = await Promise.all([waitForPeers(a), waitForPeers(b)]);
  check('A discovered and connected to a peer', nA > 0, `peers=${nA}`);
  check('B discovered and connected to a peer', nB > 0, `peers=${nB}`);

  // Negative interop case (nothing listens on 5050 in CI): the probe must
  // reject cleanly, not throw uncaught.
  const probe = await a.evaluate(
    `fetch('http://127.0.0.1:5050/well-known/identity').then(() => 'reachable').catch(() => 'unreachable')`,
    true
  );
  check('5050 interop probe fails gracefully when no local app', probe === 'unreachable', `probe=${probe}`);

  finish('DEPLOYED INTEROP SMOKE');
} catch (err) {
  console.error('DEPLOYED INTEROP SMOKE: fatal:', err.message);
  process.exit(1);
} finally {
  a?.proc.kill('SIGKILL');
  b?.proc.kill('SIGKILL');
}
