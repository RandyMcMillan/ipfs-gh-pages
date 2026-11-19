// CDP suite against the ratzilla TUI (index-rust.html): the bridge state
// the Rust snapshot consumes, verified from a real browser running the
// real wasm + Helia. Asserts the contract from the JS side and issues the
// same op the TUI's Code tab sends (repo.publishAll) through the real
// in-page node. TUI_URL defaults to the test-e2e TUI stage.

import WebSocket from 'ws';
import { vlog, check, finish, launchChrome } from './utils.mjs';

const TUI_URL = process.env.TUI_URL || 'http://127.0.0.1:8077';

vlog('Waiting for Chrome DevTools Protocol (TUI bridge suite)...');
const { proc, page } = await launchChrome(9232);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

let msgId = 1;
function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = msgId++;
    const handler = (data) => {
      const msg = JSON.parse(data);
      if (msg.id === id) { ws.off('message', handler); resolve(msg.result); }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJson(expression, timeoutMs = 0) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r?.result?.value;
}

async function waitFor(expression, label, tries, intervalMs = 1000) {
  for (let i = 0; i < tries; i++) {
    const value = await evalJson(expression);
    if (value) return value;
    vlog(`${label} #${i + 1}/${tries}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

await send('Page.enable');
await send('Runtime.enable');
vlog('Navigating to', TUI_URL);
await send('Page.navigate', { url: TUI_URL });

// Helia boot in headless Chrome is slow on a cold cache — bounded poll.
const status = await waitFor(
  "window.__ipfsState && window.__ipfsState.node && window.__ipfsState.node.status === 'online' ? window.__ipfsState.node.status : null",
  'node status',
  90
);
check('bridge node boots online in the TUI page', status === 'online', `status=${status}`);

const shape = await evalJson(`(() => {
  const r = window.__ipfsState && window.__ipfsState.repo;
  if (!r) return null;
  return JSON.stringify({
    files: Array.isArray(r.files) ? r.files.length : -1,
    workflows: Array.isArray(r.workflows) ? r.workflows.length : -1,
    branch: typeof r.branch === 'string' ? r.branch.length : -1,
    commitCount: typeof r.commitCount === 'string' ? r.commitCount.length : -1,
    readme: typeof r.readme === 'string' ? r.readme.length : -1
  });
})()`);
const s = JSON.parse(shape || 'null');
check('repo.files is a non-empty array', s && s.files > 0, `files=${s?.files}`);
check('repo.workflows parsed at least one', s && s.workflows >= 1, `workflows=${s?.workflows}`);
check('repo.branch present', s && s.branch > 0);
check('repo.commitCount present', s && s.commitCount > 0);
check('repo.readme present', s && s.readme > 0);

// The same op the TUI Code tab sends (InputTarget::RepoPublishAll),
// through the real in-page Helia node.
const CMD_ID = 9001;
await evalJson(`window.__ipfsCmd(${CMD_ID}, 'repo.publishAll', {})`);
const result = await waitFor(
  `window.__ipfsState && window.__ipfsState.results && window.__ipfsState.results[${CMD_ID}] ? JSON.stringify(window.__ipfsState.results[${CMD_ID}]) : null`,
  'publish result',
  180,
  1000
);
const parsed = JSON.parse(result || 'null');
check('repo.publishAll reports ok', parsed && parsed.ok === true, `result=${result}`);
const value = typeof parsed?.value === 'string' ? JSON.parse(parsed.value) : parsed?.value;
check(
  'published root CID is well-formed',
  /^((bafy|bafk|Qm)[a-zA-Z0-9]+)$/.test(value?.rootCid || ''),
  `rootCid=${value?.rootCid}`
);
// fileCount must match the publish manifest the op actually reads
// (assets/repo-files.json — byte-identical repo set per build-repo-files).
const manifestCount = await evalJson(
  `fetch('./assets/repo-files.json').then((r) => r.ok ? r.json().then((e) => Object.keys(e).length) : -1)`,
  0
);
check(
  'published file count matches assets/repo-files.json',
  Number(value?.fileCount) === Number(manifestCount),
  `fileCount=${value?.fileCount} vs manifest=${manifestCount}`
);
check(
  'pin command carries the full root CID',
  String(value?.pinCmd || '').includes(value?.rootCid || 'SENTINEL-NO-ROOT-CID'),
  `pinCmd=${value?.pinCmd}`
);

ws.close();
proc.kill('SIGKILL');
finish('cdp-rust-bridge');
