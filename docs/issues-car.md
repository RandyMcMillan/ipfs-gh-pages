# Issues CAR — build plan

Decentralized issues, comments, and review metadata for this repo, modeled
directly on git's own mechanisms (no central registry, fork-aware by
construction) and on `git notes` (non-invasive annotation of immutable
objects). Precedent: Google's git-appraise ran distributed code review
entirely on notes namespaces; git-bug stores full issue trackers in refs.

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

Index:
```json
{
  "type": "index",
  "issues": [{ "cid": "…", "title": "…", "anchor": "…", "timestamp": "…" }],
  "parents": ["<previous index CIDs — empty on first>"],
  "remotes": { "<name>": "/ipns/<key-or-pointer>" }
}
```

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
4. **Index chain.** Every create appends to the index; a new index names
   its parent. Local per browser first; durable publish path = ☆ Remote
   pin under a fixed name (`repo-issues`) or Kubo RPC `files write`.
5. **Remotes.** `index.remotes` + an "Add remote" control (paste a fork's
   index pointer). Fetch-and-merge = fetch their index, union `issues`,
   write a merge index with both parents.
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

## Open questions

- Durable index publishing: pinning-service named listing vs Kubo MFS vs
  DNSLink-on-Kubo. Decide at phase 4; the index object is identical either
  way.
- Ordering: timestamps suffice for MVP; git-bug-style Lamport clocks only
  if comment ordering becomes a real problem.
- Namespace governance: `review` and `ci` ride the same pipe but are not
  built until issues prove the model.
- Blame correlation: exact line-text match is the MVP heuristic; git-style
  content+context moves are a later refinement if reindentation churn
  mis-attributes often.
- Root chain bootstrapping: the first release-commit has `prev: null`;
  history before the chain exists is unattributable (same as `git blame`
  hitting a root commit).
