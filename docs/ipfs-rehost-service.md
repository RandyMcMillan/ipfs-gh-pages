# IPFS rehost service — a decentralized camo

Status: PLAN (no code yet). Feeds the image-policy decision in
`docs/markdown-rendering.md` (decision #1) — if adopted, it becomes the
"rehost" option: remote images are fetched ONCE and rewritten to
content-addressed URLs, instead of live third-party embeds.

## What the references give us

- **camo** (`server.coffee`, 270 lines) — the safety rulebook: HMAC-minted
  proxy URLs (only the renderer may mint → the proxy is not open), MIME
  whitelist, 5 MB cap, 4-redirect depth, 10 s socket timeout, cookies
  stripped, Via self-request guard, security headers on responses
  (`default-src 'none'`, nosniff), Heroku-scale single node.
- **git-ipfs-rehost** (whyrusleeping) — the rehost pattern: clone → pack
  → `git update-server-info` → `ipfs add -r` → gateway URL; `--existing
  /ipfs/<cid>` resumes incrementally by pulling previously published
  packs (content addressing dedups for free).
- **atmos.org** — nothing (a redirect stub).

## The core insight

Camo's HMAC exists to stop open-proxy abuse of the *fetch* path. On
IPFS the HMAC is unnecessary for *distribution*: a CID is
self-authenticating — anyone can serve it, no minting authority exists.
The only place an authority can still matter is the fetch on-ramp
itself, and only when the instance is public. So a decentralized camo
splits into: a dumb, replaceable fetcher + permanent content-addressed
distribution.

## Architecture — three tiers

**Tier 0 — no service at all (browser-native rehost).** The page's own
Helia node fetches the bytes (CORS permitting — shields.io and many
image hosts send `Access-Control-Allow-Origin: *`) and `add`s them.
Images are then served from the local node by CID. Zero third party,
zero infrastructure. Limit: CORS; large files cost the viewer bandwidth.

**Tier 1 — rehost service (the camo analog).**
`POST /rehost {url}` → fetch with camo's rules → add to IPFS (Kubo RPC
`KUBO_RPC`, else embedded Helia block put) → `{cid, gateways[]}`. The
origin is fetched exactly once, ever; viewers hit content-addressed
URLs (gateway of their choice, or their own node). Stateless except a
URL→CID cache. Optional `CAMO_KEY` HMAC minting for public instances —
camo's exact scheme, ported.

**Tier 2 — desktop/rust daemon.** The same on-ramp inside the desktop
app (the interop server and node already exist): fetches happen on YOUR
machine, so the only observer is you. This is the privacy-maximal
configuration and needs no public instance at all.

## Decentralization path

- **Content layer**: CIDs need no authority — any gateway/node serves
  them; availability = pinning (the repo's ☆ Remote pin machinery and
  pinning-services registry already exist).
- **Index layer**: the URL→CID mapping is published as signed notes on
  the repo's issues chain (`{ns:'rehost', url, cid, timestamp}`) —
  anyone mirrors the index, re-hosts missing CIDs, and concurrent
  rehosts merge via the existing Chronology machinery. This is
  git-ipfs-rehost's `--existing` trick generalized: incremental rehosts
  dedup by CID automatically.
- **On-ramp layer**: anyone can run one; resolution follows
  `docs/optional-services.md` — configured → public default → local node.
- **Honest limits**: the origin still sees the fetcher (once); a public
  on-ramp sees what it fetches (tiers 0/2 avoid that). IPFS does not
  anonymize — it removes third parties and makes content permanent and
  verifiable.

## Where it plugs into this repo

- Markdown renderer (decision #1 = rehost): remote images fetched once,
  `src` rewritten to `<gateway>/ipfs/<cid>`; CID affordances come free
  via the step-3 popover (`js/cid-links.js`).
- Release tooling: rehost CARs/releases the same way (block-union +
  trustless-gateway staging already in `scripts/build-car.mjs`).
- Git transport overlap: git-ipfs-rehost is whole-repo dumb-HTTP
  rehosting — our in-process upload-pack + CAR bundles supersede it,
  but its incremental `--existing` pattern applies to release CARs.

## Build phases

1. ~~**`scripts/rehost-service.mjs`**~~ SHIPPED (tier 1): `POST /rehost`
   (+ `GET ?url=`), camo's rules ported (MIME whitelist, 5 MB declared +
   streamed cap, 4-redirect depth, 10 s timeout, cookie strip, Via
   self-guard, SSRF guard — private/loopback refused unless
   `REHOST_ALLOW_PRIVATE=1`, optional `CAMO_KEY` HMAC minting), CID
   computed in-process (@helia/unixfs raw-leaf CIDv1), optional Kubo
   pin, URL→CID JSON cache. Tests `tests/rehost-service.test.mjs` (9):
   fixture origin, byte-identical round trip, every rejection class,
   cache, HMAC. Run: `PORT=8081 node scripts/rehost-service.mjs`.
2. ~~**`js/rehost.js`**~~ SHIPPED (module): `shouldRehost` (plain remote
   http(s) only — ipfs://, data:, and relative URLs are already
   content-addressed/inline/local), `rehostedSrc` (gateway form for src),
   `rehostAndRewrite` (POST → `{cid, src, ipfsUri}` or null on any
   failure — the caller falls back), injectable fetch/cache, unit-tested
   (tests/rehost.test.mjs, 5). The renderer wiring itself lands with the
   markdown image-policy decision.
3. **Tier 2** — `rehost` op in the rust interop server (rust fetches,
   the bridge adds), so the desktop app is a self-contained rehoster.
4. **Index on the issues chain** — `rehost` notes, signed, synced via
   the existing index machinery; a `rehost-mirror` script that walks
   the index and pins everything (availability without the origin).

## Verification

- Phase 1: unit + fixture-origin tests (fetch→CID→byte-identical
  round trip; every rejection class).
- Phase 2: CDP — README with a remote badge renders the rehosted
  gateway URL; second render hits the cache.
- Phase 3: desktop manual test (fetch on host, view on phone by CID).
- Phase 4: two browsers rehost different URLs, sync, both see both
  mappings (Chronology merge already tested).
