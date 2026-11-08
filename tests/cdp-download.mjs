import WebSocket from 'ws';
import { spawn } from 'child_process';
import fs from 'fs';
import { tmpDir, findChrome, isVerbose, vlog, testUrl, check, finish, waitForDebugger } from './utils.mjs';

const chrome = findChrome();
vlog('Using Chrome:', chrome);
const dlDir = tmpDir('dltest');
fs.rmSync(dlDir, { recursive: true, force: true });
fs.mkdirSync(dlDir, { recursive: true });
vlog('Download directory:', dlDir);
const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--remote-debugging-port=9224'], { stdio: 'ignore' });

vlog('Waiting for Chrome DevTools Protocol...');
await waitForDebugger(9224);

// Connect at the browser level and drive a CDP-created tab. Downloads only
// honor Browser.setDownloadBehavior's downloadPath on CDP-created targets —
// the browser's initial startup tab ignores it (see tests/debug-download.mjs).
const version = await fetch('http://127.0.0.1:9224/json/version').then(r => r.json());
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
vlog('CDP browser WebSocket connected');

let msgId = 1;
function send(method, params = {}, sessionId = undefined) {
  return new Promise((resolve) => {
    const id = msgId++;
    const handler = (data) => {
      const msg = JSON.parse(data);
      if (msg.id === id) { ws.off('message', handler); resolve(msg); }
    };
    ws.on('message', handler);
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
  });
}

const dlConfig = await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, eventsEnabled: true });
check('download behavior configured', Boolean(dlConfig) && !dlConfig.error, JSON.stringify(dlConfig?.error || {}));

const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
const pageSend = (method, params = {}) => send(method, params, sessionId).then((r) => r.result);
vlog('Attached to CDP-created target:', targetId);

await pageSend('Page.enable');
await pageSend('Runtime.enable');
vlog('Navigating to', testUrl);
await pageSend('Page.navigate', { url: testUrl });

vlog('Waiting for node status to become ready...');
for (let i = 0; i < 60; i++) {
  const r = await pageSend('Runtime.evaluate', { expression: 'document.getElementById("node-status").textContent', returnByValue: true });
  const t = r?.result?.value || '';
  vlog(`node-status #${i + 1}:`, t);
  if (t.includes('All repository files added')) break;
  await new Promise(r => setTimeout(r, 1000));
}
const status = (await pageSend('Runtime.evaluate', { expression: 'document.getElementById("node-status").textContent', returnByValue: true }))?.result?.value;
console.log('STATUS:', status);

const expr = `(() => {
  const li = Array.from(document.querySelectorAll('#file-tree li.row')).find(x => x.textContent.includes('index.html'));
  const cidEl = li && li.querySelector('.cell-cid');
  const m = cidEl && cidEl.textContent.trim().match(/^(baf[a-z0-9]+)/);
  return m ? m[1] : null;
})()`;
const cid = (await pageSend('Runtime.evaluate', { expression: expr, returnByValue: true }))?.result?.value;
console.log('CID:', cid);
vlog('Running window.__runFetch for', cid);
await pageSend('Runtime.evaluate', { expression: `window.__runFetch(${JSON.stringify(cid)}, 'index.html')`, awaitPromise: true });
await new Promise(r => setTimeout(r, 2000));
const info = (await pageSend('Runtime.evaluate', { expression: 'window.__getLastFetched()', returnByValue: true }))?.result?.value;
console.log('FETCHED:', info);
const btnDisabled = (await pageSend('Runtime.evaluate', { expression: 'document.getElementById("btn-download").disabled', returnByValue: true }))?.result?.value;
console.log('DOWNLOAD DISABLED:', btnDisabled);

vlog('Clicking download button');
await pageSend('Runtime.evaluate', { expression: 'document.getElementById("btn-download").click()' });
await new Promise(r => setTimeout(r, 6000));
const files = fs.readdirSync(dlDir);
console.log('Downloaded files:', files);

check('index.html CID extracted from tree', /^baf[a-z0-9]+$/.test(cid || ''), `cid=${cid}`);
check('download button enabled after fetch', btnDisabled === false, `disabled=${btnDisabled}`);
check('exactly one file downloaded', files.length === 1, files.join(','));
check('downloaded file is a zip', files[0]?.endsWith('.zip') === true, files[0]);
finish('DOWNLOAD TEST');
