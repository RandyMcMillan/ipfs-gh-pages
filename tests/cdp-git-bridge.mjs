import WebSocket from 'ws';
import { vlog, check, finish, testUrl, launchChrome } from './utils.mjs';

// Git-host bridge (docs/issues-car.md phase 12), app side: the index chain
// status shows the export command the pre-push hook consumes, and the
// "Sync index tip" field merges a tip CID handed over by the post-merge
// hook (or a peer) per the Chronology protocol.
const PORT = 9250;

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
const evalJson = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
  if (r.result?.exceptionDetails) {
    return { __exception: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
  }
  return r.result?.result?.value;
};

vlog('Navigating to', testUrl);
await send('Page.navigate', { url: testUrl });

// Node must be online before creating an issue (the chain extends on create).
for (let i = 0; i < 120; i++) {
  const online = await evalJson(`(() => {
    const s = document.getElementById('node-status');
    return Boolean(s && /Online/.test(s.textContent) && !/Error/.test(s.textContent));
  })()`);
  if (online === true) break;
  await new Promise((r) => setTimeout(r, 2000));
}

// Create an issue through the real UI so the chain has a tip. The title is
// unique per run so leftover profile state can never satisfy the checks —
// the tip must come from THIS run's create.
const TITLE = `cdp git bridge probe ${Date.now()}`;
await evalJson(`(() => { window.location.hash = '/issues'; return true; })()`);
await new Promise((r) => setTimeout(r, 500));
await evalJson(`(() => {
  document.getElementById('issue-title').value = ${JSON.stringify(TITLE)};
  document.getElementById('issue-body').value = 'created by tests/cdp-git-bridge.mjs';
  return true;
})()`);
await evalJson(`document.getElementById('btn-issue-create').click(); true`);

let tipCid = null;
for (let i = 0; i < 30; i++) {
  tipCid = await evalJson(`(() => {
    const issues = JSON.parse(localStorage.getItem('repo-issues') || '[]');
    if (!issues.some((i) => i.title === ${JSON.stringify(TITLE)})) return null;
    const tip = JSON.parse(localStorage.getItem('repo-index-chain') || 'null');
    return tip && /^baguq[a-z0-9]{20,}$/.test(tip.cid) ? tip.cid : null;
  })()`);
  if (tipCid) break;
  await new Promise((r) => setTimeout(r, 1000));
}
check('index chain tip exists after create', Boolean(tipCid), tipCid || 'none');

// Outbound: the chain status carries the export command with the FULL tip
// CID and the git-path the pre-push hook reads.
check('chain status shows the hook export command', await evalJson(`(() => {
  const el = document.getElementById('index-chain-status');
  const t = el ? el.textContent : '';
  return t.includes("printf '%s\\\\n' '${tipCid}'")
    && t.includes('git rev-parse --git-path ipfs-index-tip');
})()`));

// Inbound: pasting our own tip is a noop with a clear message.
await evalJson(`(() => {
  document.getElementById('index-sync-cid').value = '${tipCid}';
  return true;
})()`);
await evalJson(`document.getElementById('btn-index-sync').click(); true`);
let noopMsg = false;
for (let i = 0; i < 15; i++) {
  noopMsg = await evalJson(`(() => {
    const s = document.getElementById('index-sync-status').textContent;
    return s.includes('Already current') && s.includes('${tipCid}');
  })()`);
  if (noopMsg) break;
  await new Promise((r) => setTimeout(r, 500));
}
check('syncing the current tip reports already-current', noopMsg === true);

// Inbound failure: a well-formed but unresolvable tip must fail gracefully,
// naming the full CID (never truncated).
const GHOST = 'baguqiger3qvmvq5b3tm5x4vbgwls5k3li63jumdifywczijqh5wfjvqp7zz';
await evalJson(`(() => {
  document.getElementById('index-sync-cid').value = '${GHOST}';
  return true;
})()`);
await evalJson(`document.getElementById('btn-index-sync').click(); true`);
let failMsg = false;
for (let i = 0; i < 30; i++) {
  failMsg = await evalJson(`(() => {
    const s = document.getElementById('index-sync-status').textContent;
    return s.includes('Sync failed for ${GHOST}');
  })()`);
  if (failMsg) break;
  await new Promise((r) => setTimeout(r, 1000));
}
check('unresolvable tip fails gracefully with the full CID', failMsg === true);

// The issue list still renders (sync path did not clobber local state).
check('issue list intact after sync attempts', await evalJson(`(() => {
  const issues = JSON.parse(localStorage.getItem('repo-issues') || '[]');
  return issues.some((i) => i.title === ${JSON.stringify(TITLE)});
})()`));

ws.close();
proc.kill();
finish('GIT BRIDGE TEST');
