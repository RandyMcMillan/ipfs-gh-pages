import WebSocket from 'ws';
import { tmpDir, launchChrome } from './utils.mjs';

const { proc, page } = await launchChrome(9227);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.on('open', ()=>{console.log('ws open'); res();}); ws.on('error', rej); });

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
await send('Page.navigate', { url: 'http://127.0.0.1:5173' });

for (let i = 0; i < 60; i++) {
  const r = await send('Runtime.evaluate', { expression: 'document.getElementById("node-status").textContent', returnByValue: true });
  const t = r?.result?.value || '';
  console.log('status:', t.slice(0,50));
  if (t.includes('All repository files added') || t.includes('published') || t.includes('publish')) break;
  await new Promise(r => setTimeout(r, 1000));
}

const expr = `(() => {
  const li = Array.from(document.querySelectorAll('#file-tree li.row')).find(x => x.textContent.includes('index.html'));
  const cidEl = li && li.querySelector('.cell-cid');
  const m = cidEl && cidEl.textContent.trim().match(/^(baf[a-z0-9]+)/);
  return m ? m[1] : null;
})()`;
const cid = (await send('Runtime.evaluate', { expression: expr, returnByValue: true }))?.result?.value;
console.log('index.html CID:', cid);

await send('Runtime.evaluate', { expression: `window.__runFetch(${JSON.stringify(cid)}, 'index.html')`, awaitPromise: true });
await new Promise(r => setTimeout(r, 2000));
const info = (await send('Runtime.evaluate', { expression: 'window.__getLastFetched()', returnByValue: true }))?.result?.value;
console.log('Fetched:', info);

ws.close();
proc.kill();
process.exit(0);
