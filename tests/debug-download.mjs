// Debug tool: figure out how to make headless Chrome save programmatic
// blob downloads to a chosen directory, and print download progress events.
// Usage: npm run dev (in another terminal), then: node tests/debug-download.mjs
import WebSocket from 'ws';
import fs from 'node:fs';
import { launchChrome } from './utils.mjs';

const dlDir = '/tmp/dltest-ctx';
fs.rmSync(dlDir, { recursive: true, force: true });
fs.mkdirSync(dlDir, { recursive: true });

const { proc } = await launchChrome(9223);

const version = await fetch('http://127.0.0.1:9223/json/version').then(r => r.json());
const bws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { bws.on('open', res); bws.on('error', rej); });
let id = 1;
const pending = new Map();
bws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Browser.downloadProgress') console.log('EVENT:', m.params.guid, m.params.state);
});
const send = (method, params = {}) => new Promise((resolve) => { const i = id++; pending.set(i, resolve); bws.send(JSON.stringify({ id: i, method, params })); });

// Fresh browser context with download behavior set on it
const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
const ssend = (method, params = {}) => new Promise((resolve) => { const i = id++; pending.set(i, resolve); bws.send(JSON.stringify({ sessionId, id: i, method, params })); });

const r1 = await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, eventsEnabled: true });
console.log('setDownloadBehavior (browser):', JSON.stringify(r1));
await ssend('Page.enable');
await ssend('Runtime.enable');
await ssend('Page.navigate', { url: 'http://127.0.0.1:5173' });
await new Promise(r => setTimeout(r, 8000));

// Trigger a programmatic blob download like the app's Download button does
const expr = `(() => {
  const blob = new Blob(['hello-zip'], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'ctx-test.zip';
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  return 'clicked';
})()`;
console.log('click:', await ssend('Runtime.evaluate', { expression: expr, returnByValue: true }).then(r => r.result?.result?.value));
await new Promise(r => setTimeout(r, 5000));
console.log('dlDir contents:', fs.readdirSync(dlDir));
console.log('~/Downloads ctx-test:', fs.readdirSync(process.env.HOME + '/Downloads').filter(f => f.includes('ctx-test')));

bws.close();
proc.kill();
process.exit(0);
