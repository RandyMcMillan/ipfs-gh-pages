import WebSocket from 'ws';
import { spawn } from 'child_process';
import { tmpDir, findChrome, isVerbose, vlog, testUrl } from './utils.mjs';

const chrome = findChrome();
vlog('Using Chrome:', chrome);
const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--remote-debugging-port=9226'], { stdio: 'ignore' });

vlog('Waiting for Chrome DevTools Protocol...');
await new Promise(r => setTimeout(r, 6000));
const targets = await fetch('http://127.0.0.1:9226/json').then(r => r.json());
const page = targets.find(t => t.type === 'page');
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

const rootCid = (await send('Runtime.evaluate', { expression: 'document.getElementById("output-cid").textContent', returnByValue: true }))?.result?.value;
console.log('ROOT CID:', rootCid);
vlog('Collecting ZIP size for', rootCid);
const size = (await send('Runtime.evaluate', { expression: `window.__collectZipSize(${JSON.stringify(rootCid)})`, awaitPromise: true, returnByValue: true }))?.result?.value;
console.log('ZIP SIZE:', size);

vlog('Cleaning up Chrome process');
ws.close();
proc.kill();
process.exit(0);
