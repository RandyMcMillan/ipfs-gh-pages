import WebSocket from 'ws';
import { vlog, check, finish, testUrl, launchChrome } from './utils.mjs';

// Blame + root chain (docs/issues-car.md phases 10-11): publishing
// records a release-commit object {type, root, prev, timestamp}; the blob
// view's Blame toggle attributes every line to the oldest release
// containing it, and a blame cell carries a blame-comment note anchored
// to the line's origin root — riding the line across later versions.
const PORT = 9248;

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

// Node must be online before publishing (the release object is recorded
// during the boot publish).
for (let i = 0; i < 120; i++) {
  const online = await evalJson(`(() => {
    const s = document.getElementById('node-status');
    return Boolean(s && /Online/.test(s.textContent) && !/Error/.test(s.textContent));
  })()`);
  if (online === true) break;
  await new Promise((r) => setTimeout(r, 2000));
}

// Phase 10: the boot publish recorded a release whose root IS the Clone
// bar's current root CID, and the chain starts at genesis (prev null).
const releaseInfo = await evalJson(`(() => {
  const tips = JSON.parse(localStorage.getItem('repo-release-chain') || '[]');
  const cloneCid = (document.getElementById('clone-cid') || {}).textContent || '';
  const tip = tips[0] || null;
  return {
    n: tips.length,
    tipRoot: tip && tip.root,
    tipCid: tip && tip.cid,
    tipPrev: tip ? ('prev' in tip ? 'present' : 'absent') : 'none',
    cloneCid: cloneCid.trim()
  };
})()`);
check('release recorded at boot with the Clone bar root',
  releaseInfo && releaseInfo.n >= 1 && releaseInfo.tipRoot === releaseInfo.cloneCid && /^baguq[a-z0-9]{20,}$/.test(releaseInfo.tipCid || ''),
  JSON.stringify(releaseInfo));

// Open a file through the real tree UI.
await evalJson(`(() => {
  const names = [...document.querySelectorAll('#tree-view .cell-name')];
  const isFile = (n) => !n.closest('li')?.querySelector(':scope > ul.nested');
  const wanted = ['main.js', 'index.html', 'AGENTS.md', 'package.json'];
  const name = names.find((n) => wanted.includes(n.textContent.trim()) && isFile(n))
    || names.find((n) => isFile(n));
  if (name) name.click();
  return Boolean(name);
})()`).then((ok) => check('opened a blob through the tree UI', ok === true));
let rowsReady = false;
for (let i = 0; i < 20; i++) {
  rowsReady = await evalJson(`(() => {
    const v = document.getElementById('blob-view');
    return Boolean(v && !v.hidden && document.querySelectorAll('#blob-code .line').length >= 3);
  })()`);
  if (rowsReady) break;
  await new Promise((r) => setTimeout(r, 500));
}
check('blob view rendered at least 3 lines', rowsReady === true);

// Phase 11: Blame toggle attributes every line to the single release.
await evalJson(`document.getElementById('btn-blame-toggle').click(); true`);
let blameReady = false;
for (let i = 0; i < 30; i++) {
  blameReady = await evalJson(`(() => {
    const rows = document.querySelectorAll('#blob-code .line');
    const bl = document.querySelectorAll('#blob-code .bl');
    if (rows.length < 3 || bl.length !== rows.length) return false;
    const tip = JSON.parse(localStorage.getItem('repo-release-chain') || '[]')[0];
    return [...bl].every((b) => b.textContent.includes(tip.timestamp));
  })()`);
  if (blameReady) break;
  await new Promise((r) => setTimeout(r, 1000));
}
check('blame attributes every line to the boot release', blameReady === true);
check('blame-on hides line numbers, shows origin column', await evalJson(`(() => {
  const code = document.getElementById('blob-code');
  const ln = code.querySelector('.ln');
  return code.classList.contains('blame-on') && getComputedStyle(ln).display === 'none';
})()`));

// Blame comment: click a blame cell, composer names the origin, publish.
await evalJson(`document.querySelector('#blob-code .bl').click(); true`);
await new Promise((r) => setTimeout(r, 300));
check('blame composer names line + full origin root', await evalJson(`(() => {
  const c = document.getElementById('line-comment-composer');
  const h = document.getElementById('line-comment-heading');
  const tip = JSON.parse(localStorage.getItem('repo-release-chain') || '[]')[0];
  return Boolean(c && !c.hidden && h && h.textContent.includes('line 1')
    && h.textContent.includes('originates in ' + tip.root));
})()`));
await evalJson(`(() => {
  document.getElementById('line-comment-body').value = 'cdp blame comment probe';
  return true;
})()`);
await evalJson(`document.getElementById('btn-line-comment-submit').click(); true`);
let commentCid = null;
for (let i = 0; i < 30; i++) {
  commentCid = await evalJson(`(() => {
    const s = document.getElementById('line-comment-status').textContent;
    const m = s.match(/Commented — (baguq[a-z0-9]+)/);
    return m ? m[1] : null;
  })()`);
  if (commentCid) break;
  await new Promise((r) => setTimeout(r, 1000));
}
check('blame comment published with a dag-json CID', /^baguq[a-z0-9]{20,}$/.test(commentCid || ''), commentCid);

check('blame comment persisted with origin + line', await evalJson(`(() => {
  const list = JSON.parse(localStorage.getItem('repo-blame-comments') || '[]');
  const tip = JSON.parse(localStorage.getItem('repo-release-chain') || '[]')[0];
  return list.some((c) => c.cid === '${commentCid}' && c.origin === tip.root && c.line === 1);
})()`));
check('blame cell badge counts the comment', await evalJson(`(() => {
  const bl = document.querySelector('#blob-code .bl');
  return bl && /💬1/.test(bl.textContent);
})()`));

// Toggle off: origin column removed, line numbers back.
await evalJson(`document.getElementById('btn-blame-toggle').click(); true`);
await new Promise((r) => setTimeout(r, 300));
check('blame toggle restores the line-number gutter', await evalJson(`(() => {
  const code = document.getElementById('blob-code');
  return code.querySelectorAll('.bl').length === 0 && !code.classList.contains('blame-on')
    && getComputedStyle(code.querySelector('.ln')).display !== 'none';
})()`));

ws.close();
proc.kill();
finish('BLAME TEST');
