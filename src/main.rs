#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! # [Ratatui] Ratzilla Bundle Wry Example
//!
//! Three cfg-gated build modes from ONE crate:
//!
//! 1. `wasm32, no bundle-wry` (trunk/`trunk serve`): the ratzilla browser
//!    TUI in `browser_main` below. This is what `index-rust.html` loads.
//! 2. `bundle-wry` feature (any host): the desktop app — `wry_app::run()`
//!    opens a native webview pointed at a local server; in the bundled .app
//!    that server serves `Resources/dist` (see src/wry_app.rs). Without
//!    Resources/dist it falls back to spawning `trunk serve`.
//! 3. native, no feature: stub — prints a hint. Nothing to run.
//!
//! ## Ratzilla draw-loop contract (do not break)
//!
//! - `terminal.draw_web(closure)` drives the closure EVERY animation frame
//!   (requestAnimationFrame). The closure borrows `App` mutably, calls
//!   `on_tick()` (which advances demo data per frame — progress, sparkline,
//!   sine signals, rotating log/event lists — and returns elapsed ms), then
//!   `ui::draw(elapsed, frame, app)` renders, then tachyonfx effects are
//!   processed with the same elapsed. State advances at DISPLAY REFRESH
//!   RATE, not on a fixed timer.
//! - `terminal.on_key_event(...)`: arrows = tab/task navigation, `q` sets
//!   `should_quit` (unreachable in the browser loop — kept for parity),
//!   `t` toggles the chart.
//! - Backend selection: `MultiBackendBuilder::with_fallback(WebGl2)` in
//!   src/backend.rs, overridable with `?backend=dom|canvas|webgl2`. The
//!   builder INJECTS A FIXED FOOTER into <body> (src/utils.rs): IPFS
//!   connection status on the left (#ratzilla-ipfs-status, written by
//!   js/ipfs-node.js), backend links + FPS on the right, z-index 1000,
//!   bottom: 0. index-rust.html carries no status bar of its own.
//! - Canvas sizing: `disable_auto_css_resize()` means the CSS in
//!   index-rust.html owns the canvas size (`canvas { width: calc(100vw -
//!   40px); height: 100% }`, 20px body margins).

#[cfg(feature = "bundle-wry")]
mod wry_app;

#[cfg(any(
    feature = "bundle-wry",
    all(not(feature = "bundle-wry"), target_arch = "wasm32")
))]
use std::error::Error;

#[cfg(all(not(feature = "bundle-wry"), target_arch = "wasm32"))]
use std::{cell::RefCell, rc::Rc};

#[cfg(all(not(feature = "bundle-wry"), target_arch = "wasm32"))]
use ipfs_gh_pages::app::App;
#[cfg(all(not(feature = "bundle-wry"), target_arch = "wasm32"))]
use ipfs_gh_pages::backend::{BackendType, MultiBackendBuilder};
#[cfg(all(not(feature = "bundle-wry"), target_arch = "wasm32"))]
use ratzilla::backend::webgl2::WebGl2BackendOptions;
#[cfg(all(not(feature = "bundle-wry"), target_arch = "wasm32"))]
use ratzilla::event::KeyCode;
#[cfg(all(not(feature = "bundle-wry"), target_arch = "wasm32"))]
use ratzilla::WebRenderer;

#[cfg(all(not(feature = "bundle-wry"), target_arch = "wasm32"))]
fn main() -> Result<(), Box<dyn Error>> {
    browser_main()
}

#[cfg(all(not(feature = "bundle-wry"), target_arch = "wasm32"))]
fn browser_main() -> Result<(), Box<dyn Error>> {
    let app_state = Rc::new(RefCell::new(App::new("Demo", true)));

    let webgl2_options = WebGl2BackendOptions::new()
        .measure_performance(true)
        .enable_console_debug_api()
        .enable_mouse_selection()
        .disable_auto_css_resize(); // canvas size managed by css in index.html

    let mut terminal = MultiBackendBuilder::with_fallback(BackendType::WebGl2)
        .webgl2_options(webgl2_options)
        .build_terminal()?;

    terminal.on_key_event({
        let app_state_cloned = app_state.clone();
        move |event| {
            let mut app_state = app_state_cloned.borrow_mut();
            match event.code {
                KeyCode::Right => {
                    app_state.on_right();
                }
                KeyCode::Left => {
                    app_state.on_left();
                }
                KeyCode::Up => {
                    app_state.on_up();
                }
                KeyCode::Down => {
                    app_state.on_down();
                }
                KeyCode::Char(c) => app_state.on_key(c),
                _ => {}
            }
        }
    })?;

    terminal.draw_web(move |f| {
        let mut app_state = app_state.borrow_mut();
        let elapsed = app_state.on_tick();
        ipfs_gh_pages::ui::draw(elapsed, f, &mut app_state);
    });

    Ok(())
}

#[cfg(feature = "bundle-wry")]
fn main() -> Result<(), Box<dyn Error>> {
    wry_app::run()
}

#[cfg(all(not(feature = "bundle-wry"), not(target_arch = "wasm32")))]
fn main() {
    println!(
        "ipfs-gh-pages's browser entrypoint is for wasm32.\n\
         Run `trunk serve` or `trunk build` for the Ratzilla web app."
    );
}
