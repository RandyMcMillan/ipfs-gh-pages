// Shared repo file listing. The bundle (vite.config.js repoFilesPlugin),
// the CAR builder (scripts/build-car.mjs), and repo-manifest.json MUST agree
// on the file set, so the walk lives here once.
//
// Semantics (mirrors the "Virtual submodule support" block in vite.config.js):
// superproject tracked files, plus — for each checked-out submodule (gitlink
// mode 160000) — its tracked files flattened as "<submodule>/<file>".
// An uninitialized submodule contributes zero entries. Falls back to a
// directory walk when git is unavailable. Working-tree files only; nothing
// is read from git object databases.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

export function* listRepoFiles(root) {
  let records = [];
  let usedGit = true;
  try {
    const stage = execSync('git ls-files --stage -z', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8').split('\0').filter(Boolean);
    for (const rec of stage) {
      const tab = rec.indexOf('\t');
      const mode = rec.slice(0, tab).split(' ')[0];
      const p = rec.slice(tab + 1);
      if (mode === '160000') {
        try {
          const sub = execSync('git ls-files -z', { cwd: path.join(root, p), stdio: ['ignore', 'pipe', 'ignore'] })
            .toString('utf8').split('\0').filter(Boolean);
          for (const sf of sub) records.push(`${p}/${sf}`);
        } catch {
          // Uninitialized submodule — nothing on disk to list.
        }
      } else {
        records.push(p);
      }
    }
  } catch {
    usedGit = false;
  }
  if (!usedGit) {
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        if (name === 'node_modules' || name === '.git' || name === 'dist' || name === '.vite') continue;
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) walk(full);
        else records.push(path.relative(root, full));
      }
    };
    walk(root);
  }
  for (const p of records) {
    const full = path.join(root, p);
    try {
      if (fs.statSync(full).isFile()) yield { path: p, full };
    } catch {
      // Broken symlink / raced deletion — skip.
    }
  }
}

// Repos at or under this total byte size embed file contents directly in
// the bundle (zero fetches, fully static). Larger repos ship
// dist/repo-manifest.json + dist/repo.car and the app fetches bytes on
// demand. vite.config.js (bundle side) and scripts/build-car.mjs (artifact
// side) both consult this constant — keep them on the same threshold.
export const EMBED_THRESHOLD_BYTES = 20 * 1024 * 1024;

// Total bytes of every file listRepoFiles would yield.
export function repoByteTotal(root) {
  let total = 0;
  for (const { full } of listRepoFiles(root)) total += fs.statSync(full).size;
  return total;
}

// Superproject tracked files only (no submodule recursion). This is the
// historical main-CAR file set: submodule content ships in per-submodule
// CARs, and the virtual-flattened set is the manifest's job.
export function listTrackedFiles(dir) {
  let files = [];
  try {
    const out = execSync('git ls-files -z', { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
    files = out.toString('utf8').split('\0').filter(Boolean);
  } catch {
    const walk = (d) => {
      for (const name of fs.readdirSync(d)) {
        if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
        const full = path.join(d, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) walk(full);
        else files.push(path.relative(d, full));
      }
    };
    walk(dir);
  }
  return files.filter((f) => {
    try { return fs.statSync(path.join(dir, f)).isFile(); } catch { return false; }
  });
}
