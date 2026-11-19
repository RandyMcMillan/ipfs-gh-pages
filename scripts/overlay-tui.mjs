#!/usr/bin/env node
// Overlays the prebuilt ratzilla TUI (rust-dist.zip from the action repo's
// GitHub Release) into the built site — the opt-in "terminal view"
// add-value. No-op with a clear message when the release has no archive
// yet, so a false-y/missing archive never breaks a consumer deploy.
//
// Usage: node scripts/overlay-tui.mjs <out-dir> [action-repo]
//   action-repo defaults to RandyMcMillan/ipfs-gh-pages. The caller
//   resolves the ref — this script uses github.context when available and
//   falls back to the newest published v* release.
//
// Exit codes: 0 = overlay applied OR gracefully skipped; 1 = only on a
// hard failure (network down while a release exists, corrupt zip).

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_ACTION_REPO = 'RandyMcMillan/ipfs-gh-pages';

/** Pure: resolve the ref whose rust-dist.zip we fetch. */
export function resolveRef({ env = process.env, contextSha } = {}) {
  if (env.IPFS_GH_PAGES_ACTION_REF) return env.IPFS_GH_PAGES_ACTION_REF;
  if (contextSha) return contextSha;
  return null; // caller falls back to the newest published v* release
}

/** Pure: newest v* tag of the action repo via ls-remote. */
export function newestReleaseTag(repo, env = process.env) {
  const gh = env.GITHUB_API_URL || 'https://api.github.com';
  try {
    const out = execSync(
      `git ls-remote --refs --tags --sort=-v:refname https://github.com/${repo}.git 'v*' | head -n 1`,
      { stdio: ['ignore', 'pipe', 'ignore'], env: { ...env, GIT_TERMINAL_PROMPT: '0' } }
    ).toString().trim();
    const tag = out.split('refs/tags/')[1] || '';
    void gh;
    return tag || null;
  } catch {
    return null;
  }
}

function download(repo, tag, dest) {
  const url = `https://github.com/${repo}/releases/download/${tag}/rust-dist.zip`;
  execSync(`curl -fsSL ${JSON.stringify(url)} -o ${JSON.stringify(dest)}`, {
    stdio: ['ignore', 'ignore', 'pipe']
  });
}

function unzip(zip, into) {
  fs.mkdirSync(into, { recursive: true });
  execSync(`unzip -oq ${JSON.stringify(zip)} -d ${JSON.stringify(into)}`, {
    stdio: ['ignore', 'ignore', 'pipe']
  });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const outDir = argv[0];
  const repo = argv[1] || DEFAULT_ACTION_REPO;
  if (!outDir) throw new Error('usage: overlay-tui.mjs <out-dir> [action-repo]');

  // When running inside the action repo's own checkout (a SHA context and
  // the release right here), build the archive locally — no download.
  let contextSha = null;
  try {
    const ctx = JSON.parse(fs.readFileSync(env.GITHUB_CONTEXT_PATH || '', 'utf8'));
    if (ctx?.repository === repo && ctx?.sha) contextSha = ctx.sha;
  } catch {}

  let tmp = null;
  try {
    let zipPath = null;
    if (contextSha && fs.existsSync(path.join('target', 'tui-release-dist', 'index.html'))) {
      zipPath = path.join(os.tmpdir(), 'rust-dist-local.zip');
      execSync(
        `cd ${JSON.stringify(path.resolve('target', 'tui-release-dist'))} && zip -qr ${JSON.stringify(zipPath)} .`,
        { stdio: ['ignore', 'ignore', 'pipe'] }
      );
    } else {
      const ref = resolveRef({ env, contextSha }) || newestReleaseTag(repo, env);
      if (!ref) {
        console.log('overlay-tui: no action ref and no published v* release — skipping');
        return 0;
      }
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-tui-'));
      zipPath = path.join(tmp, 'rust-dist.zip');
      try {
        download(repo, ref, zipPath);
      } catch {
        console.log(`overlay-tui: no rust-dist.zip on ${ref} (release predates the TUI archive) — skipping`);
        return 0;
      }
    }

    const stage = path.join(tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-tui-')), 'zip');
    unzip(zipPath, stage);
    // The terminal view answers at /index-rust.html.
    const src = fs.existsSync(path.join(stage, 'index-rust.html'))
      ? path.join(stage, 'index-rust.html')
      : path.join(stage, 'index.html');
    fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true });
    fs.copyFileSync(src, path.join(outDir, 'index-rust.html'));
    for (const name of fs.readdirSync(path.join(stage, 'assets'))) {
      fs.copyFileSync(path.join(stage, 'assets', name), path.join(outDir, 'assets', name));
    }
    console.log(`overlay-tui: index-rust.html + assets overlaid from ${repo}`);
    return 0;
  } finally {
    if (tmp) try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`overlay-tui: ${err.message}`);
      process.exit(1);
    }
  );
}
