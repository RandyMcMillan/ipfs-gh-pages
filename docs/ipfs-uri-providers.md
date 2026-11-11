# ipfs:// URIs and provider/pinning integration

Status: design. Builds on docs/optional-services.md (services are
optional accelerants) and docs/interop.md.

## 1. ipfs:// protocol support

Support matrix across platforms:

| surface | native ipfs:// handling |
|---|---|
| desktop Firefox/Chrome + ipfs-companion | companion intercepts and redirects (local node or configured gateway) |
| iOS Safari + our safari-build extension | same interception (the local ipfs-companion fork, safari-build/) |
| everything else | nothing native — the page must handle it |

So the gh-pages app does three things, in order of universality:

1. **In-page interception (works everywhere, no extension).** Every CID we
   render becomes a link; clicking it never navigates away — our own Helia
   node fetches it (the fetch op already exists). `ipfs://<cid>` and
   `ipns://<name>` hrefs are rewritten to data-attributes + click handler.
   This makes CID linking useful on iOS with zero install.
2. **`web+ipfs://` protocol handler.** `navigator.registerProtocolHandler`
   allows safe `web+`-prefixed schemes: register `web+ipfs`/`web+ipns` so
   "open in app" from other pages lands in our fetch UI. This is the only
   programmatic registration a web page gets.
3. **Native `ipfs://` links for companion users.** When companion (or the
   iOS Safari build) is present, plain `ipfs://` hrefs are best left
   untouched — the browser/extension handles them, which is preferable
   (local node, no page fetch). Presence is a user preference: a toggle in
   settings ("I run ipfs-companion"), because reliable feature detection
   is not exposed by modern companion. Default off: interception wins by
   default since it works with no install.

Companion's own loopback gateway address should also be discoverable the
same way we probe kubo (127.0.0.1:8080 style defaults) so "open locally"
can prefer it — optional, defaults-listed.

## 2. Provider linking ("where is this CID available")

For any CID the app knows (published content, repo root, issues,
fetched content), show availability:

- **Providers** — the `providers` op (delegated routing, configured
  endpoints first) lists `{id, addrs}` per provider; rendered as "N
  provider(s)" with full values, and a `ipfs swarm connect <addr>` command
  per provider (one per line, per the command idiom) so a Kubo user can
  pull content directly.
- **Gateways** — resolved gateway list; each rendered as a full URL link
  (`<gateway>/ipfs/<cid>`), opening in a new tab.
- **ipfs:// link** — per section 1.

## 3. Remote pinning options

Extend the services registry `pinning` entries to optionally carry auth
(the Pinning Services API spec uses `Authorization: Bearer <token>`):

```json
{ "name": "pin.gnostr.org", "pinning": [{ "endpoint": "https://pin.gnostr.org/api", "token": "..." }] }
```

A bare string stays valid (endpoint, no token — public/self-hosted nodes
that don't require auth). Bridge ops:

- `pin.remote.list` — GET <endpoint>/pins against each configured service
- `pin.remote.add(cid, name?)` — POST <endpoint>/pins {cid, name}
- `pin.remote.remove(pinId)` — DELETE <endpoint>/pins/<id>

Per-CID UI affordance in gh-pages: "Pin to provider…" listing configured
services with results; in the TUI: `pin.remote.add <cid>` via the `:`
bar. Pinning is always user-initiated — never automatic.

Local Kubo pinning (`ipfs pin add`) already exists and stays the primary
durable-copy path; remote pinning is for availability when the user's
machine is off.

## Build order

1. Registry schema extension (token) + `pin.remote.*` bridge ops.
2. CID linkification in gh-pages: every rendered CID gets
   gateway/ipfs:///providers/pin affordances (the click interception
   already works via fetch).
3. `web+ipfs` protocol handler registration.
4. Companion preference toggle + native-link passthrough.

## Non-goals

- Running our own pinning service (any spec-compliant one plugs in).
- Auto-pinning on publish (user action only).
- Replacing companion; we complement it (interception is the no-install
  fallback, companion the native path).
