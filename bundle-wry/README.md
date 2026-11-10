# bundle-wry

Ratzilla (ratatui-on-WASM) example bundling a desktop shell via wry/tao,
refactored in from the ratzilla examples tree
(`examples/bundle-wry`, upstream: https://github.com/ratzilla/ratzilla).

- Upstream license: MIT OR Apache-2.0 (as published by the ratzilla project).
- Web build: `trunk serve` in this directory (targets wasm32-unknown-unknown).
- Desktop build: `cargo run --features bundle-wry` (native; pulls tao/wry/muda).
- The root crate (`ipfs-gh-pages`) is a CID utility; both share this workspace.
