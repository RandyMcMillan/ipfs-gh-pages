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

Comment:
```json
{
  "ns": "issues", "type": "comment",
  "parent": "<cid of issue or comment it replies to>",
  "body": "…",
  "timestamp": "ISO-8601", "signer": "<peerId>",
  "signature": "<base64>", "publicKey": "<base64>"
}
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

## Open questions

- Durable index publishing: pinning-service named listing vs Kubo MFS vs
  DNSLink-on-Kubo. Decide at phase 4; the index object is identical either
  way.
- Ordering: timestamps suffice for MVP; git-bug-style Lamport clocks only
  if comment ordering becomes a real problem.
- Namespace governance: `review` and `ci` ride the same pipe but are not
  built until issues prove the model.
