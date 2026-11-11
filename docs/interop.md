# Interop: GitHub Pages app ↔ local npm dev ↔ rust app

How the three surfaces share state, what already works, and what needs
building. Surfaces:

- **Pages**: the vite app (main.js) deployed at
  `<owner>.github.io/ipfs-gh-pages`
- **dev**: the same vite app at `http://localhost:5173` (`npm run dev`)
- **rust**: the ratzilla TUI + js/ipfs-node.js bridge, served by the
  desktop/webview app at `http://127.0.0.1:<ephemeral>`

## What already interoperates

- **Gossip topics**: all three derive the same `repoFullName` (Pages from
  origin, dev/rust from build-time identity) → same
  `repo-gossip:<repo>` and `:chat` topics. Clone detection, chat, and
  serve advertisements flow across all surfaces.
- **Envelope verification**: notes/chat are P7-signed with the key's
  public half embedded — anything signed anywhere verifies everywhere,
  regardless of localStorage.
- **Content**: CIDs are universal; fetch/publish/root-CID encoding match
  (repo-files pipeline mirrors the vite plugin).
- **Services registry + bootstrap**: p2p defaults work everywhere;
  optional services are per-origin config (fine — they're preference,
  not protocol).

## What does NOT interoperate (origin-scoped localStorage)

Each origin gets its OWN localStorage, so each surface currently has
separate copies of:

| key | effect of the split |
|---|---|
| `ipns-branch-key:<repo>` | different Ed25519 identity per surface — same human, different signer |
| `repo-index-chain` / `repo-index-lamport` | issues index diverges; surfaces see different issue sets |
| `blocked-peers`, `ipfs-services`, chat seen-set | preference/state divergence |

The linchpin is the **identity key**: everything else derives from it
(IPNS name = peer id of that key; index chain signed by it).

## Design: local identity service (one key, served by the rust app)

The rust app already hosts the embedded HTTP server. It becomes the
identity authority for the machine:

1. Fixed well-known interop endpoint on the rust app, e.g.
   `http://127.0.0.1:5050/well-known/` (a FIXED port, separate from the
   ephemeral UI port — interop needs a stable address; 5050 is
   registered-free and rare). Routes:
   - `GET /well-known/identity` → `{ publicKey, peerId }` (public half;
     the JS bridge derives the same from its own key to cross-check)
   - `GET /well-known/key` → the raw private key (base64), served only
     with `Access-Control-Allow-Origin: *` and ONLY to loopback
     connections (check peer addr) — localhost HTTP key export is the
     accepted tradeoff (same trust domain as the Kubo RPC API on 5001)
   - `GET /well-known/state` → index chain tip + lamport + blocked peers
     + services registry (encrypted with the public key? no — shared
     verbatim; same trust domain)
2. Pages and dev surfaces: on boot, probe
   `http://127.0.0.1:5050/well-known/identity`; if present and its peerId
   differs from localStorage's, offer "adopt local identity?" (or auto-
   adopt when localStorage has none). Adopting = import the key, replace
   local chain only if the remote tip is longer/heavier (chronology fork
   choice).
3. Loopback fetch from an https page is NOT mixed-content-blocked
   (loopback is a trustworthy origin), so Pages can reach it; CORS `*` on
   those routes makes the browser allow it.

Fallback when the rust app isn't running: **manual export/import** —
a `identity.export` / `identity.import` op + UI button producing/consuming
a JSON bundle `{ key, chainTip, lamport }` (file download / paste). Same
format the well-known endpoints use.

## Notes/index interop (independent of identity sharing)

docs/issues-car.md already plans publishing the index tip at an IPNS name.
With a SHARED identity, `/ipns/<signer>` resolves to the same index on
every surface — issues filed in the TUI appear on Pages and vice versa,
with the chronology fork-choice rule resolving merges. Until identity is
shared, surfaces can still READ each other's notes by CID (given a link)
— they just won't aggregate them into one index.

## Build order

1. CORS + loopback-only guard on the rust embedded server; fixed interop
   port (5050) serving the three well-known routes from config/state the
   bridge already holds.
2. Bridge ops: `identity.export` / `identity.import` (the manual path —
   same JSON the routes serve).
3. main.js: local-app probe + adopt flow on boot (dev first, Pages gated
   behind the same code).
4. Index tip -> IPNS publish/resolve across surfaces.

## Non-goals

- Cross-origin localStorage sync in general — only the identity-derived
  state above crosses; preferences stay per-surface.
- Serving the key over the network beyond loopback — never.
