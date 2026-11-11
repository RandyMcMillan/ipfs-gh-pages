import WebSocket from 'ws';
import { isVerbose, vlog, check, finish, testUrl, launchChrome } from './utils.mjs';

// Line comments (docs/issues-car.md phase 9): selecting lines in the blob
// view offers "Comment on lines X–Y"; submitting publishes a signed
// line-comment note anchored to the blob CID, extends the index chain,
// renders the gutter marker, and lists the verified comment in the panel.
const PORT = 9246;

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

// Node must be online before publishing.
for (let i = 0; i < 120; i++) {
  const online = await evalJson(`(() => {
    const s = document.getElementById('node-status');
    return Boolean(s && /Online/.test(s.textContent) && !/Error/.test(s.textContent));
  })()`);
  if (online === true) break;
  await new Promise((r) => setTimeout(r, 2000));
}

// Open a file through the real tree UI (a code file — it renders line
// rows; this repo has no README.md to rely on).
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

// Select lines 1–3 inside the code; the floating action bar must appear.
await evalJson(`(() => {
  const rows = document.querySelectorAll('#blob-code .line');
  const r = document.createRange();
  r.setStart(rows[0].querySelector('.lc').firstChild, 0);
  r.setEnd(rows[2].querySelector('.lc').firstChild, 2);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  return true;
})()`);
let barReady = false;
for (let i = 0; i < 20; i++) {
  barReady = await evalJson(`(() => {
    const bar = document.getElementById('line-comment-bar');
    const btn = document.getElementById('btn-line-comment-start');
    return Boolean(bar && !bar.hidden && btn && /Comment on lines 1–3/.test(btn.textContent));
  })()`);
  if (barReady) break;
  await new Promise((r) => setTimeout(r, 300));
}
check('selection offers "Comment on lines 1–3"', barReady === true);

// Open the composer and submit a comment through the real UI.
await evalJson(`document.getElementById('btn-line-comment-start').click(); true`);
await new Promise((r) => setTimeout(r, 300));
check('composer opened with the range', await evalJson(`(() => {
  const c = document.getElementById('line-comment-composer');
  const h = document.getElementById('line-comment-heading');
  return Boolean(c && !c.hidden && h && h.textContent.includes('lines 1–3') && /anchored to (bafy|bafkre)/.test(h.textContent));
})()`));
await evalJson(`(() => {
  document.getElementById('line-comment-body').value = 'cdp line comment probe';
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
check('line comment published with a dag-json CID', /^baguq[a-z0-9]{20,}$/.test(commentCid || ''), commentCid);

// Gutter: rows 1–3 tinted, marker present in the line-number cells.
check('gutter marker + tinted rows rendered', await evalJson(`(() => {
  const rows = document.querySelectorAll('#blob-code .line');
  const tinted = [0, 1, 2].every((i) => rows[i].classList.contains('line-commented'));
  const markers = [0, 1, 2].filter((i) => rows[i].querySelector('.ln-marker')).length;
  return tinted && markers === 3;
})()`));

// Persistence: the local index records the exact (cid, line) coordinate.
check('line comment index persisted', await evalJson(`(() => {
  const idx = JSON.parse(localStorage.getItem('repo-line-comments') || '{}');
  return Object.values(idx).some((list) => list.some((c) => c.cid === '${commentCid}' && c.start === 1 && c.end === 3));
})()`));

// Chain extended exactly once more.
check('index chain extended', await evalJson(`(() => {
  const tip = JSON.parse(localStorage.getItem('repo-index-chain') || 'null');
  return Boolean(tip && tip.height >= 1 && /^baguq[a-z0-9]{20,}$/.test(tip.cid));
})()`));

// Panel lists the comment, fetched and verified.
let panelOk = false;
for (let i = 0; i < 20; i++) {
  panelOk = await evalJson(`(() => {
    const p = document.getElementById('line-comment-panel');
    return Boolean(p && !p.hidden && p.textContent.includes('cdp line comment probe') && p.textContent.includes('✓'));
  })()`);
  if (panelOk) break;
  await new Promise((r) => setTimeout(r, 1000));
}
check('panel renders the verified comment', panelOk === true);

ws.close();
proc.kill();
finish('LINE COMMENTS TEST');
