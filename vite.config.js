import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

function repoFilesPlugin() {
  // Virtual submodule support
  // -------------------------
  // `git ls-files` lists a checked-out submodule as a single gitlink (a bare
  // path with no content), which is why the app historically embedded nothing
  // under e.g. actions-test/. This plugin instead runs `git ls-files --stage
  // -z`, where gitlinks appear with mode 160000, and recurses into each with
  // `git -C <path> ls-files -z` against the submodule's working tree. Every
  // file found is emitted as "<submodule path>/<file>", so:
  //
  //   - the Files tab renders the submodule folder like any other tree,
  //   - main.js feeds these entries to heliaUnixfs.addAll(), so the Clone
  //     bar root CID — and Download CAR / `ipfs dag import` on Kubo — covers
  //     the whole repository including submodule contents, and
  //   - a consumer fork's build embeds whatever ITS submodule checkout
  //     contains at that moment.
  //
  // Nothing is read from git object databases — only working-tree files.
  // That is what makes the support "virtual": the IPFS tree mirrors the
  // checkout, not the git history (no submodule SHA pinning in the DAG; a
  // rebuild embeds whatever is currently checked out). An uninitialized
  // submodule contributes zero entries instead of failing the build.
  //
  // Relationship to scripts/build-car.mjs: that script separately writes one
  // <name>.car per submodule next to the main CAR. Those files are a
  // transport convenience for `ipfs dag import`; they are NOT what the app
  // embeds — the bundle's file set comes only from this plugin. Because
  // `npm run build` runs vite before build-car, the bundle may carry the
  // previous build's submodule .car file; the freshly written ones on disk
  // (and in the Pages-deployed dist) are always current.
  const virtualId = 'virtual:repo-files';
  const resolvedId = '\0' + virtualId;
  return {
    name: 'repo-files',
    resolveId(id) {
      if (id === virtualId) return resolvedId;
    },
    load(id) {
      if (id !== resolvedId) return;
      const root = process.env.REPO_ROOT ? path.resolve(process.env.REPO_ROOT) : process.cwd();
      let files = [];
      try {
        const stage = execSync('git ls-files --stage -z', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
          .toString('utf8').split('\0').filter(Boolean);
        for (const rec of stage) {
          const tab = rec.indexOf('\t');
          const mode = rec.slice(0, tab).split(' ')[0];
          const p = rec.slice(tab + 1);
          if (mode === '160000') {
            // Gitlink — a checked-out submodule. See the block comment above
            // for how virtual submodule support works.
            try {
              const sub = execSync('git ls-files -z', { cwd: path.join(root, p), stdio: ['ignore', 'pipe', 'ignore'] })
                .toString('utf8').split('\0').filter(Boolean);
              for (const sf of sub) files.push(`${p}/${sf}`);
            } catch {
              // Uninitialized submodule — nothing on disk to embed.
            }
          } else {
            files.push(p);
          }
        }
      } catch (e) {
        const walk = (dir) => {
          for (const name of fs.readdirSync(dir)) {
            if (name === 'node_modules' || name === '.git' || name === 'dist' || name === '.vite') continue;
            const full = path.join(dir, name);
            const st = fs.statSync(full);
            if (st.isDirectory()) walk(full);
            else files.push(path.relative(root, full));
          }
        };
        walk(root);
      }
      const entries = files
        .filter((f) => {
          try { return fs.statSync(path.join(root, f)).isFile(); } catch { return false; }
        })
        .map((f) => {
          const full = path.join(root, f);
          const buf = fs.readFileSync(full);
          return `${JSON.stringify(f)}: ${JSON.stringify(buf.toString('base64'))}`;
        });
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
  // Consumer checkouts must fetch tags (example.deploy.yml has a step that
  // fetches just the newest tag); REPO_TAG_VERSION overrides without git.
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