//! CLI for the native binaries (desktop app and the native stub). Not
//! compiled for wasm32 — the browser entrypoint takes no arguments.

use std::path::PathBuf;

use clap::Parser;

#[derive(Parser, Debug)]
#[command(
    name = "ipfs-gh-pages",
    version,
    about = "Ratzilla TUI + Helia IPFS node, bundled as a native desktop app"
)]
pub struct Cli {
    /// Host/interface the embedded web UI server binds to
    #[arg(long, default_value = "127.0.0.1")]
    pub host: String,

    /// Port for the embedded web UI server (0 = OS-assigned ephemeral port)
    #[arg(long, default_value = "0")]
    pub port: u16,

    /// Serve this directory (must contain index-rust.html or index.html)
    /// instead of the bundled Resources/dist
    #[arg(long, value_name = "DIR")]
    pub serve_dir: Option<PathBuf>,

    /// Point the webview at this URL instead of starting the embedded
    /// server (e.g. a `trunk serve` dev instance)
    #[arg(long, value_name = "URL")]
    pub url: Option<String>,

    /// Kubo RPC API endpoint (e.g. http://127.0.0.1:5001). When set, the
    /// bridge uses it instead of probing ports 5001-5010.
    #[arg(long, value_name = "URL")]
    pub kubo: Option<String>,

    /// Path of the git repo this app represents — recorded in serve
    /// envelopes so peers know which working tree a node serves
    #[arg(long, value_name = "PATH")]
    pub repo: Option<String>,
}
