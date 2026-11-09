// The one e2e test flow used by CI, the published action, and local runs:
// ensure Chrome (CHROME_PATH), start the dev server unless TEST_URL points
// elsewhere, run the full suite, tear down. A global timeout turns a wedged
// suite into a failure instead of a hung job. A server already answering on
// the port is reused, not replaced. The global timeout is a backstop above
// the sum of every suite's bounded waits (~18 min worst case): healthy cold
// CI runs take well under it, and a true hang (previously 55+ min) is caught.
import { spawn } from 'node:child_process';
import { ensureChrome } from './ci-chrome.mjs';

const HOST = process.env.E2E_HOST || '127.0.0.1';
const PORT = Number(process.env.E2E_PORT || 5173);
const BASE = `http://${HOST}:${PORT}`;
const READY_TIMEOUT_MS = Number(process.env.E2E_READY_TIMEOUT_MS || 60000);
const GLOBAL_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 20 * 60 * 1000);

function killTree(pid) {
  try { process.kill(-pid, 'SIGKILL'); } catch {}
}

async function ready(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

const chromePath = process.env.CHROME_PATH || ensureChrome();
console.log(`[test:ci] CHROME_PATH=${chromePath}`);

let serverProc = null;
let serverReused = false;
if (!process.env.TEST_URL) {
  if (await ready(BASE, 3000)) {
    serverReused = true;
    console.log(`[test:ci] reusing dev server already on ${BASE}`);
  } else {
    serverProc = spawn('npm', ['run', 'dev', '--', '--host', HOST, '--port', String(PORT)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    });
    serverProc.stdout.on('data', (d) => process.stdout.write(`[dev] ${d}`));
    serverProc.stderr.on('data', (d) => process.stderr.write(`[dev] ${d}`));
    serverProc.on('exit', (code) => console.log(`[test:ci] dev server exited (code ${code})`));
    if (!(await ready(BASE, READY_TIMEOUT_MS))) {
      console.error(`[test:ci] dev server not ready on ${BASE} after ${READY_TIMEOUT_MS}ms`);
      if (serverProc) killTree(serverProc.pid);
      process.exit(1);
    }
  }
}

const env = { ...process.env, CHROME_PATH: chromePath };
if (!env.TEST_URL) env.TEST_URL = BASE;

const tests = spawn('npm', ['run', 'test:all'], { stdio: 'inherit', detached: true, env });
const watchdog = setTimeout(() => {
  console.error(`[test:ci] global timeout ${GLOBAL_TIMEOUT_MS}ms exceeded — killing the suite`);
  killTree(tests.pid);
  if (serverProc && !serverReused) killTree(serverProc.pid);
  process.exit(124);
}, GLOBAL_TIMEOUT_MS);

tests.on('exit', (code) => {
  clearTimeout(watchdog);
  if (serverProc && !serverReused) killTree(serverProc.pid);
  process.exit(code ?? 1);
});
