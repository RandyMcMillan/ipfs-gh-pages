// Install (or locate) a Chrome build for the CDP test suite — CI and local.
// In CI, CHROME_PATH is appended to $GITHUB_ENV and $GITHUB_OUTPUT so later
// steps inherit it; locally the export line is printed for copy-paste.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CACHE_ROOT = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
const BIN_NAMES = new Set(['chrome', 'chrome.exe', 'Google Chrome for Testing']);

export function findInstalledChrome() {
  const stack = [CACHE_ROOT];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (BIN_NAMES.has(e.name)) {
        return p;
      }
    }
  }
  return null;
}

export function installChrome() {
  execFileSync('npx', ['--yes', '@puppeteer/browsers', 'install', 'chrome@stable'], { stdio: 'inherit' });
  const bin = findInstalledChrome();
  if (!bin) throw new Error(`chrome installed but binary not found under ${CACHE_ROOT}`);
  return bin;
}

export function ensureChrome() {
  return process.env.CHROME_PATH || findInstalledChrome() || installChrome();
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const bin = ensureChrome();
  for (const f of [process.env.GITHUB_ENV, process.env.GITHUB_OUTPUT]) {
    if (f) fs.appendFileSync(f, `CHROME_PATH=${bin}\n`);
  }
  console.log(`CHROME_PATH=${bin}`);
}
