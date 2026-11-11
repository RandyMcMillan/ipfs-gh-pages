# brig → our stack: ideas to adapt

Reference: `/Users/Shared/github/brig` (sahib/brig — distributed,
git-like file sync over IPFS in Go). What its design says to our
rust + ratzilla + wasm + JS bridge architecture, ordered by leverage.

## 1. Desktop-as-daemon (their server/client split) — the enabler

brig runs a long-lived daemon; every client (CLI, FUSE, gateway) is
thin. We already have the shape: the desktop app (wry webview + tray)
is the daemon, the web page and TUI are clients. The missing daemon
capability is LISTENING — browsers can't accept inbound libp2p, the
desktop can. This is the unblock for the libp2p git transport
(`/ipfs-gh-pages/git/1`): the in-process upload-pack wrapped in a
stream, served by the desktop daemon.

## 2. Pin-set as a versioned, signed object

brig's pinner tracks *what* is pinned as a structured cache with
repin-on-GC semantics (catfs/pinner.go, repin.go) — "every repository
acts as a cache of the files you can access". For us: a **pin-set
manifest on the issues chain** — a signed note naming the CIDs a node
guarantees (repo root, release CARs, rehosted assets), versioned by
the chain itself. We already have every part: signed dag-json notes,
the chain, `scripts/rehost-mirror.mjs` as the pin executor. New work
is only the manifest note type + a publisher.

## 3. Ghost nodes / tombstones for moves and deletes

brig keeps tombstones for moved/deleted files (nodes/ghost.go), which
is how it detects renames and preserves history — two things git
famously doesn't do. Our release chain (`{type:'release', root, prev}`)
currently only shows adds/changes (CID diff). A tombstone release
`{type:'release', root, prev, removed: [paths], moved: [{from,to}]}`
would make tree history complete AND fix a known blame gap: our blame
matches by line text, so a renamed file loses attribution; tombstone
moves would let blame follow the rename.

## 4. Layered streams for the transport (their mio)

brig's transfer stack layers compress/encrypt over the wire
(catfs/mio/stream.go) with per-file-type algorithm hints. When the
libp2p git transport lands, the same layering applies to our
upload-pack stream — and the wasm/rust split means the layering can
live in the JS bridge (stream reader/writer) while rust owns the
socket. No new rust deps.

## 5. Cache quota (pin-what-you-need)

brig keeps a configurable range of versions cached locally, evicting
older ones past quota. Desktop policy equivalent: pin the latest N
release roots + explicitly-starred CIDs, GC the rest. Small policy
addition to the desktop's pin flow — prevents the node from growing
unboundedly across releases.

## 6. Gateway-as-product (their Elm UI validates our split)

brig's gateway is a full web UI over the daemon — exactly our
interop-server + web-app shape (they even used a functional UI
language). Their gateway includes user/right management over HTTP;
our interop server (:5050) is the same seam. Validation, not new
work: keep the page a client of the daemon, never the authority.

## 7. Identity as a resolvable name, not an address

brig identifies users as email-like names resolved to peer addresses
(net/peer, resolve). Our `repoFullName` (owner/repo) + per-repo IPNS
name is the same pattern. The lesson to keep: identity is a NAME that
resolves to whatever the current pointer is — never hardcode
addresses into content (our notes already follow this: they anchor
CIDs, not locations).

## 8. Cap'n Proto lesson (schema'd, evolvable wire formats)

brig uses capnp for sync + storage schemas. We're committed to
dag-json/CAR — no change — but the lesson stands: every wire object
we add (notes, releases, pin-sets) should carry a `type`/`v` field
from day one so the schema can evolve without migrations.

## Explicitly NOT adopting

- AES-256-GCM at rest + transport encryption layers — our content is
  public by design (public repos on IPFS); encryption is a different
  product. Signed notes give integrity/authenticity, not
  confidentiality.
- FUSE mount — noted as a possible desktop differentiator later; no
  near-term plan (macOS FUSE needs kernel extensions/third-party
  kexts; out of scope for now).
- Their full VCS (branch/merge/checkout) — git already IS our VCS;
  we sync git repos, we don't reinvent them.

## Suggested order

1. Pin-set manifest note + publisher (uses existing chain machinery).
2. Tombstone releases (complete tree history + rename-aware blame).
3. Desktop listen + git transport (the phase that's blocked).
4. Cache quota on the desktop.
