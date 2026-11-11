// Emits assets/repo-files.json — the same virtual-submodule file set the
// vite plugin repoFilesPlugin embeds into the web app (vite.config.js),
// so the TUI publishes a byte-identical repo tree and root CID. Entries:
// { "<repo-relative path>": { "content": "<base64>", "size": <n> } }.
// Submodule contents are read from their working trees (uninitialized
// submodule contributes nothing), exactly like the plugin.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const out = 'assets/repo-files.json';

function git(args, cwd) {
  return execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString('utf8');
}

const files = [];
try {
  const stage = git('ls-files --stage -z', root).split('\0').filter(Boolean);
  for (const rec of stage) {
    const tab = rec.indexOf('\t');
    const mode = rec.slice(0, tab).split(' ')[0];
    const p = rec.slice(tab + 1);
    if (mode === '160000') {
      try {
        const sub = git('ls-files -z', path.join(root, p))
          .split('\0').filter(Boolean);
        for (const sf of sub) files.push(`${p}/${sf}`);
      } catch {
        // uninitialized submodule — nothing on disk
      }
    } else {
      files.push(p);
    }
  }
} catch {
  // not a git checkout — fall back to a working-tree walk
  const skip = new Set(['node_modules', '.git', 'dist', '.vite', 'target']);  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      if (skip.has(name)) continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (path.relative(root, full) !== out) files.push(path.relative(root, full));
    }
  };
  walk(root);
}

const entries = {};
for (const f of files) {
  if (f === out) continue; // never embed ourselves — unbounded growth
  const full = path.join(root, f);
  try {
    if (!fs.statSync(full).isFile()) continue;
    const buf = fs.readFileSync(full);
    entries[f] = { content: buf.toString('base64'), size: buf.length };
  } catch {}
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(entries));
try {
  const head = git('rev-parse HEAD', root).trim();
  fs.writeFileSync('assets/repo-head.txt', `${head}\n`);
} catch {}
console.log(`repo-files: ${Object.keys(entries).length} entries -> ${out}`);
