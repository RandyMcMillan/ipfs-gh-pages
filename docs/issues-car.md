# Issues CAR — build plan

Decentralized issues, comments, and review metadata for this repo, modeled
directly on git's own mechanisms (no central registry, fork-aware by
construction) and on `git notes` (non-invasive annotation of immutable
objects). Precedent: Google's git-appraise ran distributed code review
entirely on notes namespaces; git-bug stores full issue trackers in refs.

## Chronology protocol

The notes set is append-only and CID-keyed, which alone guarantees
*set* convergence (an OR-Set: add-wins, same CID = same object
everywhere). The hard part is the *index*: a chronology that any two
replicas, holding the same entries, render identically — and that
absorbs appends and competing rewrites deterministically. No PoW, no
global admission: repo-scoped trust, git-remote style.

### Index entries (hash-chained)

```json
{
  "type": "index-entry",
  "added": ["<note CIDs first seen by this entry>"],
  "prev": "<previous entry CID, or null at genesis>",
  "height": 42,
  "lamport": 1337,
  "signer": "<peerId>",
  "timestamp": "ISO-8601 (advisory only)",
  "signature": "<base64>", "publicKey": "<base64>"
}
```

Validity rules:
1. **Prefix closure** — every `prev` must resolve locally (fetch the DAG
   like `git fetch`; an entry whose parents are absent is held, not
   accepted). Nothing can precede what it references.
2. **Height = prev.height + 1**; genesis (`prev: null`) is unique per
   chain — if two genesis entries appear, the lower-CID one is canonical
   (deterministic, content-derived), the other persists as an orphan
   branch whose notes remain valid set members.
3. **Signature valid**; `lamport > max(parents' lamport)` (Lamport rule;
   violations are dropped as malformed — cheap to check).
4. **No double-add** — a note already in the chain prefix is ignored as
   a no-op; the same signer publishing *different* children of the same
   parent is **equivocation** (see below).

### Fork-choice — the deterministic chronology

Among all known tips, the canonical chain is:

1. **highest height** wins;
2. ties — **lower tip CID** wins;
3. nothing is ever deleted: a competing chain persists as an orphan and
   its notes stay in the set. "Rewriting history" is therefore
   *impossible to do destructively* — it can only mean publishing a
   longer chain, and the old view remains content-addressed and
   inspectable. A view swap (re-org) replaces order, never data.

Determinism proof: height and CID are functions of content only, so any
replica holding the same entry set computes the same canonical chain and
the same note order (first-inclusion order along the chain). Partial
knowledge is monotone: new entries only extend or re-view, never
invalidate a verified signature. UI may mark **finality depth**
(entries deeper than K below the tip) as unlikely to re-org — K is a
local display parameter, not consensus.

### Total order over notes

1. Notes ordered by first inclusion in the canonical chain.
2. Valid-but-unchained notes (withheld, orphaned, or not yet absorbed):
   ordered by `(lamport, cid)` — deterministic, and since wallclock is
   advisory, clock abuse and backdating are harmless to convergence.

### Merge protocol (on fetch of a remote's entries)

1. Verify signatures and prefix closure; pull missing ancestors.
2. Union the note set (OR-Set semantics — notes are data, the chain is
   only an ordering device; a valid signed note displays even if never
   chained, marked unordered).
3. Detect equivocation: same signer + same parent + different children.
   Both children are retained; fork-choice keeps the lower CID; the
   detector publishes a fraud proof — a note in namespace `audit`
   carrying both signatures, self-certifying the equivocation. Consumers
   downweight the signer by local policy; the protocol itself needs no
   blacklist.
4. Recompute the canonical chain and re-render order.

### Fork-awareness without a shared genesis

Forks start their own genesis and their own chain. Absorbing a fork's
notes into our chronology is a **merge entry** on our chain:

```json
{ "type": "index-entry", "added": [], "parents": ["<our prev>", "<their tip>"] }
```

Multi-parent entries generalize `prev` to a list (git merge commits);
height = max(parents)+1. Our chain thereby absorbs their tip by
reference, their notes enter our set and our ordering, and both repos
converge to the same canonical view without either being authoritative.

### Transport + discovery (reuses shipped machinery)

- **Tip announcements**: each new index entry CID is published on
  `repo-gossip:<repo>:index` (gossipsub, same pattern as clone detection
  and chat) — replicas learn tips within the gossip horizon; fetch
  carries the full entries.
- **Durable pointer**: the repo's IPNS name (the branch-pointer key)
  resolves to the current canonical tip CID — strangers bootstrap
  without gossip.
- **Checkpoint/sync**: the issues CAR is a snapshot of the entry set;
  `ipfs dag import` = load, recompute canonical chain. No
  replay-from-genesis beyond the CAR's contents.

### Git-host bridge (hooks)

Notes are refs, so any git host is a free mirror and transport — GitHub
shows nothing in the UI but stores and serves `refs/notes/*` faithfully.
The bridge syncs the two worlds at git operation boundaries:

- **Outbound** (`pre-push` or a sync script the user runs): read the
  current canonical index tip (from the local IPFS node or a file the app
  exported), write it into `refs/notes/<repo>/index` — a notes commit
  whose tree names the tip CID (same SHA-keyed-tree convention as native
  notes, so git tooling can read it) — and push it alongside the code via
  the remote's push refspec (`+refs/notes/*:refs/notes/*`). Forks on the
  host then carry the notes to whoever clones or forks them.
- **Inbound** (`post-merge` / `post-fetch`): read the fetched notes ref,
  hand the tip CID to the app, and merge per the Chronology protocol
  (prefix closure, union, fork-choice).
- **Hooks live in `.githooks/`** (versioned) activated by
  `git config core.hooksPath .githooks` via an npm script — hooks are not
  cloned, so the repo must install them explicitly.
- **Caveat**: notes created in the browser are not git events, so the
  hook is a *sync point*, not real time — realtime propagation stays on
  pubsub/IPNS; the git-host path is durability and bootstrapping (a fresh
  clone with no IPFS connectivity still obtains the notes from origin).
- **Interop bonus**: using the standard notes layout means git-native
  tools (git-appraise, git-bug, plain `git notes`) can read and write the
  same layer — comments filed from a terminal appear in the app.

### Attacks and resolutions

| attack | resolution |
|---|---|
| timestamp backdating / clock skew | wallclock advisory only; order from chain inclusion, then `(lamport, cid)` |
| equivocation (double-sign) | detectable fraud proof, both retained, lower CID canonical, signer reputation is a local view |
| competing-chain spam | bounded by fork-choice — losing chains cost the spammer storage, not us consensus |
| Sybil flooding the index | trust follows configured remotes + the genesis key (the repo owner's key), not global admission |
| entry withholding to some replicas | gossip spreads tips; eventual consistency, same convergence |
| history rewrite attempt | content addressing preserves all entries; only the canonical VIEW changes, and only by extension |
| deletion demands | no deletion in protocol; local pruning of unordered notes is storage policy, doesn't affect convergence |


## The git mapping

| git | this layer |
|---|---|
| commit / blob | issue object, comment object (signed dag-json envelopes) |
| `refs/heads/<branch>` | thread head CID (`refs/issues/<id>` analog) |
| `packed-refs` | the index object (list of thread heads, versioned) |
| `git commit -S` | Ed25519 signature over the envelope payload |
| `git remote add` + fetch | `index.remotes` entries; traversal reaches their objects |
| `git bundle` (packfile + refs) | the issues CAR |
| merge commit (two parents) | index object with `parents: [a, b]` |
| object universality (same hash = same object) | same CID = same issue, in every fork |

| git notes | this layer |
|---|---|
| annotated commit, SHA unchanged | the repo/file CID — the code DAG never mutates |
| `refs/notes/commits` | the index tip, published at an IPNS name |
| notes commit (add = commit, history kept) | the index chain (`parents`) |
| notes tree: SHA → note blob | notes looked up by `anchors` CID |
| `refs/notes/<namespace>` | `ns` field per note: `issues` · `review` · `ci` |
| `git fetch +refs/notes/*:refs/notes/*` | importing an issues CAR (fetch, not adopt) |
| `git log --notes` | issue badges rendered on files/CIDs in the UI |

| git (extended) | this layer |
|---|---|
| `git blame` (line → origin commit) | attribution walk over the root chain |
| commit parent | release-commit object `{root, prev}` |
| GitHub PR line comments | `(fileCid, line)` notes — immutable by construction |
| blame-anchored discussion | origin-anchored notes that ride the line's history |

## Granular commenting

Three annotation granularities ride the same envelope pipe, discriminated
by `type`:

- **`issue`** — repo/dir/file level via `anchors` (the notes model).
- **`line-comment`** — a line range *within one exact blob CID*:
  `{anchors: [fileCid], line: {start, end}}`. This is stable forever:
  the CID pins the content, so `(cid, line)` is a content-addressed
  coordinate. GitHub's line comments die when the PR merges; these
  persist on the annotated version and correlate forward via blame.
- **`blame-comment`** — attached to the *origin* of a line, not the
  version: `{anchors: [fileCid], line: {start}, origin: <root CID>}`.
  It surfaces on every later version whose blame attributes that line to
  the same origin — the comment rides the line's history the way git
  blame rides the commit graph.

Blame requires a **root chain**: each build/publish records a
release-commit object `{root, prev, timestamp}` (one CID of history —
the git commit analog our DAG was missing). Blame then computes
attribution: walk the chain newest→oldest, diff consecutive roots by CID
(a file whose CID changed changed content), attribute each line of the
current file to the oldest root containing it; exact line-text match is
the MVP correlation heuristic (git's own blame uses content + context).

Rendering: the blob view already renders line numbers — a comment gutter
shows markers on annotated lines, text selection offers "Comment on lines
X–Y", and a Blame toggle computes per-line origin and lets any blame row
receive a comment. Tree rows and blob headers carry the badge when any
note anchors to that CID.

## Core properties (why this works)

1. **Objects, not rows.** Issues and comments are content-addressed
   objects; nothing is mutated. A thread is the DAG reachable from its
   head, exactly like a branch's history. Signatures survive any transport.
2. **Fork-awareness by reference.** A comment written in a fork names the
   canonical issue's CID as its parent; the object grafts onto the same
   DAG wherever it is published. Awareness = configured remotes + walking
   refs, the same two mechanisms git uses. Nobody is in charge.
3. **Merge = union.** Everything is append-only and CID-keyed, so a merge
   is a set union with two parents — the conflict-freedom that makes
   `git pull` work is content addressing doing the same job here.
4. **Annotation is non-invasive (notes).** An issue can anchor to the root
   CID, a directory, or one file's CID; the code tree is untouched. Notes
   stay on the CID they were filed against — walk the DAG and they surface
   on ancestors (blame-style), which repo-level issue trackers cannot do.

## Data model

Issue:
```json
{
  "ns": "issues", "type": "issue",
  "anchors": ["<cid of root/dir/file the issue is about>"],
  "title": "…", "body": "…",
  "timestamp": "ISO-8601", "signer": "<peerId>",
  "signature": "<base64>", "publicKey": "<base64>"
}
```

Comment (issue thread reply):
```json
{
  "ns": "issues", "type": "comment",
  "parent": "<cid of issue or comment it replies to>",
  "body": "…",
  "timestamp": "ISO-8601", "signer": "<peerId>",
  "signature": "<base64>", "publicKey": "<base64>"
}
```

Line comment (granular review):
```json
{
  "ns": "review", "type": "line-comment",
  "anchors": ["<fileCid>"], "line": { "start": 42, "end": 47 },
  "body": "…",
  "timestamp": "ISO-8601", "signer": "<peerId>",
  "signature": "<base64>", "publicKey": "<base64>"
}
```

Blame comment (rides the line's origin across versions):
```json
{
  "ns": "review", "type": "blame-comment",
  "anchors": ["<fileCid>"], "line": { "start": 42 },
  "origin": "<root CID the line is attributed to>",
  "body": "…",
  "timestamp": "ISO-8601", "signer": "<peerId>",
  "signature": "<base64>", "publicKey": "<base64>"
}
```

Release commit (the history link blame walks):
```json
{ "type": "release", "root": "<root CID>", "prev": "<previous release CID or null>", "timestamp": "ISO-8601" }
```

The index is not a flat object — it is the **hash-chained entry set**
defined by the Chronology protocol above. The per-entry `added` lists
play the role the flat `issues` array played in the original sketch:
they are the packed-refs, now with deterministic ordering, merge
semantics, and fraud accountability.

Signature rule (unchanged from the attestation scheme): sign the dag-json
encoding of everything except `signature` and `publicKey`; verify with
`publicKeyFromProtobuf`, identity proven by `peerIdFromPublicKey`.

## Build phases

1. **Note objects.** Extend the existing issue flow to the full schema:
   `ns`, `anchors`, `type`. Comments as reply objects with `parent`.
   Verification and signing reuse the P7 helpers.
2. **Thread UI.** Issues list renders threads; each issue opens to its
   comment chain (walk `parent` links, verify each object).
3. **"File issue on this CID".** `selectFile` already knows CIDs — the
   file actions and blob view gain the button; the issue form prefills
   `anchors` and stays editable.
4. **Index entries.** Every create extends the canonical chain with a new
   hash-chained entry (Chronology protocol). Local per browser first;
   durable tip publishing = IPNS pointer on the branch key, plus gossip on
   `repo-gossip:<repo>:index`.
5. **Remotes.** Configured remote pointers (git remote analog) + "Add
   remote" control; fetch-and-merge = pull their entries, prefix-closure,
   union the note set, absorb their tip via a multi-parent merge entry,
   recompute the canonical chain.
6. **build-car.mjs walk-and-bundle.** From the index tips (own + remotes),
   walk every reachable note/comment object and merge those DAGs into
   `ipfs-gh-pages.car` (block-union rewrite, dedup by CID — CARs never
   concatenate). Roots = repo root + index tips. `ipfs dag import` of the
   release CAR then carries the full tracker, versioned per release.
7. **Import = fetch semantics.** `ipfs dag import <issues.car>` gains
   objects without authority; rendering always verifies signatures.
8. **Issue badges.** Notes rendered next to files (the `git log --notes`
   equivalent): CIDs with notes get a marker in the tree/blob view.
9. **Line comments.** Blob-view comment gutter: markers on annotated
   lines, text selection offers "Comment on lines X–Y" (signed
   `line-comment` notes; `(cid, line)` is the immutable coordinate).
10. **Root chain.** The build/publish flow records the release-commit
    object `{root, prev}`; the app's Clone bar links the current
    release CID, making history walkable.
11. **Blame.** Blame toggle in the blob view: per-line origin attribution
    via the root chain, origin-anchored `blame-comment` notes riding the
    line's history, blame-row commenting UI.
12. **Git-host bridge.** `.githooks/` (pre-push outbound, post-merge
    inbound) + an npm script to activate via `core.hooksPath`; push
    refspec carries `refs/notes/*` to any host.

## Open questions

- Durable tip publishing: IPNS on the branch key (chosen in the protocol)
  vs pinning-service named listing vs Kubo MFS as backup mirrors.
- Namespace governance: `review` and `ci` ride the same pipe but are not
  built until issues prove the model.
- Blame correlation: exact line-text match is the MVP heuristic; git-style
  content+context moves are a later refinement if reindentation churn
  mis-attributes often.
- Root chain bootstrapping: the first release-commit has `prev: null`;
  history before the chain exists is unattributable (same as `git blame`
  hitting a root commit).
- Re-org UX: how loudly to surface a canonical-chain swap (compare git's
  forced-update messaging). Protocol is silent; UI decides.
- Finality depth K: default display threshold for "settled" entries —
  a local policy knob, not consensus.
