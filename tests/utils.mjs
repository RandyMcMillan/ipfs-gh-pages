import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

export const isVerbose = process.env.VERBOSE === '1' || process.env.VERBOSE === 'true';
export const testUrl = process.env.TEST_URL || 'http://127.0.0.1:5173';

export function vlog(...args) {
  if (isVerbose) console.log('[verbose]', ...args);
}

export function tmpDir(name) {
  return path.join(os.tmpdir(), name);
}

export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [];
  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    );
  } else if (process.platform === 'win32') {
    candidates.push(
      'C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe',
      'C:\\\\Program Files (x86)\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe'
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser'
    );
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return candidates[0];
}

let failures = 0;

export function check(label, ok, detail = '') {
  if (ok) {
    console.log(`PASS: ${label}`);
  } else {
    failures++;
    console.log(`FAIL: ${label}${detail ? ' — ' + detail : ''}`);
  }
}

export function finish(testName) {
  if (failures > 0) {
    console.log(`${testName}: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log(`${testName}: all checks passed`);
  process.exit(0);
}

export async function waitForDebugger(port, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
      const page = targets.find((t) => t.type === 'page');
      if (page) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Chrome DevTools endpoint not reachable on port ${port}`);
}

// Launch Chrome for a CDP test with stderr captured, so a launch failure
// (missing shared libraries, arch mismatch, sandbox errors) prints the
// actual error instead of surfacing as a silent endpoint timeout.
export async function launchChrome(port, extraArgs = []) {
  const chrome = findChrome();
  vlog('Using Chrome:', chrome);
  let errBuf = '';
  const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${port}`, ...extraArgs], {
    stdio: ['ignore', 'ignore', 'pipe']
  });
  proc.stderr.on('data', (d) => {
    errBuf += d;
    if (errBuf.length > 4000) errBuf = errBuf.slice(-4000);
  });
  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[chrome:${port}] exited early (code ${code}): ${errBuf.trim()}`);
    }
  });
  try {
    const page = await waitForDebugger(port);
    return { proc, page, chrome };
  } catch (err) {
    console.error(`[chrome:${port}] ${err.message}\nchrome stderr:\n${errBuf.trim() || '(none)'}`);
    try { proc.kill('SIGKILL'); } catch {}
    throw err;
  }
}
