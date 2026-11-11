# Note: git server over IPFS/libp2p (git clone through the app)

Status: design note, not scheduled. The rust app will need this so users
can `git clone` a repo served from IPFS — the "GitHub's git server"
equivalent in our map (AGENTS.md design objective 2).

## What exists today (prior art)

- **Dumb HTTP over an IPFS gateway** — [IPFS Docs: host a Git-style
  repo](https://docs.ipfs.tech/how-to/host-git-repo/). A bare repo is plain
  files; `git clone https://<gateway>/ipfs/<cid>` works with NATIVE git
  (read-only, dumb protocol). Works today, zero new code. Limits: native
  git only, no push, full clones only.
- **git bundles on IPFS** — a bundle is a single file `git clone` accepts
  from any static host. Same limits, plus manual rebundling per update.
- **git remote helpers** — [ipfs-shipyard/git-remote-ipld
  ](https://github.com/ipfs-shipyard/git-remote-ipld) (Go, archived),
  [ElettraSciComp/Git-IPFS-Remote-Bridge](https://github.com/ElettraSciComp/Git-IPFS-Remote-Bridge)
  (Python, hooks-based, clone/push/fetch). Require a local IPFS API; not
  embeddable in our app as-is.
- **Radicle** — git over its own p2p stack, not IPFS; useful reference for
  identity/replication design, not a component.

## The isomorphic-git gap

[isomorphic-git](https://isomorphic-git.org) runs IN the browser (perfect
for cloning from the TUI) but it is a **client of the smart HTTP protocol**
(`info/refs?service=git-upload-pack`, then `git-upload-pack` RPC). Static
IPFS content cannot answer those RPCs. So "just use isomorphic-git" fails
without a real git server behind it — the exact problem this note is for.

## Chosen direction: gossip advertisement + libp2p transport

The repo-gossip gossipsub channel the app ALREADY runs
(`repo-gossip:<repo>` in js/ipfs-node.js / main.js) doubles as the
advertisement layer, and git's smart protocol runs over a libp2p stream.
No localhost HTTP, no gateway, no central registry.

### Advertisement (gossipsub)

Any node that serves a repo publishes a signed envelope on
`repo-gossip:<repo>`:

```
{ op: "serve", repo, head: <git sha>, rootCid, addrs: [...], ts, signature }
```

- `addrs` = dialable multiaddrs offering `/ipfs-gh-pages/git/1`
  (desktop/kubo-style nodes), OR a relayed p2p-circuit address for
  browser nodes (we already build those for share links).
- Subscribers learn who serves the repo = the existing clone-detection
  trick, extended with serve intent. Forks announce themselves the same
  way — no registry, the signature is the only authority.

### Transport (libp2p stream)

Registered libp2p protocol: `/ipfs-gh-pages/git/1`. The stream speaks git
smart protocol RPCs (`info/refs?service=git-upload-pack`, then
`git-upload-pack`; `receive-pack` later for push):

```
client                                     server (serves repo from IPFS)
  |--- /info/refs?service=git-upload-pack -->|
  |<--- ref advertisement --------------------|
  |--- wants/haves --------------------------->|
  |<--- packfile (whole objects; delta-free   |
        packs are legal) ---------------------|
```

Object resolution on the server side goes through the blockstore: git
objects are content-addressed like CIDs, a bare repo's objects/ maps onto
unixfs. Browser nodes can't listen, so they clone by DIALING an advertised
address (direct or relayed circuit) — same reachability model as the
existing share-link flow.

### isomorphic-git plugs straight in

isomorphic-git's http client is pluggable: we hand it a client whose
`request()` maps the smart-HTTP URLs onto the libp2p stream above
(one short-lived stream per RPC). The TUI clones in-page with live
progress reported over `__ipfsState` — no separate download path.

## Phase 9 implementation plan: real clone through the app

The phase-8 zip is a snapshot; this is live git. Both sides of the
smart protocol run INSIDE the bridge — no libp2p listener needed yet,
because client and server are the same process (the wasm page):

1. **Git object primitives** (bridge, new section):
   - unixfs-walk the bare-repo CID into an in-memory object store
     (loose objects: fflate `unzlibSync` → `<type> <size>\0<payload>`)
   - packfile reader: `.idx` v2 parse, pack entry inflate, OFS_DELTA /
     REF_DELTA resolution chains
   - `git.refs(cid)` op — list refs (HEAD, refs/*, packed-refs)
   - `git.catFile(cid, sha)` op — read a commit/tree/blob back
2. **upload-pack in-process**: parse `info/refs` + `git-upload-pack`
   wants/haves against the object store, emit a delta-free packfile.
3. **isomorphic-git clone**: `git.clone(cid)` op = lightning-fs
   (IndexedDB) + custom http `request()` wired DIRECTLY to the
   in-process upload-pack (no sockets — the "transport" is a function
   call; the libp2p stream from the earlier section replaces it later
   for cross-machine clones). TUI shows refs/log; zip download of
   worktree + .git from lightning-fs.
4. **Incremental fetch/pull**: persist the clone's object store in
   IndexedDB; haves come from the local store, wants close the delta
   with the remote CID — true incremental clone across publishes.

The existing phase-8 `git.clone` (zip of the raw tree) stays as the
no-JS-pack-parser fallback and for repos that aren't git-shaped.

## Compatibility / fallback paths

1. **Shell out to `git http-backend`** when a `git` binary is available:
   the embedded HTTP server in src/wry_app.rs exposes
   `http://127.0.0.1:<port>/git/<cid-or-ipns>` for native
   `git clone`. Localhost convenience for kubo-style workflows and a
   stopgap before the libp2p protocol lands.
2. **Dumb HTTP / bundles via gateway** (prior art above) — zero-code
   read-only fallback, native git only.

## Relationship to the bridge plan

- Fetch tab (docs/rust-js-bridge.md phase 3) already retrieves a CID's
  tree; the serve path (fallback 1) reuses it to materialize a bare repo.
- The advertisement envelope reuses the P7 notes signing scheme from
  main.js — one identity, one verification path.
- The gossipsub module in js/ipfs-node.js gains publish/subscribe of
  `serve` envelopes; git transport lives behind the same
  `__ipfsState`/`__ipfsCmd` bridge.

## Open questions

- Stable clone address: gossip `serve` envelopes are ephemeral — pair
  with IPNS / the existing branch-pointer scheme so `clone <repo>` has a
  persistent entry point even when no advertisement is fresh.
- Push (receive-pack): same machinery plus ref-update auth — after clone
  works end to end.
- One unixfs tree per repo snapshot vs sha1→CID mapping (dedup across
  versions, harder resolution).
