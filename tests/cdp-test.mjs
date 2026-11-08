import WebSocket from 'ws';
import { spawn } from 'child_process';
import { tmpDir, findChrome, isVerbose, vlog, testUrl, check, finish, waitForDebugger } from './utils.mjs';

const chrome = findChrome();
vlog('Using Chrome:', chrome);
const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--remote-debugging-port=9227'], { stdio: 'ignore' });

vlog('Waiting for Chrome DevTools Protocol...');
const page = await waitForDebugger(9227);
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
  const li = Array.from(document.querySelectorAll('#file-tree li')).find(x => x.textContent.includes('index.html'));
  const m = li && li.textContent.match(/(baf[a-z0-9]+)/);
  return m ? m[1] : null;
})()`;
const cid = (await send('Runtime.evaluate', { expression: expr, returnByValue: true }))?.result?.value;
console.log('index.html CID:', cid);
vlog('Running window.__runFetch for', cid);

await send('Runtime.evaluate', { expression: `window.__runFetch(${JSON.stringify(cid)}, 'index.html')`, awaitPromise: true });
await new Promise(r => setTimeout(r, 2000));
const info = (await send('Runtime.evaluate', { expression: 'window.__getLastFetched()', returnByValue: true }))?.result?.value;
console.log('Fetched:', info);

check('index.html CID extracted from tree', /^baf[a-z0-9]+$/.test(cid || ''), `cid=${cid}`);
check('fetched content is non-empty', Boolean(info && info.len > 0), JSON.stringify(info));
check('fetched name is index.html', info?.name === 'index.html', `name=${info?.name}`);
check('fetched content is a file, not a directory', info?.isDir === false);
finish('FETCH TEST');
