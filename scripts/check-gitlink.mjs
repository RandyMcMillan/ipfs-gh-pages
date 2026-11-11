// Push-order guard (AGENTS.md "Push order"): every gitlink the
// superproject records must resolve on the submodule's remote BEFORE the
// superproject commit referencing it is pushed. A gitlink pointing at an
// unpushed submodule commit breaks every `submodules: recursive` checkout
// of that ref — CI dies with "upload-pack: not our ref <sha>" inside
// actions/checkout, far from the cause.
//
// Works on a bare superproject checkout (no submodules initialized): the
// gitlink comes from the index, the URL from .gitmodules, and the remote
// is probed directly. When the submodule IS initialized, its local repo is
// used (same probe, no temp dir).
//
// Usage: node scripts/check-gitlink.mjs [superprojectDir]
// Exit 0 = every recorded gitlink exists on its remote; 1 = at least one
// does not (remediation is printed, full SHAs, never truncated).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const run = (cmd, cwd) =>
  execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();

// Recorded gitlinks: mode 160000 entries of `git ls-files -s`.
const links = run('git ls-files -s', root)
  .split('\n')
  .filter((l) => l.startsWith('160000'))
  .map((l) => {
    const [, sha, , subPath] = l.split(/\s+/);
    return { sha, subPath };
  });

if (links.length === 0) {
  console.log('check-gitlink: no submodules recorded');
  process.exit(0);
}

// path -> url from .gitmodules.
const urlByPath = new Map();
try {
  const cfg = run('git config -f .gitmodules --get-regexp "submodule\\..*\\.(path|url)"', root);
  const nameByPath = new Map();
  for (const line of cfg.split('\n')) {
    const m = line.match(/^submodule\.(.+)\.(path|url)\s+(.+)$/);
    if (!m) continue;
    const [, name, key, value] = m;
    if (key === 'path') nameByPath.set(value, name);
    else urlByPath.set(nameByPath.get(name) || name, value);
  }
} catch { /* no .gitmodules — fall through to per-submodule errors */ }

// Does the remote at `url` (or the initialized repo at `sub`) have `sha`?
// Fast path: sha is a ref tip. Probe: fetch the exact sha — the server
// answers "not our ref" precisely when CI's direct fetch would fail.
function remoteHas(subDir, url, sha) {
  try {
    const tips = run(`git ls-remote ${url}`, subDir || root);
    if (tips.split('\n').some((l) => l.split('\t')[0] === sha)) return true;
  } catch { /* ls-remote failed — the probe below reports the real error */ }
  const probe = subDir || fs.mkdtempSync(path.join(os.tmpdir(), 'check-gitlink-'));
  try {
    run(`git fetch --depth 1 ${url} ${sha}`, probe);
    return true;
  } catch (e) {
    return String(e.stderr || e.message);
  } finally {
    if (!subDir) fs.rmSync(probe, { recursive: true, force: true });
  }
}

let failed = 0;
for (const { sha, subPath } of links) {
  const subDir = path.join(root, subPath);
  const initialized = fs.existsSync(path.join(subDir, '.git'));
  const url = urlByPath.get(subPath) || subPath;
  const res = remoteHas(initialized ? subDir : null, url, sha);
  if (res === true) {
    console.log(`check-gitlink: ${subPath} @ ${sha} resolves on its remote`);
    continue;
  }
  failed = 1;
  console.error(
    `check-gitlink: ${subPath} records ${sha}, which its remote does not have.\n` +
    'Push order (AGENTS.md): the submodule FIRST, then the superproject:\n' +
    `\n` +
    `git -C ${subPath} push origin master\n` +
    `\n` +
    '(use origin-ssh when the pending submodule changes touch workflow files).\n' +
    `Probe error: ${res}`
  );
}
process.exit(failed);
