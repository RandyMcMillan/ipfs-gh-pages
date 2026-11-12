// GitHub-like markdown rendering (docs/markdown-rendering.md — decisions:
// marked+DOMPurify, inline SVG temporarily re-enabled + SVG <img>,
// rehost-first images, sanitize+CSP for repo content, sandboxed iframe
// for network content).
//
// The pipeline: marked (GFM) → DOMPurify (namespace-aware, ≥3.2.4) → DOM
// rewrite pass (repo-relative links/images resolved against the embedded
// bundle; remote images rehosted or blocked per policy). Unit-tested with
// an injectable rehoster/resolver — no DOM needed for the pure parts.

import { marked } from 'marked';
import DOMPurify from 'dompurify';

// GitHub-ish config: no scripts/handlers/style, no MathML (mXSS surface).
// TEMPORARY: inline <svg> is re-enabled through DOMPurify's default SVG
// profile (scripts, event handlers, embedders still stripped by the
// allowlist) — see docs/markdown-rendering.md. SVG images still also
// render via <img>. `align` stays (GitHub allows it). ipfs:/ipns: schemes
// stay usable.
const PURIFY_CONFIG = {
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'math', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'base', 'frame'],
  ADD_ATTR: ['align'],
  ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|ipfs|ipns):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
};

// Pure decision: what happens to a URL found in rendered markdown.
// 'embed'   — data: URL from the embedded bundle (repo-relative)
// 'rehost'  — remote http(s) image → rehost service (async swap)
// 'block'   — never emitted as a live src/href
// 'link'    — normal anchor (http(s), ipfs://, mailto…)
// 'repo'    — relative .md link → in-app blob view via onRepoLink
export function classifyUrl(raw, { mdDirPath = '' } = {}) {
  const url = String(raw || '').trim();
  if (!url) return { kind: 'block' };
  if (/^javascript:|^vbscript:|^data:/i.test(url)) return { kind: 'block' };
  if (/^ipfs:\/\//i.test(url)) return { kind: 'link' };
  if (/^https?:\/\//i.test(url)) return { kind: 'rehost' };
  if (/^mailto:|^tel:/i.test(url)) return { kind: 'link' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return { kind: 'block' }; // unknown scheme
  // repo-relative: resolve against the markdown file's directory
  const resolved = resolveRepoPath(url, mdDirPath);
  if (/\.(md|markdown)$/i.test(resolved)) return { kind: 'repo', path: resolved };
  return { kind: 'embed', path: resolved };
}

// Resolve a repo-relative reference (./x, ../x, x, /x) against the file's dir.
export function resolveRepoPath(ref, mdDirPath) {
  let path = String(ref || '').split('#')[0].split('?')[0];
  if (path.startsWith('/')) return path.slice(1);
  const base = String(mdDirPath || '').split('/').filter(Boolean);
  if (path.startsWith('./')) path = path.slice(2);
  for (const part of path.split('/')) {
    if (part === '..') base.pop();
    else if (part !== '.' && part !== '') base.push(part);
  }
  return base.join('/');
}

// marked alone (no DOM needed — node-safe).
export function renderMarked(src) {
  return marked.parse(String(src || ''), { gfm: true, breaks: true });
}

// Sanitize markdown into an HTML string. The purify impl is injectable:
// in the page it's the bundled DOMPurify; tests that have no DOM cover
// this path via CDP (the security assertions run in a real browser).
export function sanitizeMarkdownHtml(src, purify = DOMPurify) {
  return purify.sanitize(renderMarked(src), PURIFY_CONFIG);
}

// The DOM rewrite pass, run in the page on a sanitized container:
// - img[src] repo-relative → data: URL via onEmbed(path) (embedded bytes)
// - img[src] remote        → data-rehost-src + async rehost swap
// - a[href] repo-relative .md → click routes to onRepoLink(path)
// Injectable for tests: { onEmbed, rehost, onRepoLink }.
export function rewriteRendered(container, { onEmbed, rehost, onRepoLink } = {}) {
  const mdDir = container.dataset?.mdDir || '';
  for (const img of container.querySelectorAll('img[src]')) {
    const decision = classifyUrl(img.getAttribute('src'), { mdDirPath: mdDir });
    if (decision.kind === 'embed' && onEmbed) {
      const dataUrl = onEmbed(decision.path);
      if (dataUrl) img.setAttribute('src', dataUrl);
      else img.setAttribute('src', 'data:,'); // missing from bundle — inert
    } else if (decision.kind === 'rehost' && rehost) {
      img.setAttribute('data-rehost-src', img.getAttribute('src'));
      img.setAttribute('src', 'data:,');
      rehost(img.getAttribute('data-rehost-src')).then((out) => {
        if (out && out.src) img.setAttribute('src', out.src);
        else img.setAttribute('alt', `${img.getAttribute('alt') || 'image'} (rehost failed — blocked)`);
      });
    } else if (decision.kind === 'block') {
      img.setAttribute('src', 'data:,');
    }
  }
  for (const a of container.querySelectorAll('a[href]')) {
    const decision = classifyUrl(a.getAttribute('href'), { mdDirPath: mdDir });
    if (decision.kind === 'repo' && onRepoLink) {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        onRepoLink(decision.path);
      });
    } else if (decision.kind === 'block') {
      a.removeAttribute('href');
    }
    // 'link' and 'rehost' hrefs pass through (sanitized schemes only)
  }
  return container;
}

// The sandboxed-iframe variant for NETWORK content (issue notes, fetched
// docs): sanitized HTML in an iframe with sandbox="" (no origin access)
// + allow-popups so links still work. Scripts cannot run there even if
// sanitization missed something.
export function sandboxedFrame(sanitizedHtml, { title = 'rendered content' } = {}) {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-popups');
  frame.title = title;
  frame.style.cssText = 'width:100%;border:1px solid var(--color-border-muted,#d0d7de);border-radius:6px;';
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;line-height:1.5;margin:0.75rem;color:#1f2328;word-wrap:break-word}
    pre{background:#f6f8fa;padding:0.6rem;border-radius:6px;overflow-x:auto}
    code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.9em}
    img{max-width:100%}
    table{border-collapse:collapse}td,th{border:1px solid #d0d7de;padding:0.25rem 0.6rem}
    blockquote{border-left:3px solid #d0d7de;margin:0;padding-left 0.75rem;color:#57606a}
  </style></head><body>${sanitizedHtml}</body></html>`;
  return frame;
}
