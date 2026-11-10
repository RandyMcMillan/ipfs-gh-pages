# Plan: expose ipfs-gh-pages JS functionality to the Rust ratzilla TUI

Status: proposed. Nothing implemented yet.

## The core constraint

Helia is JavaScript. Every IPFS operation (unixfs, strings, dag-json notes,
gossipsub, delegated routing) must execute in the page's JS context. The
ratzilla TUI is Rust→wasm in the same page. So the design is a **two-channel
bridge** between Rust wasm and the JS module (`js/ipfs-node.js`), NOT a port
of Helia to Rust.

## Bridge architecture

Two channels, both already-true facts about the environment:

1. **State: JS → Rust by polling.** The JS maintains
   `window.__ipfsState`, a plain JSON-able object. Rust reads it every frame
   inside `App::on_tick` — the ratzilla draw loop already runs per animation
   frame, so polling is free. No callbacks, no lifetimes, no `Closure`
   plumbing.

2. **Commands: Rust → JS by call.** JS exposes
   `window.__ipfsCmd(id, op, arg)`. Rust invokes it through a
   `#[wasm_bindgen]` extern / `js-sys::Reflect` call with a monotonically
   increasing id. Ops are async; results are written back into
   `__ipfsState.results[id]` (or into a domain-specific slot like
   `chat.inbox`). Fire-and-forget; Rust matches by id.

No serde — extract fields manually with js-sys (deps to add: `js-sys` as a
direct dependency; wasm-bindgen already present).

## JS side: grow js/ipfs-node.js into a real API surface

Every op mirrors proven code in main.js (cited per op):

| op | mirrors main.js | notes |
|---|---|---|
| `info` | initHelia status block | peerId, multiaddrs, connection count, protocols |
| `peers` | refreshPeers | connection list: peer id, addr, direction, muxer |
| `connect(addr)` | probeDial + connect flow | dial multiaddr, report result |
| `disconnect(peerId)` | — | close connections to peer |
| `block/unblock(peerId)` | getBlockedPeers/setBlockedPeers | same localStorage keys, same enforce-on-open gate |
| `fetch(cid)` | fetchContent (1301), dialDelegatedProviders (1266) | strings cat or dir ls listing; provider dial on stall |
| `publish(text)` | heliaStrings.add (1214) | returns CID + gateway URL + pin command line |
| `dagPut/dagGet` | addDagJson/getDagJson (813), signNote/verifyNote (2845) | notes/issues envelopes, Ed25519 |
| `chatSend(text)` | sendChatMessage (916) | signed envelope over gossipsub |
| `chatInbox` | renderChatMessage (884) | verified, forgery-marked, cap 50 |
| `kuboDetect` | tryKuboRpc/probeKuboRpc (2598-2650) | probe RPC ports 5001-5010 |
| `kuboPin(cid)` | remotePinRoot family | `pin/add` via RPC |
| `providers(cid)` | delegated routing (DELEGATED_ROUTING_URL) | who provides a CID |
| `shareAddr()` | getShareableMultiaddr (1904) | relayed p2p-circuit address |

### Interop gotchas (learned from main.js, must carry over)

- **Identity key**: main.js persists the Ed25519 branch key in localStorage
  at `ipns-branch-key:<repoFullName>` (getIpnsBranchKey, 949). The bridge
  MUST use the same key derivation and the same `repoFullName` so notes and
  chat signed in the TUI verify in the vite app and vice versa. Replicate
  repoFullName logic: `<owner>.github.io/<repo>` from origin, else baked
  build-time identity.
- **emitSelf is off** (gossipsub): the sender must render its own chat
  message locally, like sendChatMessage does.
- **Blocklist is enforced on `connection:open`** for inbound too — keep the
  gate (initHelia 1090-1095).
- Bundle must stay self-contained: esbuild, zero bare imports, copied by
  trunk's copy-file link.

## Rust side

- `src/ipfs.rs` (new): js-sys wrappers. `poll() -> IpfsStateSnapshot` reads
  `window.__ipfsState` into a typed snapshot (manual field extraction);
  `command(op, arg)` sends with an id counter. All browser-only, gated
  `#[cfg(target_arch = "wasm32")]`.
- `src/app.rs`: App gains an `ipfs: IpfsStateSnapshot` field, per-tab input
  buffers, and an `input_mode: Option<Tab>` — while a tab is in input mode,
  char keys append to that tab's buffer instead of hitting the global
  handler (protects existing `q`/`t`/arrows).
- `src/ui.rs`: new tabs alongside Home/About/Status/Theme. Input widgets:
  bottom line text field (Paragraph + cursor block), results in scrollable
  Lists. Full identifiers, never truncated (working agreement).

## Build phases (in order)

1. **Bridge foundation.** `__ipfsState`/`__ipfsCmd` in JS; `src/ipfs.rs`;
   poll in `on_tick`; new `IPFS` tab shows live peerId/connections from
   state instead of footer-only.
2. **Peers tab.** Connection list, `connect` input, disconnect/block.
3. **Fetch tab.** CID input → text or directory listing, scrollable.
4. **Publish tab.** Text → CID + gateway URL + `ipfs pin add <cid>`.
5. **Chat tab.** Signed gossipsub chat: send + verified inbox (cap 50).
6. **Kubo tab.** RPC detect (5001-5010), pin fetched/published CIDs,
   printed commands (own line each, per working agreement).
7. **Optional: repo snapshot.** Build-time script emits repo files JSON
   (parity with vite's virtual:repo-files plugin) copied by trunk → root
   CID + CAR export from the TUI.

Related design note: `docs/git-over-ipfs.md` — an embedded git server
backed by IPFS so `git clone` works through the app (isomorphic-git is a
smart-HTTP client; static IPFS content can't answer it, so a real server
is required — options: shell out to `git http-backend`, thin upload-pack
over our blockstore, libp2p transport last).

## Explicitly out of scope (for now)

Issues/comments CAR (docs/issues-car.md phases 5+), IPNS branch pointer
publishing, remote pinning services, the GitHub-style HTML chrome.
