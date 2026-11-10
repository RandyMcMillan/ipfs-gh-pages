import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

function repoFilesPlugin() {
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
        const out = execSync('git ls-files -z', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
        files = out.toString('utf8').split('\0').filter(Boolean);
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
  return { owner: owner || 'gnostr', name: name || 'gnostr-repo', version };
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
      const { owner, name, version } = resolveIdentity(root);
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
      return `export default { owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}, version: ${JSON.stringify(version)}, lastCommitMsg: ${JSON.stringify(lastCommitMsg)}, lastCommitTime: ${JSON.stringify(lastCommitTime)}, shortSha: ${JSON.stringify(shortSha)}, commitCount: ${JSON.stringify(commitCount)} };`;
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

export default defineConfig({
  // Base relative path ensures assets resolve correctly on GitHub Pages
  base: './',
  plugins: [repoFilesPlugin(), repoIdentityPlugin()],
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