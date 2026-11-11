// Installs example.deploy.yml into the actions-test fixture:
//   example.deploy.yml -> actions-test/.github/workflows/deploy.yml
// The two files stay in lockstep — the fixture consumes the same
// self-updating workflow the README links to. Runs before CAR generation
// (npm run build) and on every release (scripts/release.mjs), so the
// submodule CAR always embeds the current example.
//
// Usage: node scripts/install-example-deploy.mjs [--check]
//   --check   exit 1 when the files differ (CI lockstep guard); no writes.
// Idempotent: identical files are left untouched (no mtime churn, so the
// submodule stays clean when nothing changed).
import fs from 'node:fs';
import path from 'node:path';

const root = process.env.REPO_ROOT ? path.resolve(process.env.REPO_ROOT) : process.cwd();
const src = path.join(root, 'example.deploy.yml');
const dest = path.join(root, 'actions-test', '.github', 'workflows', 'deploy.yml');
const checkOnly = process.argv.includes('--check');

if (!fs.existsSync(src)) {
  console.error(`install-example-deploy: source not found: ${src}`);
  process.exit(1);
}
const want = fs.readFileSync(src);
const have = fs.existsSync(dest) ? fs.readFileSync(dest) : null;

if (have && want.equals(have)) {
  console.log(`install-example-deploy: already in sync (${dest})`);
  process.exit(0);
}
if (checkOnly) {
  console.error(`install-example-deploy: ${dest} differs from ${src} — run: node scripts/install-example-deploy.mjs`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, want);
console.log(`install-example-deploy: installed ${src} -> ${dest} (${want.length} bytes)`);
