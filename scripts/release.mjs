// Release procedure: version bump, commit, tag, and keep the actions-test
// submodule's tags in lockstep with ours — including installing the repo's
// own .github/workflows/deploy-gh-pages.yml (the single deploy workflow
// this repo and consumers share) as the fixture's deploy.yml, so the
// fixture always consumes the newest release (it auto-detects the newest
// v* tag).
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

// The fixture's deploy.yml IS the repo's own deploy workflow (lockstep). It
// auto-detects the newest v* tag at run time — which is the release being
// cut once the tag below is pushed — so no SHA pinning is needed. Refresh
// it before the lockstep flow commits the submodule.
try {
  run('node scripts/install-consumer-example.mjs');
} catch (e) {
  console.warn(`deploy-gh-pages.yml install skipped: ${e.message}`);
}

// Lockstep: commit any pending changes inside the actions-test submodule,
// push its branch, then tag it at the exact commit the superproject's
// gitlink records and push that tag — on every release.
try {
  const sub = 'actions-test';
  if (fs.existsSync(`${sub}/.git`)) {
    const dirty = run(`git -C ${sub} status --porcelain`);
    if (dirty) {
      run(`git -C ${sub} add -A`);
      run(`git -C ${sub} commit -m "release ${tag} (lockstep)"`);
    }
    const branch = run(`git -C ${sub} rev-parse --abbrev-ref HEAD`);
    const sha = run(`git -C ${sub} rev-parse HEAD`);
    const subPush = (ref) => {
      try {
        run(`git -C ${sub} push origin ${ref}`);
      } catch {
        // OAuth tokens can't push workflow-file changes (deploy.yml
        // lockstep install); an SSH remote bypasses that — use it when
        // configured.
        run(`git -C ${sub} push origin-ssh ${ref}`);
      }
    };
    if (dirty || run(`git -C ${sub} rev-parse HEAD`) !== (() => { try { return run(`git -C ${sub} rev-parse origin/${branch}`); } catch { return ''; } })()) {
      subPush(branch);
    }
    const remoteHas = (() => {
      try {
        return run(`git -C ${sub} ls-remote --tags origin ${tag}`).length > 0;
      } catch { return false; }
    })();
    if (!run(`git -C ${sub} tag -l ${tag}`).includes(tag)) {
      run(`git -C ${sub} tag ${tag}`);
    }
    if (!remoteHas) {
      subPush(tag);
    }
    // If the submodule moved, bump the superproject gitlink.
    if (dirty) {
      run(`git add ${sub}`);
      run(`git commit -m "${sub}: update ${sub}@${sha}"`);
    }
    console.log(`${sub} @ ${sha.slice(0, 10)} committed+pushed, tagged ${tag} (lockstep)`);
  }
} catch (e) {
  console.warn(`submodule lockstep skipped: ${e.message}`);
}

// PUSH ORDER IS CRITICAL (AGENTS.md "Push order"): every gitlink this
// superproject records must already resolve on the submodule's remote — a
// gitlink pointing at an unpushed submodule commit breaks every
// `submodules: recursive` checkout of main (CI: "upload-pack: not our
// ref"). The lockstep flow above pushed the submodule branch + tag first;
// verify before the superproject goes out.
run('node scripts/check-gitlink.mjs');

run('git push origin main');
run(`git push origin ${tag}`);
console.log(`Released ${tag}`);
