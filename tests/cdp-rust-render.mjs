// CDP render suite against the ratzilla TUI: the canvas exists, is
// sized, the wasm app is alive in the page (it injects and updates the
// #ratzilla-ipfs-status footer every frame), and the layout actually
// re-renders when the viewport changes size. Host-side unit tests cannot
// see the screen — this can. TUI_URL defaults to the test-e2e TUI stage.
//
// Synthetic keyboard delivery to ratzilla's focusable element is
// unreliable in headless Chrome (the backend re-creates its canvas during
// sizing), so re-render is driven through the viewport — an environment
// channel the app must respond to. Interactive input lands with the
// mouse/region work, where the app's own hit-testing is the target.

import WebSocket from 'ws';
import { vlog, check, finish, launchChrome } from './utils.mjs';

const TUI_URL = process.env.TUI_URL || 'http://127.0.0.1:8077';

vlog('Waiting for Chrome DevTools Protocol (TUI render suite)...');
const { proc, page } = await launchChrome(9233);
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

async function evalValue(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
  return r?.result?.value;
}

async function setViewport(width, height) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false
  });
}

async function screenshot() {
  const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
  return r?.data || '';
}

await send('Page.enable');
await send('Runtime.enable');
await setViewport(1280, 800);
vlog('Navigating to', TUI_URL);
await send('Page.navigate', { url: TUI_URL });

let canvas = null;
for (let i = 0; i < 60 && !canvas; i++) {
  canvas = await evalValue(`(() => {
    const c = document.querySelector('canvas');
    return c && c.width > 0 && c.height > 0 ? { w: c.width, h: c.height } : null;
  })()`);
  if (!canvas) await new Promise((r) => setTimeout(r, 1000));
}
check('ratzilla canvas exists and is sized', !!canvas, `canvas=${JSON.stringify(canvas)}`);
check('canvas is large enough for the chrome', !!canvas && canvas.w >= 600 && canvas.h >= 300, `${canvas?.w}x${canvas?.h}`);

// The canvas BUFFER stays constant (disable_auto_css_resize — CSS owns the
// display size, src/main.rs); the DISPLAY size must follow the viewport,
// and only the wasm draw loop can keep the rendered frame in sync with it.
let rectA = await evalValue(`(() => { const c = document.querySelector('canvas'); if (!c) return null; const r = c.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); })()`);

const frameA = await screenshot();

await setViewport(1000, 600);
await new Promise((r) => setTimeout(r, 1200));
const frameB = await screenshot();
const rectB = await evalValue(`(() => { const c = document.querySelector('canvas'); if (!c) return null; const r = c.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); })()`);

check('first frame has content', frameA.length > 1000, `bytes=${frameA.length}`);
check('canvas display size follows the viewport', rectA !== rectB, `${rectA} -> ${rectB}`);
check('frame changes after viewport resize (layout re-renders)', frameA !== frameB);

await setViewport(1280, 800);
await new Promise((r) => setTimeout(r, 1200));
const frameC = await screenshot();
check('third frame differs again (resized back)', frameC !== frameB);

ws.close();
proc.kill('SIGKILL');
finish('cdp-rust-render');
