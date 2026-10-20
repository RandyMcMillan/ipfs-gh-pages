import WebSocket from 'ws';
import { spawn } from 'child_process';

const chrome = '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev';
const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--remote-debugging-port=9227'], { stdio: 'ignore' });

await new Promise(r => setTimeout(r, 6000));
const targets = await fetch('http://127.0.0.1:9227/json').then(r => r.json());
const page = targets.find(t => t.type === 'page');
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

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:5173' });

for (let i = 0; i < 60; i++) {
  const r = await send('Runtime.evaluate', { expression: 'document.getElementById("node-status").textContent', returnByValue: true });
  const t = r?.result?.value || '';
  if (t.includes('All repository files added')) break;
  await new Promise(r => setTimeout(r, 1000));
}

const expr = `(() => {
  const spans = Array.from(document.querySelectorAll('#file-tree span'));
  const s = spans.find(x => x.textContent.includes('index.html'));
  const m = s.textContent.match(/(baf[a-z0-9]+)/);
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
