import WebSocket from 'ws';
import { testUrl, launchChrome } from './utils.mjs';

const PORT = 9243;
const { proc, page } = await launchChrome(PORT);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

let msgId = 1;
const pending = new Map();
const consoleErrors = [];
ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(msg.params.exceptionDetails?.exception?.description || JSON.stringify(msg.params.exceptionDetails));
  } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args?.map((a) => a.value ?? a.description).join(' '));
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
  return r.result?.result?.value;
};

await send('Page.navigate', { url: testUrl });
await new Promise((r) => setTimeout(r, 6000));

console.log('tab buttons:', await evalJson(`[...document.querySelectorAll('.tab-button')].map(b => b.dataset.tab).join(',')`));
console.log('fetch card in files tab:', await evalJson(`document.getElementById('tab-files').contains(document.getElementById('input-cid'))`));
console.log('fetch card visible (files tab active):', await evalJson(`document.getElementById('tab-files').classList.contains('active') && getComputedStyle(document.getElementById('input-cid')).display !== 'none'`));
console.log('orphan fetch panel exists:', await evalJson(`Boolean(document.getElementById('tab-fetch'))`));
console.log('node status:', await evalJson(`document.getElementById('node-status').textContent`));
console.log('console errors:', consoleErrors.length ? consoleErrors : 'none');

ws.close();
proc.kill();
process.exit(consoleErrors.length ? 1 : 0);
