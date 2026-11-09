// Release procedure: version bump, commit, tag, and keep the actions-test
// submodule's tags in lockstep with ours.
// Usage: npm run release <version>   (e.g. npm run release 1.6.38)
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Usage: node scripts/release.mjs <semver>');
  process.exit(1);
}
const tag = `v${version}`;
const run = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

if (run('git status --porcelain')) {
  console.error('Working tree is not clean — commit or stash pending changes first.');
  process.exit(1);
}

// Version bump + README action reference.
run(`npm version ${version} --no-git-tag-version`);
const readme = fs.readFileSync('README.md', 'utf8');
fs.writeFileSync('README.md', readme.replace(/ipfs-gh-pages@v[\d.]+/g, `ipfs-gh-pages@${tag}`));

run('git add -A');
run(`git commit -m "Release ${tag}"`);
run(`git tag ${tag}`);

// Lockstep: tag the actions-test submodule at the exact commit the
// superproject's gitlink records, and push that tag to its own origin.
try {
  const sub = 'actions-test';
  if (fs.existsSync(`${sub}/.git`)) {
    const sha = run(`git -C ${sub} rev-parse HEAD`);
    const remoteHas = (() => {
      try {
        return run(`git -C ${sub} ls-remote --tags origin ${tag}`).length > 0;
      } catch { return false; }
    })();
    if (!run(`git -C ${sub} tag -l ${tag}`).includes(tag)) {
      run(`git -C ${sub} tag ${tag}`);
    }
    if (!remoteHas) {
      run(`git -C ${sub} push origin ${tag}`);
    }
    console.log(`${sub} @ ${sha.slice(0, 10)} is tagged ${tag} (lockstep)`);
  }
} catch (e) {
  console.warn(`submodule lockstep skipped: ${e.message}`);
}

run('git push origin main');
run(`git push origin ${tag}`);
console.log(`Released ${tag}`);
