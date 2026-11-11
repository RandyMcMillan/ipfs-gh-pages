import WebSocket from 'ws';
import { vlog, check, finish, testUrl, launchChrome } from './utils.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// App-surface interop: the page's own Helia node must fetch the vector
// (tests/fixtures/interop-vectors.json) from the network — delegated
// routing → provider dial → bitswap — and show byte-exact content.
// Node-side surfaces (gateways, Kubo RPC) are covered by
// tests/interop-vectors.test.mjs.
const PORT = 9254;
const vectors = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'interop-vectors.json'), 'utf8')
);

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

// Node must be online before fetching from the network.
for (let i = 0; i < 120; i++) {
  const online = await evalJson(`(() => {
    const s = document.getElementById('node-status');
    return Boolean(s && /Online/.test(s.textContent) && !/Error/.test(s.textContent));
  })()`);
  if (online === true) break;
  await new Promise((r) => setTimeout(r, 2000));
}

for (const v of vectors) {
  // Drive the real Files UI: paste the CID, click Fetch.
  await evalJson(`(() => {
    window.location.hash = '/files';
    const input = document.getElementById('input-cid');
    input.value = '${v.cid}';
    document.getElementById('btn-fetch').click();
    return true;
  })()`);

  let outcome = null;
  for (let i = 0; i < 60; i++) {
    outcome = await evalJson(`(async () => {
      const out = document.getElementById('output-content');
      const t = out ? out.textContent : '';
      if (/Error retrieving CID/.test(t)) return { error: t };
      if (t.length < ${v.size}) return null;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      return { text: t.slice(0, 120), sha256: hex };
    })()`);
    if (outcome) break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (outcome && outcome.error) {
    check(`${v.name}: in-app Helia fetch`, false, outcome.error);
  } else {
    check(`${v.name}: in-app Helia fetch returns content`,
      Boolean(outcome && outcome.text && outcome.text.includes('<svg')),
      JSON.stringify(outcome));
    check(`${v.name}: fetched content is byte-exact (sha256 of rendered text)`,
      Boolean(outcome && outcome.sha256 === v.sha256),
      outcome ? `${outcome.sha256} vs ${v.sha256}` : 'no outcome');
  }
}

ws.close();
proc.kill();
finish('INTEROP VECTOR TEST');
