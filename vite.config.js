import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { listRepoFiles, repoByteTotal, EMBED_THRESHOLD_BYTES } from './scripts/lib/repo-files.mjs';

function repoFilesPlugin() {
  // Repo file source — dual mode so the action handles ANY repo size:
  //
  //   'embedded' (total bytes <= EMBED_THRESHOLD_BYTES): file contents are
  //     base64-inlined into the bundle via virtual:repo-files. Fully
  //     static, zero fetches, historical behavior.
  //
  //   'car' (larger repos): contents stay OUT of the bundle. The app reads
  //     paths + CIDs from dist/repo-manifest.json and fetches bytes from
  //     dist/repo.car on demand, both written by scripts/build-car.mjs
  //     (which consults the same threshold). Without this, `vite build`
  //     memory grows with repo bytes and multi-GB checkouts (e.g. gnostr
  //     with recursive submodules) die on the default V8 heap long before
  //     the deploy step.
  //
  // The file set (virtual submodule support) is exactly what
  // scripts/lib/repo-files.mjs documents: superproject tracked files plus
  // each checked-out submodule's files flattened as "<sub>/<file>".
  const filesVirtualId = 'virtual:repo-files';
  const modeVirtualId = 'virtual:repo-mode';
  const filesResolvedId = '\0' + filesVirtualId;
  const modeResolvedId = '\0' + modeVirtualId;
  let mode = null;
  const repoRoot = () => process.env.REPO_ROOT ? path.resolve(process.env.REPO_ROOT) : process.cwd();
  const repoMode = () => {
    if (mode == null) {
      mode = repoByteTotal(repoRoot()) > EMBED_THRESHOLD_BYTES ? 'car' : 'embedded';
    }
    return mode;
  };
  return {
    name: 'repo-files',
    resolveId(id) {
      if (id === filesVirtualId) return filesResolvedId;
      if (id === modeVirtualId) return modeResolvedId;
    },
    load(id) {
      if (id === modeResolvedId) return `export default ${JSON.stringify(repoMode())};`;
      if (id !== filesResolvedId) return;
      const root = repoRoot();
      if (repoMode() === 'car') {
        return 'export default {};';
      }
      const entries = [];
      for (const { path: p, full } of listRepoFiles(root)) {
        const buf = fs.readFileSync(full);
        entries.push(`${JSON.stringify(p)}: ${JSON.stringify(buf.toString('base64'))}`);
      }
      return `export default { ${entries.join(',\n')} };`;
    }
  };
}

function resolveIdentity(root) {
  let owner = process.env.GITHUB_REPOSITORY_OWNER || '';
  let name = (process.env.GITHUB_REPOSITORY || '').split('/')[1] || '';
  let version = process.env.npm_package_version || '';
  if (!name || !version) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      version = version || pkg.version || '';
    } catch {}
  }
  if (!owner || !name) {
    try {
      const remote = execSync('git config --get remote.origin.url', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      const m = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
      if (m) {
        owner = owner || m[1];
        name = name || m[2];
      }
    } catch {}
  }
  // The repo's latest TAG is what the header "latest release" chip shows —
  // `version` above is the ACTION's/package version (the Actions panel's
  // "Built as v…"), which for consumer repos is not their release line.
  // Consumer checkouts must fetch tags (the shared deploy-gh-pages.yml has
  // a step that fetches just the newest tag); REPO_TAG_VERSION overrides
  // without git.
  let tagVersion = process.env.REPO_TAG_VERSION || '';
  if (!tagVersion) {
    try {
      tagVersion = execSync('git describe --tags --abbrev=0', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim().replace(/^v(?=\d)/, '');
    } catch {}
  }
  return { owner: owner || 'gnostr', name: name || 'gnostr-repo', version, tagVersion };
}

function repoIdentityPlugin() {
  const virtualId = 'virtual:repo-identity';
  const resolvedId = '\0' + virtualId;
  return {
    name: 'repo-identity',
    resolveId(id) {
      if (id === virtualId) return resolvedId;
    },
    load(id) {
      if (id !== resolvedId) return;
      const root = process.env.REPO_ROOT ? path.resolve(process.env.REPO_ROOT) : process.cwd();
      const { owner, name, version, tagVersion } = resolveIdentity(root);
      let lastCommitMsg = '';
      let lastCommitTime = '';
      let shortSha = '';
      let commitCount = '';
      try {
        lastCommitMsg = execSync('git log -1 --pretty=%s', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        lastCommitTime = execSync('git log -1 --pretty=%cI', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        shortSha = execSync('git log -1 --pretty=%h', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        const n = parseInt(execSync('git rev-list --count HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(), 10);
        if (n > 1) commitCount = String(n);
      } catch {}
      return `export default { owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}, version: ${JSON.stringify(version)}, tagVersion: ${JSON.stringify(tagVersion)}, lastCommitMsg: ${JSON.stringify(lastCommitMsg)}, lastCommitTime: ${JSON.stringify(lastCommitTime)}, shortSha: ${JSON.stringify(shortSha)}, commitCount: ${JSON.stringify(commitCount)} };`;
    },
    transformIndexHtml(html) {
      const root = process.env.REPO_ROOT ? path.resolve(process.env.REPO_ROOT) : process.cwd();
      const { owner, name } = resolveIdentity(root);
      // The template ships owner-neutral; the built page carries whoever's
      // repo it is (GITHUB_REPOSITORY, else the git remote, else the gnostr
      // fallback that main.js also uses at runtime).
      return html
        .replaceAll('__REPO_OWNER__', owner)
        .replaceAll('__REPO_NAME__', name);
    }
  };
}

function repoSubmodulesPlugin() {
  // Bakes which paths are submodules, at which commit, from which remote —
  // the file tree renders these like GitHub: a submodule row with its
  // gitlink commit, distinct from a plain directory. Contents are still
  // embedded by repoFilesPlugin (see its "virtual submodule support" block);
  // this module only carries the presentation metadata that working-tree
  // files alone can't tell the app (the gitlink SHA is not on disk).
  const virtualId = 'virtual:repo-submodules';
  const resolvedId = '\0' + virtualId;
  return {
    name: 'repo-submodules',
    resolveId(id) {
      if (id === virtualId) return resolvedId;
    },
    load(id) {
      if (id !== resolvedId) return;
      const root = process.env.REPO_ROOT ? path.resolve(process.env.REPO_ROOT) : process.cwd();
      const subs = {};
      let paths = [];
      try {
        const out = execSync('git config --file .gitmodules --get-regexp submodule\\..*\\.path', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        paths = out.split('\n').filter(Boolean).map((l) => l.split(' ').pop().trim())
          .filter((p) => fs.existsSync(path.join(root, p, '.git')));
      } catch {}
      for (const p of paths) {
        try {
          const sha = execSync('git rev-parse HEAD', { cwd: path.join(root, p), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
          let url = '';
          try {
            url = execSync('git config --get remote.origin.url', { cwd: path.join(root, p), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
          } catch {}
          url = url.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '');
          subs[p] = { sha, url };
        } catch {}
      }
      return `export default ${JSON.stringify(subs)};`;
    }
  };
}

export default defineConfig({
  // Base relative path ensures assets resolve correctly on GitHub Pages
  base: './',
  plugins: [repoFilesPlugin(), repoSubmodulesPlugin(), repoIdentityPlugin()],
  build: {
    target: 'esnext',
    // The GitHub Action sets OUT_DIR so the bundle lands where the caller asked.
    outDir: process.env.OUT_DIR,
    emptyOutDir: Boolean(process.env.OUT_DIR)
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext'
    }
  }
});