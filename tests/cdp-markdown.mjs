import WebSocket from 'ws';
import { vlog, check, finish, testUrl, launchChrome } from './utils.mjs';

// GitHub-like markdown (docs/markdown-rendering.md) in the real browser:
// the README card renders GFM through the marked+DOMPurify pipeline, CSP
// blocks inline handlers, and network content (issue bodies) renders in
// a sandboxed iframe. Port 9258.
const PORT = 9258;

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
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    return { __exception: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
  }
  return r.result?.result?.value;
};

vlog('Navigating to', testUrl);
await send('Page.navigate', { url: testUrl });

// Node online = the app works under the CSP (script-src 'self' didn't
// break the bundle or the theme script).
for (let i = 0; i < 120; i++) {
  const online = await evalJson(`(() => {
    const s = document.getElementById('node-status');
    return Boolean(s && /Online/.test(s.textContent) && !/Error/.test(s.textContent));
  })()`);
  if (online === true) break;
  await new Promise((r) => setTimeout(r, 2000));
}
check('app boots and node online under CSP script-src self',
  await evalJson(`(() => /Online/.test(document.getElementById('node-status').textContent))()`));

// CSP blocks inline event handlers (the XSS backstop).
const cspHeld = await evalJson(`(async () => {
  window.__cspHit = 0;
  const div = document.createElement('div');
  div.innerHTML = '<img src="/definitely-missing-csp-probe" onerror="window.__cspHit=1">';
  document.body.appendChild(div);
  await new Promise((r) => setTimeout(r, 800));
  div.remove();
  return window.__cspHit === 0;
})()`);
check('CSP blocks inline event handlers', cspHeld === true);

// README card renders GFM through the pipeline (not plain text).
const readme = await evalJson(`(() => {
  const el = document.getElementById('readme-content');
  if (!el) return null;
  const html = el.innerHTML;
  return {
    visible: document.getElementById('readme-card').style.display !== 'none',
    hasPre: html.includes('<pre>'),
    hasList: html.includes('<li>') || html.includes('<ul>'),
    hasLink: html.includes('<a '),
    noScript: !html.includes('<script'),
    noInlineSvg: !/<svg[\\s>]/i.test(html)
  };
})()`);
check('README card renders markdown (pre/lists/links present)',
  Boolean(readme && readme.visible && readme.hasPre && readme.hasList && readme.hasLink),
  JSON.stringify(readme));
check('README card sanitized (no script, no inline SVG)',
  Boolean(readme && readme.noScript && readme.noInlineSvg), JSON.stringify(readme));

// Network content (issue body with a script payload) renders in a
// sandboxed iframe and does not execute.
await evalJson(`(() => { window.location.hash = '/issues'; return true; })()`);
await new Promise((r) => setTimeout(r, 500));
await evalJson(`(() => {
  document.getElementById('issue-title').value = 'cdp markdown probe';
  document.getElementById('issue-body').value = 'hello <script>window.__xss=1</script> <img src=x onerror="window.__xss=2"> **bold**';
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
check('issue with payload created', Boolean(created), created || 'none');

await evalJson(`(() => {
  const links = [...document.querySelectorAll('#issues-list a')];
  const mine = links.find((a) => a.textContent === 'cdp markdown probe');
  if (mine) mine.click();
  return Boolean(mine);
})()`);
await new Promise((r) => setTimeout(r, 3000));
const sandbox = await evalJson(`(() => {
  const frame = document.querySelector('#issue-detail-body iframe');
  return {
    hasFrame: Boolean(frame),
    sandboxAttr: frame ? frame.getAttribute('sandbox') : null,
    xss: window.__xss || 0
  };
})()`);
check('issue body renders in a sandboxed iframe',
  Boolean(sandbox && sandbox.hasFrame && sandbox.sandboxAttr !== null && !sandbox.sandboxAttr.includes('allow-same-origin')),
  JSON.stringify(sandbox));
check('payload did not execute', sandbox && sandbox.xss === 0, JSON.stringify(sandbox));

ws.close();
proc.kill();
finish('MARKDOWN TEST');
