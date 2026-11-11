// The one e2e test flow used by CI, the published action, and local runs:
// ensure Chrome (CHROME_PATH), start the dev server unless TEST_URL points
// elsewhere, run the full suite, tear down. Suites run as individual
// spawns with per-suite timeouts so a wedged suite fails WITH ITS NAME in
// the log (the old single-chain run only died at the global watchdog —
// exit 124, no evidence). A server already answering on the port is
// reused, not replaced. The global timeout remains as a backstop above
// the sum of every suite's bounded waits.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { ensureChrome } from './ci-chrome.mjs';

const HOST = process.env.E2E_HOST || '127.0.0.1';
const PORT = Number(process.env.E2E_PORT || 5173);
const BASE = `http://${HOST}:${PORT}`;
const READY_TIMEOUT_MS = Number(process.env.E2E_READY_TIMEOUT_MS || 60000);
const GLOBAL_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 35 * 60 * 1000);
const UNIT_TIMEOUT_MS = Number(process.env.E2E_UNIT_TIMEOUT_MS || 3 * 60 * 1000);
// 12 min: multi-browser tests (cdp-share-link boots three Chromes and has
// 120s of negative-path waits) legitimately run long on loaded machines —
// the timeout exists to catch wedges, not slow progress.
const CDP_TIMEOUT_MS = Number(process.env.E2E_CDP_TIMEOUT_MS || 12 * 60 * 1000);

// The suite list mirrors package.json's test:all — parsed from it, never
// duplicated, so the two can never drift.
const PKG = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
const SUITES = PKG.scripts['test:all'].split('&&').map((s) => s.trim()).filter(Boolean);

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

function runSuite(cmd, timeoutMs) {
  return new Promise((resolve) => {
    console.log(`[test:ci] suite start (max ${Math.round(timeoutMs / 1000)}s): ${cmd}`);
    const child = spawn(cmd, { shell: true, stdio: 'inherit', detached: true, env });
    const timer = setTimeout(() => {
      console.error(`[test:ci] SUITE TIMED OUT after ${timeoutMs}ms — killing: ${cmd}`);
      killTree(child.pid);
      resolve(124);
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

const watchdog = setTimeout(() => {
  console.error(`[test:ci] global timeout ${GLOBAL_TIMEOUT_MS}ms exceeded — killing the suite`);
  if (serverProc && !serverReused) killTree(serverProc.pid);
  process.exit(124);
}, GLOBAL_TIMEOUT_MS);

let exitCode = 0;
for (const cmd of SUITES) {
  const timeoutMs = cmd.includes('cdp-') ? CDP_TIMEOUT_MS : UNIT_TIMEOUT_MS;
  const code = await runSuite(cmd, timeoutMs);
  if (code !== 0) {
    exitCode = code;
    break;
  }
}
clearTimeout(watchdog);
if (serverProc && !serverReused) killTree(serverProc.pid);
process.exit(exitCode);
