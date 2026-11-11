import WebSocket from 'ws';
import { vlog, check, finish, testUrl, launchChrome } from './utils.mjs';

// CID linkification (docs/ipfs-uri-providers.md step 3): every rendered
// CID becomes a link — click fetches in-app and opens the affordance
// popover (gateway / ipfs:// / providers / pin). Commands in pre stay
// copy-pure. Step 4: the companion preference toggles interception.
const PORT = 9252;

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
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
  if (r.result?.exceptionDetails) {
    return { __exception: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
  }
  return r.result?.result?.value;
};

vlog('Navigating to', testUrl);
await send('Page.navigate', { url: testUrl });

// Node must be online before the boot publish renders the clone bar CID.
for (let i = 0; i < 120; i++) {
  const online = await evalJson(`(() => {
    const s = document.getElementById('node-status');
    return Boolean(s && /Online/.test(s.textContent) && !/Error/.test(s.textContent));
  })()`);
  if (online === true) break;
  await new Promise((r) => setTimeout(r, 2000));
}

// The clone bar's root CID gets linkified by the page-wide pass.
let linkInfo = null;
for (let i = 0; i < 20; i++) {
  linkInfo = await evalJson(`(() => {
    const a = document.querySelector('a.cid-link');
    if (!a) return null;
    return { text: a.textContent.trim(), href: a.getAttribute('href') };
  })()`);
  if (linkInfo && /^(?:baf|bag|Qm)/.test(linkInfo.text)) break;
  await new Promise((r) => setTimeout(r, 500));
}
check('a CID on the page is linkified with its full value',
  Boolean(linkInfo && linkInfo.text.length > 40 && linkInfo.href === `ipfs://${linkInfo.text}`),
  JSON.stringify(linkInfo));

check('command blocks stay copy-pure (no links inside pre)',
  await evalJson(`document.querySelectorAll('pre a.cid-link').length === 0`));

// Click the link: in-app fetch runs AND the popover opens with the full
// affordance set.
await evalJson(`(() => { document.querySelector('a.cid-link').click(); return true; })()`);
await new Promise((r) => setTimeout(r, 600));
const pop = await evalJson(`(() => {
  const p = document.getElementById('cid-popover');
  if (!p) return null;
  const t = p.textContent;
  return {
    cid: p.querySelector('div').textContent.trim(),
    hasIpfsUri: Boolean(p.querySelector('a[href^="ipfs://"]')),
    hasGateway: t.includes('https://ipfs.io/ipfs/'),
    hasPinCmd: t.includes('ipfs pin add '),
    providersText: p.querySelector('.f6') ? p.querySelector('.f6').textContent : ''
  };
})()`);
check('popover opens with full CID, ipfs:// + gateway links, pin command',
  Boolean(pop && pop.cid.length > 40 && pop.hasIpfsUri && pop.hasGateway && pop.hasPinCmd),
  JSON.stringify(pop));

// Providers section resolves (count or failure note — network-dependent).
let providersDone = false;
for (let i = 0; i < 15; i++) {
  providersDone = await evalJson(`(() => {
    const p = document.getElementById('cid-popover');
    const el = p && p.querySelector('.f6');
    const t = el ? el.textContent : '';
    return /providers?|lookup failed/i.test(t);
  })()`);
  if (providersDone) break;
  await new Promise((r) => setTimeout(r, 1000));
}
check('providers section resolves (delegated routing)', providersDone === true);

// Companion preference: ON -> native ipfs:// passthrough (no in-app
// fetch); OFF -> interception sets the fetch input.
const setCompanion = (on) => evalJson(`(() => {
  const t = document.getElementById('pref-companion');
  t.checked = ${on};
  t.dispatchEvent(new Event('change'));
  return true;
})()`);
await setCompanion(true);
check('companion toggle persists in localStorage', await evalJson(`localStorage.getItem('pref-ipfs-companion') === '1'`));

const clickSynthetic = async () => {
  await evalJson(`(() => {
    let a = document.getElementById('synthetic-ipfs-link');
    if (!a) {
      a = document.createElement('a');
      a.id = 'synthetic-ipfs-link';
      a.href = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
      a.textContent = 'synthetic';
      document.body.appendChild(a);
    }
    document.getElementById('input-cid').value = '';
    a.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  return evalJson(`document.getElementById('input-cid').value`);
};

const passthroughVal = await clickSynthetic();
check('companion ON: ipfs:// click passes through (no in-app fetch)', passthroughVal === '');

await setCompanion(false);
const interceptedVal = await clickSynthetic();
check('companion OFF: ipfs:// click is intercepted into the fetch view',
  interceptedVal === 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi', interceptedVal);

ws.close();
proc.kill();
finish('CID LINKS TEST');
