import WebSocket from 'ws';
import { spawn } from 'child_process';
import { tmpDir, findChrome, isVerbose, vlog } from './utils.mjs';

const chrome = findChrome();
vlog('Using Chrome:', chrome);
const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--remote-debugging-port=9231'], { stdio: 'ignore' });

vlog('Waiting for Chrome DevTools Protocol...');
await new Promise(r => setTimeout(r, 6000));
const targets = await fetch('http://127.0.0.1:9231/json').then(r => r.json());
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
vlog('Navigating to http://127.0.0.1:5173');
await send('Page.navigate', { url: 'http://127.0.0.1:5173' });

vlog('Waiting for node status to become ready...');
for (let i = 0; i < 60; i++) {
  const r = await send('Runtime.evaluate', { expression: 'document.getElementById("node-status").textContent', returnByValue: true });
  const t = r?.result?.value || '';
  vlog(`node-status #${i + 1}:`, t);
  if (t.includes('All repository files added') || t.includes('published') || t.includes('publish')) break;
  await new Promise(r => setTimeout(r, 1000));
}

const peerId = (await send('Runtime.evaluate', { expression: 'window.__heliaNode?.libp2p?.peerId?.toString()', returnByValue: true }))?.result?.value;
console.log('PEER ID:', peerId);

const addrs = (await send('Runtime.evaluate', { expression: 'window.__heliaNode?.libp2p?.getMultiaddrs()?.map(a=>a.toString())', returnByValue: true }))?.result?.value;
console.log('MULTIADDRS:', addrs);

vlog('Clicking bootstrap button');
await send('Runtime.evaluate', { expression: 'document.getElementById("btn-bootstrap").click()' });
await new Promise(r => setTimeout(r, 8000));
const connectStatus = (await send('Runtime.evaluate', { expression: 'document.getElementById("connect-status").textContent', returnByValue: true }))?.result?.value;
console.log('CONNECT STATUS:', connectStatus);

// Optional: dial a Kubo multiaddr from env
const kuboAddr = process.env.KUBO_MULTIADDR;
if (kuboAddr) {
  vlog('KUBO_MULTIADDR set, dialing:', kuboAddr);
  await send('Runtime.evaluate', { expression: `document.getElementById("input-multiaddr").value = ${JSON.stringify(kuboAddr)}` });
  await send('Runtime.evaluate', { expression: 'document.getElementById("btn-connect").click()' });
  await new Promise(r => setTimeout(r, 8000));
  const cs = (await send('Runtime.evaluate', { expression: 'document.getElementById("connect-status").textContent', returnByValue: true }))?.result?.value;
  console.log('KUBO CONNECT STATUS:', cs);
}

vlog('Cleaning up Chrome process');
ws.close();
proc.kill();
process.exit(0);
