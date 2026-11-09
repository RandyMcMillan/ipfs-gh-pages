import WebSocket from 'ws';
import { tmpDir, isVerbose, vlog, testUrl, check, finish, launchChrome } from './utils.mjs';

vlog('Waiting for Chrome DevTools Protocol...');
const { proc, page } = await launchChrome(9225);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
vlog('CDP WebSocket connected');

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

await send('Page.enable');
await send('Runtime.enable');
vlog('Navigating to', testUrl);
await send('Page.navigate', { url: testUrl });

vlog('Waiting for node status to become ready...');
for (let i = 0; i < 60; i++) {
  const r = await send('Runtime.evaluate', { expression: 'document.getElementById("node-status").textContent', returnByValue: true });
  const t = r?.result?.value || '';
  vlog(`node-status #${i + 1}:`, t);
  if (t.includes('All repository files added')) break;
  await new Promise(r => setTimeout(r, 1000));
}

const expr = `(() => {
  const li = Array.from(document.querySelectorAll('#file-tree li.row')).find(x => x.textContent.includes('index.html'));
  const cidEl = li && li.querySelector('.cell-cid');
  const m = cidEl && cidEl.textContent.trim().match(/^(baf[a-z0-9]+)/);
  return m ? m[1] : null;
})()`;
const cid = (await send('Runtime.evaluate', { expression: expr, returnByValue: true }))?.result?.value;
vlog('Running window.__runFetch for', cid);
await send('Runtime.evaluate', { expression: `window.__runFetch(${JSON.stringify(cid)}, 'index.html')`, awaitPromise: true });
await new Promise(r => setTimeout(r, 2000));

const r = await send('Runtime.evaluate', {
  expression: `(() => {
    const info = window.__getLastFetched();
    return JSON.stringify(info);
  })()`,
  returnByValue: true
});
console.log('LAST FETCHED:', r?.result?.value);

const info = JSON.parse(r?.result?.value || 'null');
check('index.html CID extracted from tree', /^baf[a-z0-9]+$/.test(cid || ''), `cid=${cid}`);
check('fetched bytes look like the app shell (len > 5000)', info?.len > 5000, `len=${info?.len}`);
check('fetched name is index.html', info?.name === 'index.html', `name=${info?.name}`);
finish('EVAL TEST');
