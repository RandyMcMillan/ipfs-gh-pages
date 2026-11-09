import WebSocket from 'ws';
import { isVerbose, vlog, check, finish, testUrl, launchChrome } from './utils.mjs';

// Phase 4 — IPNS branch pointer: once the repo root CID is published, the
// toolbar chip must show /ipns/<peerId> from a persistent Ed25519 key, and
// clicking it must copy. Runs against the dev server.
const PORT = 9236;

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

// Wait for the Helia node to finish booting and publishing the root CID.
vlog('Waiting for the IPNS branch chip...');
let chip = null;
for (let i = 0; i < 150; i++) {
  chip = await evalJson(`(() => {
    const c = document.getElementById('ipns-branch-chip');
    if (c && !c.disabled && c.dataset.ipns) return { text: c.textContent, ipns: c.dataset.ipns, title: c.title };
    const s = document.getElementById('node-status');
    return { pending: true, status: s ? s.textContent : '' };
  })()`);
  if (chip && !chip.pending) break;
  if (chip?.status && /Initialization Error/i.test(chip.status)) break;
  await new Promise((r) => setTimeout(r, 2000));
}
check('chip published an IPNS name', chip && !chip.pending && /^\/ipns\/12D3KooW/.test(chip.ipns || ''), JSON.stringify(chip)?.slice(0, 200));

// The Ed25519 key must persist in localStorage so refreshes keep the name.
const storedKey = await evalJson(`Object.keys(localStorage).find((k) => k.startsWith('ipns-branch-key:')) || null`);
check('branch key persisted in localStorage', typeof storedKey === 'string' && storedKey.length > 0, storedKey);

// The chip name must be stable across a re-read (same key, not regenerated).
const again = await evalJson(`document.getElementById('ipns-branch-chip').dataset.ipns`);
check('IPNS name stable', again === (chip && chip.ipns), `${chip?.ipns} vs ${again}`);

// The click-to-copy handler is bound on the next 2s interval tick after the
// chip appears — wait for the binding before clicking, or the click no-ops.
for (let i = 0; i < 30; i++) {
  if (await evalJson(`document.getElementById('ipns-branch-chip').dataset.bound === '1'`)) break;
  await new Promise((r) => setTimeout(r, 500));
}
check('copy handler bound', await evalJson(`document.getElementById('ipns-branch-chip').dataset.bound === '1'`));

// Click-to-copy flashes confirmation text.
await evalJson(`document.getElementById('ipns-branch-chip').click(); true`);
await new Promise((r) => setTimeout(r, 300));
const flashed = await evalJson(`document.getElementById('ipns-branch-chip').textContent`);
check('click flashes copy confirmation', flashed === 'Copied to clipboard', flashed);

ws.close();
proc.kill();
finish('IPNS BRANCH CHIP TEST');
