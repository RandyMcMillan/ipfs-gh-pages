# Markdown rendering like GitHub — plan and security concern

Status: CONCERN DOCUMENTED, decision pending. Do not implement the
renderer until the open decisions at the bottom are made.

## Why

The app replicates the GitHub repo view; the README card is core to it
(design objective 2). Today `miniMd` (main.js) renders a hand-rolled,
HTML-escaping subset: h1–h4, fenced code, inline code, bold, images,
links, flat bullet lists. Real-world READMEs (e.g. agregore-browser's)
already break it: HTML layout blocks (`<p align="center">`) show as
literal text, relative images (`./build/icon.png`) 404 against the Pages
origin, and tables/task lists/strikethrough don't exist.

## Planned approach (not yet approved)

Replace `miniMd` with `marked` (GFM: tables, task lists, strikethrough,
autolinks) + `DOMPurify` (GitHub-style sanitization), behind one wrapper
(`js/markdown.js`: render → sanitize → rewrite repo-relative links and
images into the embedded file set — the part gateways can't do). The same
renderer then serves the README card, `.md` blobs (rendered + Raw
toggle), issue bodies/comments, and the wiki panel.

## The security concern

Rendered markdown is the classic stored-XSS vehicle. "Like GitHub" means
allowing sanitized HTML blocks — the moment raw HTML renders,
sanitization is the only barrier between an attacker and script execution
in our origin. Inputs are genuinely untrusted:

- **The README itself** — whatever repo the app is deployed for,
  including a malicious fork's.
- **Issues/comments from the network** — signed, but signatures prove
  authorship, not safety. Any peer can sign a note carrying
  `<img onerror=…>`. Verification is identity, not moderation.
- **Fetched CIDs** — arbitrary network content.

### Blast radius specific to this app (same-origin script gets)

- `localStorage` → the Ed25519 **IPNS private keys**
  (`ipns-branch-key:<repo>`, `ipns-index-key:<repo>`): sign fraudulent
  notes, repoint the branch/index names at malicious roots.
- The **Kubo RPC bridge**: a configured Kubo at `127.0.0.1:5001` (our
  settings panel tells users to open CORS `*`) exposes the full Kubo API
  to injected JS — add/pin/remove content, read the node's repo. Near-
  total compromise of the host's node.
- **Pinning-service tokens** (`remote-pin-config`) — exfiltratable.
- The in-page Helia node: dial peers, announce bogus CIDs, poison
  gossip.

### Mitigation stack (part of "like GitHub", not optional)

1. **DOMPurify after marked**, GitHub-style config — strip scripts,
   event handlers, `style`; keep the safe whitelist (incl. `align`).
   Never `innerHTML` raw marked output.
2. **URL scheme filtering** — `javascript:`, `data:` (except possibly
   images), `vbscript:` blocked in hrefs/srcs.
3. **CSP meta tag** (works on GitHub Pages): `script-src 'self'` kills
   injected scripts and inline handlers even if sanitization misses.
   Prerequisite: remove the few inline `onclick=` attributes in
   index.html (the delegated-listener idiom already covers them).
4. **Image policy** — remote `<img>` is a tracking pixel: leaks viewer
   IP, page URL, timing. GitHub runs camo for this reason. Options:
   block remote images by default / proxy them (no camo exists here;
   could route via a gateway) / accept + document. DECISION NEEDED.
5. `rel="noopener"` + `target="_blank"` on rendered links (tabnabbing).
6. **Optional hard isolation**: render network-supplied content (issue
   notes, fetched docs) in `<iframe sandbox="">` without
   `allow-same-origin` — zero origin access. Costs: primer CSS injected
   into the frame, `allow-popups` for links. DECISION NEEDED.

## Open decisions (make these, then implement)

1. Image policy: block-by-default, gateway-proxied, or accepted leak?
2. Sandboxed iframe for network-supplied content, or sanitize + CSP only?
3. CSP meta now (requires de-inlining the `onclick=` handlers), or with
   the renderer?
4. Bundle budget approval: `marked` + `dompurify` ≈ 60 kB minified
   (noise next to Helia, but they are new runtime deps — the project
   currently renders with zero markdown deps).

## Verification plan (when approved)

- Unit: `js/markdown.js` — GFM constructs (tables, task lists,
  strikethrough), sanitization (script/onerror/style stripped, align
  kept), scheme filtering, repo-relative image/link rewriting.
- CDP: README card renders an agregore-style README (HTML block +
  relative image + table); an `<img onerror>` probe in an issue body
  does not execute.
