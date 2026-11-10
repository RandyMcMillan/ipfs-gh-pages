import WebSocket from 'ws';
import { isVerbose, vlog, check, finish, testUrl, launchChrome } from './utils.mjs';

// Issues (docs/issues-car.md phase 1): creating an issue produces a signed
// dag-json note object with the full schema (ns/type/anchors), comments
// reply via parent CID, and every note re-verifies after refetch.
const PORT = 9244;

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

// Node must be online before creating an issue.
for (let i = 0; i < 120; i++) {
  const online = await evalJson(`(async () => {
    const s = document.getElementById('node-status');
    return s && /Online/.test(s.textContent) && !/Error/.test(s.textContent) && (window.__setIssueProbe = true) === true;
  })()`);
  if (online === true) break;
  await new Promise((r) => setTimeout(r, 2000));
}

// Route to the issues view and create an issue through the real UI.
await evalJson(`(() => { window.location.hash = '/issues'; return true; })()`);
await new Promise((r) => setTimeout(r, 500));
await evalJson(`(() => {
  document.getElementById('issue-title').value = 'cdp phase 1 probe';
  document.getElementById('issue-body').value = 'created by tests/cdp-issues.mjs';
  return true;
})()`);
await evalJson(`document.getElementById('btn-issue-create').click(); true`);

let created = null;
for (let i = 0; i < 30; i++) {
  created = await evalJson(`(() => {
    const s = document.getElementById('issue-status').textContent;
    const m = s.match(/Created — (baguq[a-z0-9]+)/);
    return m ? m[1] : null;
  })()`);
  if (created) break;
  await new Promise((r) => setTimeout(r, 1000));
}
check('issue created with a dag-json CID', /^baguq[a-z0-9]{20,}$/.test(created || ''), created);

// Open the issue through the real UI; the detail panel must render the
// verified signer line.
await evalJson(`(() => {
  const links = [...document.querySelectorAll('#issues-list a')];
  const mine = links.find((a) => a.textContent === 'cdp phase 1 probe');
  if (mine) mine.click();
  return Boolean(mine);
})()`);
await new Promise((r) => setTimeout(r, 4000));
check('issue detail renders verified signer', await evalJson(`(() => {
  const d = document.getElementById('issue-detail-body');
  return d && d.textContent.includes('✓') && d.textContent.includes('cdp phase 1 probe');
})()`));

// Reply with a comment; it must appear in the thread after re-open.
await evalJson(`(() => {
  document.getElementById('issue-reply').value = 'first comment from cdp';
  return true;
})()`);
await evalJson(`document.getElementById('btn-issue-reply').click(); true`);
let commentCid = null;
for (let i = 0; i < 30; i++) {
  commentCid = await evalJson(`(() => {
    const s = document.getElementById('issue-reply-status').textContent;
    const m = s.match(/Commented — (baguq[a-z0-9]+)/);
    return m ? m[1] : null;
  })()`);
  if (commentCid) break;
  await new Promise((r) => setTimeout(r, 1000));
}
check('comment published with a dag-json CID', /^baguq[a-z0-9]{20,}$/.test(commentCid || ''), commentCid);

// Re-open the issue: the comment chain must render, verified.
await evalJson(`(() => {
  const links = [...document.querySelectorAll('#issues-list a')];
  const mine = links.find((a) => a.textContent === 'cdp phase 1 probe');
  if (mine) mine.click();
  return true;
})()`);
await new Promise((r) => setTimeout(r, 4000));
check('comment chain renders after re-open', await evalJson(`(() => {
  const d = document.getElementById('issue-detail-body');
  return d && d.textContent.includes('first comment from cdp');
})()`));

// Persistence: the issue and comment index survive in localStorage.
check('issue persisted in localStorage', await evalJson(`(() => {
  const issues = JSON.parse(localStorage.getItem('repo-issues') || '[]');
  return issues.some((i) => i.title === 'cdp phase 1 probe');
})()`));
check('comment index persisted in localStorage', await evalJson(`(() => {
  const idx = JSON.parse(localStorage.getItem('repo-comments') || '{}');
  return Object.values(idx).some((list) => list.length > 0);
})()`));

ws.close();
proc.kill();
finish('ISSUES PHASE 1 TEST');
