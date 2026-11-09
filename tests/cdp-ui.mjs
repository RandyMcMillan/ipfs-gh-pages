import WebSocket from 'ws';
import { spawn } from 'child_process';
import { findChrome, isVerbose, vlog, check, finish, testUrl } from './utils.mjs';

// UI chrome regression tests: GitHub-replica behaviors (theme toggle, Code
// dropdown, tab switching, tree interactions, blob view, commit bar) that
// have broken during the parity work. Runs against the dev server.
const chrome = findChrome();
const PORT = 9235;

const proc = spawn(chrome, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`], { stdio: 'ignore' });

let targets = null;
for (let i = 0; i < 30; i++) {
  try {
    targets = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json());
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

vlog('Waiting for the repo tree to render...');
let rows = 0;
for (let i = 0; i < 90; i++) {
  rows = await evalJson(`document.querySelectorAll('#file-tree li.row').length`) || 0;
  if (rows > 10 && !(await evalJson(`document.getElementById('file-tree').textContent.includes('Loading')`))) break;
  await new Promise((r) => setTimeout(r, 1000));
}
check('repo tree rendered', rows > 10, `rows=${rows}`);

// Theme toggle flips data-color-mode and persists.
const modeBefore = await evalJson(`document.documentElement.getAttribute('data-color-mode')`);
await evalJson(`document.getElementById('btn-theme-toggle').click(); true`);
await new Promise((r) => setTimeout(r, 300));
const modeAfter = await evalJson(`document.documentElement.getAttribute('data-color-mode')`);
check('theme toggle flips data-color-mode', modeBefore !== modeAfter, `${modeBefore} -> ${modeAfter}`);
await evalJson(`document.getElementById('btn-theme-toggle').click(); true`);
await new Promise((r) => setTimeout(r, 300));

// Code dropdown: opens, pops over with a real background, share link is the
// full public Pages URL.
vlog('Checking the Code dropdown...');
for (let i = 0; i < 60; i++) {
  if (await evalJson(`!document.getElementById('btn-code').disabled`)) break;
  await new Promise((r) => setTimeout(r, 2000));
}
await evalJson(`document.getElementById('btn-code').click(); true`);
await new Promise((r) => setTimeout(r, 300));
check('dropdown opens', await evalJson(`document.getElementById('code-dropdown').style.display === 'block'`));
const ddBg = await evalJson(`getComputedStyle(document.getElementById('code-dropdown')).backgroundColor`);
check('dropdown has a background', ddBg && ddBg !== 'rgba(0, 0, 0, 0)', `bg=${ddBg}`);
const shareUrl = await evalJson(`document.getElementById('code-share-field').value`);
check('share link is a full Pages URL', /^https:\/\/[^/]+\.github\.io\/[^/?]+\/\?connect=/.test(shareUrl || ''), shareUrl?.slice(0, 80));

// Multiaddr tab: switches panels WITHOUT blanking the repo view.
vlog('Checking the Multiaddr tab...');
const rowsBeforeTab = await evalJson(`document.querySelectorAll('#file-tree li.row').length`);
await evalJson(`document.getElementById('codetab-btn-multiaddr').click(); true`);
await new Promise((r) => setTimeout(r, 300));
check('multiaddr panel shows', await evalJson(`document.getElementById('codetab-panel-multiaddr').style.display !== 'none'`));
const rowsAfterTab = await evalJson(`document.querySelectorAll('#file-tree li.row').length`);
const filesPanelDisplay = await evalJson(`getComputedStyle(document.getElementById('tab-files')).display`);
check('multiaddr tab does not blank the repo view', rowsAfterTab === rowsBeforeTab && rowsAfterTab > 10 && filesPanelDisplay === 'block', `rows ${rowsBeforeTab}->${rowsAfterTab}, filesPanel=${filesPanelDisplay}`);
await evalJson(`document.getElementById('btn-code').click(); true`);
await new Promise((r) => setTimeout(r, 200));

// Folder CID click expands and reveals files.
vlog('Checking folder CID expansion...');
await evalJson(`(() => {
  const rows = [...document.querySelectorAll('#file-tree li.row')];
  const dir = rows.find((x) => x.querySelector('.cell-name span').textContent.endsWith('workflows'));
  if (dir) dir.querySelector('.cell-cid').click();
  return Boolean(dir);
})()`);
await new Promise((r) => setTimeout(r, 400));
const revealed = await evalJson(`[...document.querySelectorAll('#file-tree ul.nested:not([hidden]) > li.row')].map((x) => x.querySelector('.cell-name span').textContent).join(',')`);
check('folder CID expands the tree', (revealed || '').length > 0, revealed);

// File name click opens the blob view; the repo link returns.
vlog('Checking the blob view...');
await evalJson(`(() => {
  const rows = [...document.querySelectorAll('#file-tree li.row')];
  const f = rows.find((x) => x.querySelector('.cell-name span').textContent === 'package.json');
  if (f) f.querySelector('.cell-name').click();
  return Boolean(f);
})()`);
await new Promise((r) => setTimeout(r, 500));
check('blob view opens on file name click', await evalJson(`!document.getElementById('blob-view').hidden`));
check('blob view has line numbers', await evalJson(`document.querySelectorAll('#blob-code .line').length`) > 0);
await evalJson(`document.getElementById('blob-repo-link').click(); true`);
await new Promise((r) => setTimeout(r, 300));
check('repo link returns to the tree', await evalJson(`document.getElementById('blob-view').hidden && !document.getElementById('tree-view').hidden`));

// Commit bar carries real build-time data.
vlog('Checking the commit bar...');
const commitMsg = await evalJson(`document.getElementById('commit-msg').textContent`);
const commitTime = await evalJson(`document.getElementById('commit-time').textContent`);
check('commit bar shows a message', (commitMsg || '').length > 3, commitMsg);
check('commit bar shows relative time', /ago|yesterday/.test(commitTime || ''), commitTime);

// Live metadata either populated or gracefully stayed static (CI is
// unauthenticated: 60 req/h/IP, so only assert no crash + elements exist).
vlog('Checking metadata wiring...');
await new Promise((r) => setTimeout(r, 3000));
check('star counter wired', (await evalJson(`document.getElementById('gh-star-count')?.textContent`)) !== undefined);
check('language bar wired', (await evalJson(`document.querySelectorAll('#lang-bar span').length`)) >= 1);

ws.close();
proc.kill();
finish('UI CHROME TEST');
