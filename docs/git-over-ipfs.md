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

## What we need to build: an embedded git server backed by IPFS

The app's existing embedded HTTP server (src/wry_app.rs) is the natural
host. `git clone http://127.0.0.1:<port>/git/<cid-or-ipns>` should work.

Architecture options, in order of pragmatism:

1. **Shell out to `git http-backend`** when a `git` binary is available:
   serve a temp/exported tree (or a fetched unixfs dir) as a bare repo.
   Least code, full smart protocol incl. push. Fallback when git is
   absent: dumb protocol from the exported tree (native-git-only).
2. **Thin upload-pack in-process**: implement `git-upload-pack` (ref
   advertisement + pack generation). Packs may contain whole (undeltified)
   objects — legal per pack format — so no delta compression is needed.
   Objects resolve through our blockstore (git objects are
   content-addressed, like CIDs; a bare repo's objects/ maps cleanly onto
   unixfs).
3. **libp2p transport later**: the same upload-pack/receive-pack logic over
   a libp2p protocol stream (`/ipfs-gh-pages/git/1`) so clones work without
   localhost HTTP — browser isomorphic-git would tunnel smart-HTTP RPCs
   over the page's libp2p connection via the JS bridge.

## Relationship to the bridge plan

- Fetch tab (docs/rust-js-bridge.md phase 3) already retrieves a CID's
  tree; a bare repo fetched to disk/unixfs is the input to option 1.
- In-TUI clone display (isomorphic-git client in the JS bundle, progress
  over `__ipfsState`) becomes possible the moment option 1/2 answers
  smart HTTP — no separate download path needed.
- Push/receive-pack is the same machinery plus ref update auth — out of
  scope until clone is proven.

## Open questions

- Repo update flow: dumb/bundle snapshots mean the served CID changes per
  release; IPNS (or the existing branch-pointer scheme from main.js) is the
  stable clone address.
- Do we serve the git objects as ONE unixfs tree (easy transport, naive
  resolution) or map git sha1s to CIDs (dedup across versions, harder)?
