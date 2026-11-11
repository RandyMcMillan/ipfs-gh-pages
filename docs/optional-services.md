# Design constraint: optional service endpoints, decentralized core

Status: binding constraint on all plans (bridge, git-over-ipfs, app).

## The rule

The protocol must work with **zero configured services**. Bootstrap,
peer discovery, advertisement, clone, fetch, and publish all function on
the public libp2p infrastructure alone:

- bootstrap via `bootstrap.libp2p.io` (or any configured set),
- peer/provider discovery via gossipsub `repo-gossip:<repo>` and public
  delegated routing,
- transport via direct dials + relayed circuit,
- identity via locally generated keys (P7 scheme).

Specific IPFS services — example deployments like `gnostr.org`,
`gnostr.cloud` — are **opt-in accelerants, never dependencies**. The app
must never fail, degrade into a broken state, or lose functionality
because a configured service is down, absent, or removed.

## Service registry (config schema)

Stored in localStorage (`ipfs-services`), empty by default, editable via
`__ipfsCmd('services.set', [...])` (bridge plan) and eventually a TUI
settings tab:

```json
[
  {
    "name": "gnostr.org",
    "gateways": ["https://ipfs.gnostr.org"],
    "delegatedRouting": ["https://routing.gnostr.org"],
    "pinning": ["https://pin.gnostr.org/api"],
    "bootstrap": ["/dns4/gnostr.org/udp/4001/quic-v1/p2p/<peer>"],
    "git": ["gnostr.org"] 
  }
]
```

All fields optional per service; unknown fields ignored; a service with
no reachable endpoint is skipped, never fatal.

Pinata fits the same shape — its JWT-auth endpoints drop into the
`pinning` registry (`{ "endpoint": "https://api.pinata.cloud/psa/pins",
"token": "<jwt>" }`), and the action's `pinata-jwt` input is the
repo-secret path to the same capability (server-side, token never in
the page).

## Resolution order (per capability)

1. Configured services, in user order (first success wins).
2. Public defaults, always present as fallback:
   gateway `https://ipfs.io`, delegated routing
   `https://delegated-ipfs.dev`, public bootstrap peers.

Capability behavior when EVERYTHING fails must remain the p2p path:
gossip advertisement + direct dial. A service answer is an optimization;
the network is the source of truth.

## Consequences

- No hardcoded third-party service anywhere in the core paths
  (`delegated-ipfs.dev` and friends live in the defaults list, not in
  call sites).
- Clone entry points (git-over-ipfs): stable address comes from IPNS /
  the branch-pointer scheme; services may mirror or front the content
  but the clone cannot require them.
- UI copy must never imply a service is required ("optional mirror",
  "accelerator", never "needed to").
