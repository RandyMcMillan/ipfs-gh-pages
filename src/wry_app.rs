use std::{
    error::Error,
    fs, io,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use muda::{
    accelerator::{Accelerator, Code, Modifiers, CMD_OR_CTRL},
    Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu,
};
#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd"
))]
use tao::platform::unix::WindowExtUnix;
#[cfg(target_os = "windows")]
use tao::platform::windows::{EventLoopBuilderExtWindows, WindowExtWindows};
use tao::{
    dpi::LogicalSize,
    event::{ElementState, Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder, EventLoopWindowTarget},
    keyboard::{Key, ModifiersState},
    window::{Window, WindowBuilder},
};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};
#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd"
))]
use wry::WebViewBuilderExtUnix;
use wry::{WebView, WebViewBuilder};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 8080;
// Fixed interop port (docs/interop.md): the GitHub Pages / npm dev surfaces
// probe http://127.0.0.1:5050/well-known/identity to detect the local app
// and adopt its identity. Fixed (not ephemeral) because other origins need
// a stable address.
const INTEROP_PORT: u16 = 5050;

use ipfs_gh_pages::cli::Cli;

enum UserEvent {
    MenuEvent(MenuEvent),
}

pub fn run(cli: &Cli) -> Result<(), Box<dyn Error>> {
    let app_source = app_source(cli)?;
    println!("Serving web UI at {}", app_source.url);
    spawn_interop_server();

    let mut event_loop_builder = EventLoopBuilder::<UserEvent>::with_user_event();

    let event_loop = event_loop_builder.build();
    let proxy = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some(move |event| {
        let _ = proxy.send_event(UserEvent::MenuEvent(event));
    }));

    let menu_bar = Menu::new();
    let app_menu = Submenu::new("ipfs-gh-pages", true);
    let about_item = MenuItem::new("About ipfs-gh-pages", true, None);
    // Platform-standard quit: Cmd+Q on macOS, Ctrl+Q on Windows/Linux
    // (muda's CMD_OR_CTRL is SUPER on mac, CONTROL elsewhere). Ctrl+C also
    // quits — terminal convention — but is handled as a raw key event in the
    // event loop below, so the menu shows a single Quit row.
    let quit_item = MenuItem::new(
        "Quit",
        true,
        Some(Accelerator::new(CMD_OR_CTRL, Code::KeyQ)),
    );
    app_menu
        .append_items(&[&about_item, &PredefinedMenuItem::separator(), &quit_item])
        .unwrap();
    menu_bar.append(&app_menu).unwrap();

    // Repo menu: native git interaction with the --repo checkout (or the
    // cwd). Full values on the clipboard, never elided.
    let repo_path: Option<PathBuf> = cli
        .repo
        .as_deref()
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok());
    let repo_menu = Submenu::new("Repo", true);
    let copy_repo_path_item = MenuItem::new("Copy Repo Path", true, None);
    let copy_branch_item = MenuItem::new("Copy Branch", true, None);
    let copy_commit_item = MenuItem::new("Copy Latest Commit", true, None);
    let copy_tag_item = MenuItem::new("Copy Latest Tag", true, None);
    let reveal_item = MenuItem::new("Open Repo Folder", true, None);
    let terminal_item = MenuItem::new("Open in Terminal", true, None);
    repo_menu
        .append_items(&[
            &copy_repo_path_item,
            &copy_branch_item,
            &copy_commit_item,
            &copy_tag_item,
            &PredefinedMenuItem::separator(),
            &reveal_item,
            &terminal_item,
        ])
        .unwrap();
    menu_bar.append(&repo_menu).unwrap();

    // IPFS menu: drive the in-page bridge (the same ops the TUI issues)
    // and copy the interop identity.
    let ipfs_menu = Submenu::new("IPFS", true);
    let publish_repo_item = MenuItem::new("Publish Repo to IPFS", true, None);
    let sync_issues_item = MenuItem::new("Sync Issues from IPNS", true, None);
    let detect_kubo_item = MenuItem::new("Detect Kubo", true, None);
    let copy_identity_item = MenuItem::new("Copy Interop Identity", true, None);
    ipfs_menu
        .append_items(&[
            &publish_repo_item,
            &sync_issues_item,
            &detect_kubo_item,
            &PredefinedMenuItem::separator(),
            &copy_identity_item,
        ])
        .unwrap();
    menu_bar.append(&ipfs_menu).unwrap();

    // View menu: page-level conveniences. DevTools/Reload are webview
    // calls (macOS/Windows implementations; harmless elsewhere).
    let view_menu = Submenu::new("View", true);
    let reload_item = MenuItem::new(
        "Reload",
        true,
        Some(Accelerator::new(CMD_OR_CTRL, Code::KeyR)),
    );
    let devtools_item = MenuItem::new(
        "Developer Tools",
        true,
        Some(Accelerator::new(CMD_OR_CTRL | Modifiers::SHIFT, Code::KeyI)),
    );
    view_menu
        .append_items(&[&reload_item, &devtools_item])
        .unwrap();
    menu_bar.append(&view_menu).unwrap();

    // Sized for the ratzilla TUI chrome (tabs + content + footer): big
    // enough for ~120x36 cells, small enough not to feel like a maximized
    // blank window on first launch.
    let mut window_builder = WindowBuilder::new()
        .with_title("ipfs-gh-pages")
        .with_inner_size(LogicalSize::new(1024.0, 720.0))
        .with_min_inner_size(LogicalSize::new(640.0, 420.0));
    if cli.systray {
        // Start hidden; the tray icon is the entry point.
        window_builder = window_builder.with_visible(false);
    }
    let window = window_builder.build(&event_loop)?;

    #[cfg(target_os = "windows")]
    unsafe {
        menu_bar.init_for_hwnd(window.hwnd() as _).unwrap();
    }
    #[cfg(any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd"
    ))]
    {
        menu_bar
            .init_for_gtk_window(window.gtk_window(), window.default_vbox())
            .unwrap();
    }
    #[cfg(target_os = "macos")]
    {
        menu_bar.init_for_nsapp();
    }

    let webview_builder = create_webview(&window)?.with_url(&app_source.url);
    // wry 0.55: the webview attaches to the tao window's GTK vbox on unix
    // (WebViewBuilderExtUnix::build_gtk — proper embedding + resize, works
    // on Wayland); elsewhere the generic HasWindowHandle build covers it.
    #[cfg(any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd"
    ))]
    let webview = {
        use wry::WebViewBuilderExtUnix;
        webview_builder.build_gtk(window.default_vbox().unwrap())?
    };
    #[cfg(not(any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd"
    )))]
    let webview = webview_builder.build(&window)?;

    // System tray: dedicated items (Show / Quit) that reuse the existing
    // MenuEvent handler. The TrayIcon must stay alive — it is moved into
    // the event loop closure.
    let tray_show_item = MenuItem::new("Show ipfs-gh-pages", true, None);
    let tray_quit_item = MenuItem::new("Quit", true, None);
    let _tray: Option<TrayIcon> = if cli.systray {
        let tray_menu = Menu::new();
        tray_menu.append_items(&[
            &tray_show_item,
            &PredefinedMenuItem::separator(),
            &tray_quit_item,
        ])?;
        Some(
            TrayIconBuilder::new()
                .with_menu(Box::new(tray_menu))
                .with_tooltip("ipfs-gh-pages")
                .with_icon(tray_icon()?)
                .build()?,
        )
    } else {
        None
    };

    let mut modifiers = ModifiersState::default();
    let mut about_window: Option<(Window, WebView)> = None;
    let systray_mode = cli.systray;

    event_loop.run(move |event, window_target, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::WindowEvent {
                event: WindowEvent::ModifiersChanged(state),
                ..
            } => modifiers = state,
            Event::WindowEvent {
                event: WindowEvent::KeyboardInput { event: key_event, .. },
                ..
            } if key_event.state == ElementState::Pressed
                && !key_event.repeat
                && modifiers.control_key()
                && matches!(&key_event.logical_key, Key::Character(c) if c.eq_ignore_ascii_case("c")) =>
            {
                stop_server(&app_source.server, control_flow);
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                window_id,
                ..
            } => {
                if about_window
                    .as_ref()
                    .is_some_and(|(window, _)| window.id() == window_id)
                {
                    about_window = None; // dropping the webview+window closes it
                } else if systray_mode {
                    // Hide to the tray; the app keeps running and serving.
                    window.set_visible(false);
                } else {
                    stop_server(&app_source.server, control_flow);
                }
            }
            Event::UserEvent(UserEvent::MenuEvent(event)) => {
                let id = event.id();
                if id == about_item.id() {
                    if about_window.is_none() {
                        match create_about_window(window_target) {
                            Ok(pair) => about_window = Some(pair),
                            Err(err) => eprintln!("failed to open About window: {err}"),
                        }
                    }
                } else if id == quit_item.id() || id == tray_quit_item.id() {
                    stop_server(&app_source.server, control_flow);
                } else if id == tray_show_item.id() {
                    window.set_visible(true);
                    window.set_focus();
                } else if id == copy_repo_path_item.id() {
                    if let Some(path) = &repo_path {
                        let _ = copy_to_clipboard(&path.display().to_string());
                    }
                } else if id == copy_branch_item.id() {
                    if let Some(branch) = git_output(&repo_path, &["branch", "--show-current"]) {
                        let _ = copy_to_clipboard(&branch);
                    }
                } else if id == copy_commit_item.id() {
                    if let Some(sha) = git_output(&repo_path, &["rev-parse", "HEAD"]) {
                        let _ = copy_to_clipboard(&sha);
                    }
                } else if id == copy_tag_item.id() {
                    match git_output(&repo_path, &["describe", "--tags", "--abbrev=0"]) {
                        Some(tag) => {
                            let _ = copy_to_clipboard(&tag);
                        }
                        None => eprintln!("menu: no git tags in the repo"),
                    }
                } else if id == reveal_item.id() {
                    if let Some(path) = &repo_path {
                        reveal_in_folder(path);
                    }
                } else if id == terminal_item.id() {
                    if let Some(path) = &repo_path {
                        open_in_terminal(path);
                    }
                } else if id == publish_repo_item.id() {
                    bridge_cmd(&webview, "repo.publishAll");
                } else if id == sync_issues_item.id() {
                    bridge_cmd(&webview, "issues.sync");
                } else if id == detect_kubo_item.id() {
                    bridge_cmd(&webview, "kuboDetect");
                } else if id == copy_identity_item.id() {
                    match fetch_interop_identity() {
                        Some(identity) => {
                            let _ = copy_to_clipboard(&identity);
                        }
                        None => eprintln!("menu: no interop identity published yet"),
                    }
                } else if id == reload_item.id() {
                    let _ = webview.reload();
                } else if id == devtools_item.id() {
                    webview.open_devtools();
                }
            }
            _ => {}
        }
    });
}

fn tray_icon() -> Result<Icon, Box<dyn Error>> {
    let img = image::load_from_memory(include_bytes!("../icons/icon.png"))?;
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    Ok(Icon::from_rgba(rgba.into_raw(), width, height)?)
}

// macOS-style About panel: small fixed window, wry webview rendering
// centered icon + name + version + credits. The icon ships in the repo
// (icons/icon.png, also the .icns source) and is embedded as a data URI so
// the panel needs no server route. One instance at a time; closing it drops
// the Option, which closes the window.
fn create_about_window(
    target: &EventLoopWindowTarget<UserEvent>,
) -> Result<(Window, WebView), Box<dyn Error>> {
    let window = WindowBuilder::new()
        .with_title(format!("About {}", env!("CARGO_PKG_NAME")))
        .with_inner_size(LogicalSize::new(420.0, 360.0))
        .with_min_inner_size(LogicalSize::new(300.0, 260.0))
        .with_resizable(true)
        .with_maximizable(false)
        .with_minimizable(false)
        .build(target)?;
    let webview = WebViewBuilder::new()
        .with_html(about_html())
        .build(&window)?;
    Ok((window, webview))
}

fn about_html() -> String {
    let version = env!("CARGO_PKG_VERSION");
    format!(
        r#"<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {{
    --bg: #f5f5f7;
    --fg: #1d1d1f;
    --fg-secondary: #6e6e73;
    --fg-tertiary: #86868b;
    --fg-credits: #48484a;
  }}
  @media (prefers-color-scheme: dark) {{
    :root {{
      --bg: #1c1c1e;
      --fg: #f2f2f7;
      --fg-secondary: #98989f;
      --fg-tertiary: #6e6e73;
      --fg-credits: #aeaeb2;
    }}
  }}
  body {{
    margin: 0; min-height: 100vh; box-sizing: border-box;
    padding: clamp(12px, 4vmin, 28px);
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    background: var(--bg); color: var(--fg); text-align: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }}
  img {{ width: clamp(56px, 18vmin, 96px); height: auto; border-radius: 22%;
         box-shadow: 0 4px 16px rgba(0,0,0,.18); margin-bottom: clamp(8px, 2vmin, 14px); }}
  h1 {{ font-size: clamp(16px, 4vmin, 22px); font-weight: 600; margin: 2px 0; }}
  .version {{ font-size: clamp(11px, 2.4vmin, 13px); color: var(--fg-secondary); margin-bottom: clamp(6px, 1.6vmin, 10px); }}
  .credits {{ font-size: clamp(11px, 2.2vmin, 12px); color: var(--fg-credits); line-height: 1.5; max-width: 40ch; }}
  .copy {{ font-size: clamp(10px, 2vmin, 11px); color: var(--fg-tertiary); margin-top: clamp(10px, 3vmin, 18px); }}
</style>
</head>
<body>
  <img src="data:image/png;base64,{icon}" alt="app icon">
  <h1>ipfs-gh-pages</h1>
  <div class="version">Version {version}</div>
  <div class="credits">
    A <b>Ratzilla</b> (ratatui-in-the-browser) TUI bundled as a native app by
    <b>wry</b>, with a <b>Helia</b> IPFS node running in the page.
  </div>
  <div class="copy">Copyright © 2026 the ipfs-gh-pages contributors. MIT License.</div>
</body>
</html>"#,
        icon = base64_encode(include_bytes!("../icons/icon.png")),
    )
}

/// Minimal RFC 4648 base64 (with padding) — just enough to data-URI the
/// About icon without pulling in a dependency.
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// Run git in `repo` (falling back to the current directory) and return
/// trimmed stdout on success. Native-side helper for the Repo menu.
fn git_output(repo: &Option<PathBuf>, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new("git");
    if let Some(dir) = repo {
        cmd.current_dir(dir);
    }
    let out = cmd.args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Copy text to the system clipboard using the platform's built-in tool
/// (no new dependencies). macOS pbcopy, Windows clip, Linux xclip/xsel.
fn copy_to_clipboard(text: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    const COMMANDS: &[&[&str]] = &[&["pbcopy"]];
    #[cfg(target_os = "windows")]
    const COMMANDS: &[&[&str]] = &[&["clip"]];
    #[cfg(all(
        unix,
        not(target_os = "macos"),
        not(target_os = "linux"),
        not(target_os = "dragonfly"),
        not(target_os = "freebsd"),
        not(target_os = "openbsd"),
        not(target_os = "netbsd")
    ))]
    const COMMANDS: &[&[&str]] = &[];
    #[cfg(any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd"
    ))]
    const COMMANDS: &[&[&str]] = &[
        &["xclip", "-selection", "clipboard"],
        &["xsel", "--clipboard", "--input"],
    ];
    for argv in COMMANDS {
        if argv.is_empty() {
            continue;
        }
        let mut child = match Command::new(argv[0])
            .args(&argv[1..])
            .stdin(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(_) => continue, // tool not installed — try the next one
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(text.as_bytes());
        }
        if child.wait().map(|s| s.success()).unwrap_or(false) {
            return Ok(());
        }
    }
    Err("no clipboard tool found".to_string())
}

/// GET the bridge-posted identity from the loopback interop server
/// (docs/interop.md). Returns the JSON body, or None when nothing has
/// been published yet.
fn fetch_interop_identity() -> Option<String> {
    let mut stream = TcpStream::connect((HOST, INTEROP_PORT)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    stream
        .write_all(
            b"GET /well-known/identity HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        )
        .ok()?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).ok()?;
    let text = String::from_utf8_lossy(&response);
    let (head, body) = text.split_once("\r\n\r\n")?;
    if head.contains("200 OK") {
        Some(body.trim().to_string())
    } else {
        None
    }
}

/// Open the repo directory in the platform file browser.
fn reveal_in_folder(path: &Path) {
    #[cfg(target_os = "macos")]
    let _ = Command::new("open").arg(path).spawn();
    #[cfg(target_os = "windows")]
    let _ = Command::new("explorer").arg(path).spawn();
    #[cfg(all(
        unix,
        not(target_os = "macos"),
        not(target_os = "linux"),
        not(target_os = "dragonfly"),
        not(target_os = "freebsd"),
        not(target_os = "openbsd"),
        not(target_os = "netbsd")
    ))]
    let _ = path;
    #[cfg(any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd"
    ))]
    let _ = Command::new("xdg-open").arg(path).spawn();
}

/// Open a terminal at the repo path (macOS Terminal.app; Linux tries the
/// common terminal emulators).
fn open_in_terminal(path: &Path) {
    #[cfg(target_os = "macos")]
    let _ = Command::new("open")
        .args(["-a", "Terminal"])
        .arg(path)
        .spawn();
    #[cfg(target_os = "windows")]
    let _ = Command::new("cmd")
        .args(["/c", "start", "cmd", "/K", "cd", "/D"])
        .arg(path)
        .spawn();
    #[cfg(all(
        unix,
        not(target_os = "macos"),
        not(target_os = "linux"),
        not(target_os = "dragonfly"),
        not(target_os = "freebsd"),
        not(target_os = "openbsd"),
        not(target_os = "netbsd")
    ))]
    let _ = path;
    #[cfg(any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "openbsd",
        target_os = "netbsd"
    ))]
    for term in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
        if Command::new(term)
            .arg("--working-directory")
            .arg(path)
            .spawn()
            .is_ok()
        {
            break;
        }
    }
}

/// Bridge the menu into the page: run a bridge op the same way the TUI
/// does (`window.__ipfsCmd`), letting the menu trigger publishes, syncs,
/// and Kubo detection without keyboard focus.
fn bridge_cmd(webview: &WebView, op: &str) {
    let script = format!(
        "window.__ipfsCmd && window.__ipfsCmd(Date.now(), '{}', {{}})",
        op.replace('\'', "")
    );
    if let Err(err) = webview.evaluate_script(&script) {
        eprintln!("menu: bridge op '{op}' failed: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_output_runs_in_the_crate_repository() {
        assert_eq!(
            git_output(&None, &["rev-parse", "--is-inside-work-tree"]),
            Some("true".to_string())
        );
        let head = git_output(&None, &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(head.len(), 40, "full SHA, never elided");
    }

    #[test]
    fn git_output_none_outside_a_repository() {
        // Temp dirs created by other tests are not git repos; use the
        // system temp dir root, which never is one.
        let dir = std::env::temp_dir();
        assert!(git_output(&Some(dir), &["rev-parse", "HEAD"]).is_none());
    }

    #[test]
    fn interop_response_parsing_splits_head_from_body() {
        let raw = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"peerId\":\"x\"}\n";
        let (head, body) = raw.split_once("\r\n\r\n").unwrap();
        assert!(head.contains("200 OK"));
        assert_eq!(body.trim(), "{\"peerId\":\"x\"}");
    }

    #[test]
    fn bridge_cmd_script_escapes_the_op_name() {
        // The op is always one of ours (a fixed literal), but the quoting
        // must survive regardless.
        let op = "repo.publishAll";
        let script = format!(
            "window.__ipfsCmd && window.__ipfsCmd(Date.now(), '{}', {{}})",
            op.replace('\'', "")
        );
        assert!(script.contains("'repo.publishAll'"));
    }
}

fn stop_server(server: &Arc<Mutex<Option<ServerHandle>>>, control_flow: &mut ControlFlow) {
    if let Some(handle) = server.lock().ok().and_then(|mut slot| slot.take()) {
        match handle {
            ServerHandle::Trunk(mut child) => {
                let _ = child.kill();
                let _ = child.wait();
            }
            ServerHandle::Bundled(server) => {
                server.stop();
            }
        }
    }
    *control_flow = ControlFlow::Exit;
}

fn spawn_trunk_serve() -> Result<Child, io::Error> {
    Command::new("trunk")
        .args([
            "serve",
            "--address",
            HOST,
            "--port",
            "8080",
            "--no-autoreload",
            "true",
            "--open",
            "false",
        ])
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
}

fn wait_for_server() -> Result<(), io::Error> {
    let addr: SocketAddr = format!("{HOST}:{PORT}").parse().map_err(|err| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("invalid address: {err}"),
        )
    })?;

    for _ in 0..120 {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(500));
    }

    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        "trunk serve did not start on 127.0.0.1:8080",
    ))
}

enum ServerHandle {
    Trunk(Child),
    Bundled(BundledServer),
}

struct BundledServer {
    shutdown: Arc<AtomicBool>,
    join: Mutex<Option<JoinHandle<()>>>,
}

impl BundledServer {
    fn stop(self) {
        self.shutdown.store(true, Ordering::SeqCst);
        if let Some(join) = self.join.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = join.join();
        }
    }
}

struct AppSource {
    url: String,
    server: Arc<Mutex<Option<ServerHandle>>>,
}

fn app_source(cli: &Cli) -> Result<AppSource, Box<dyn Error>> {
    // --url: no server at all, point the webview at an existing page
    // (e.g. a `trunk serve` dev instance).
    if let Some(url) = &cli.url {
        return Ok(AppSource {
            url: url.clone(),
            server: Arc::new(Mutex::new(None)),
        });
    }

    if let Some(index) = bundled_index_path(cli)? {
        let config_json = format!(
            "{{\"kubo\":{},\"repo\":{}}}",
            cli.kubo
                .as_deref()
                .map(json_str)
                .unwrap_or_else(|| "null".into()),
            cli.repo
                .as_deref()
                .map(json_str)
                .unwrap_or_else(|| "null".into()),
        );
        let (server, port) = spawn_bundled_server(
            index.parent().unwrap().to_path_buf(),
            &cli.host,
            cli.port,
            config_json,
        )?;
        return Ok(AppSource {
            url: format!("http://{}:{}", cli.host, port),
            server: Arc::new(Mutex::new(Some(ServerHandle::Bundled(server)))),
        });
    }
    let server = Arc::new(Mutex::new(Some(ServerHandle::Trunk(spawn_trunk_serve()?))));
    wait_for_server()?;

    Ok(AppSource {
        url: format!("http://{HOST}:{PORT}"),
        server,
    })
}

fn bundled_index_path(cli: &Cli) -> Result<Option<PathBuf>, io::Error> {
    if let Some(dir) = &cli.serve_dir {
        for name in ["index-rust.html", "index.html"] {
            let index = dir.join(name);
            if index.exists() {
                return Ok(Some(index));
            }
        }
        return Ok(None);
    }
    let exe = std::env::current_exe()?;
    let Some(contents_dir) = exe.parent().and_then(|p| p.parent()) else {
        return Ok(None);
    };
    for name in ["index-rust.html", "index.html"] {
        let index = contents_dir.join("Resources").join("dist").join(name);
        if index.exists() {
            return Ok(Some(index));
        }
    }
    Ok(None)
}

// ---- interop server (docs/interop.md) ----------------------------------------
//
// Loopback-only HTTP service on the fixed INTEROP_PORT. The bridge
// (js/ipfs-node.js) POSTs its identity bundle here after boot; any local
// origin (GitHub Pages app, npm dev) can then GET it and adopt the same
// Ed25519 identity. Loopback connections only, CORS-open — the same trust
// domain as the Kubo RPC API on port 5001.

fn spawn_interop_server() {
    let state: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let state_publish = Arc::clone(&state);

    thread::spawn(move || {
        let listener = match std::net::TcpListener::bind((HOST, INTEROP_PORT)) {
            Ok(l) => l,
            Err(err) => {
                eprintln!("interop server: cannot bind {HOST}:{INTEROP_PORT}: {err}");
                return;
            }
        };
        for stream in listener.incoming() {
            if let Ok(stream) = stream {
                let state = Arc::clone(&state_publish);
                thread::spawn(move || {
                    let _ = handle_interop_request(stream, &state);
                });
            }
        }
    });
}

fn handle_interop_request(
    mut stream: std::net::TcpStream,
    identity: &Arc<Mutex<Option<String>>>,
) -> Result<(), io::Error> {
    stream.set_nonblocking(false)?;

    // Loopback only: never answer to other interfaces.
    let peer_ip = stream
        .peer_addr()
        .map(|addr| addr.ip().to_string())
        .unwrap_or_default();
    if peer_ip != "127.0.0.1" && peer_ip != "::1" {
        write_response(
            &mut stream,
            "403 Forbidden",
            "text/plain; charset=utf-8",
            b"loopback only",
        )?;
        return Ok(());
    }

    let mut buffer = vec![0_u8; 65536];
    let bytes_read = stream.read(&mut buffer)?;
    let request = String::from_utf8_lossy(&buffer[..bytes_read]);
    let mut lines = request.lines();
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("/");
    // Headers end at a blank line; the body follows.
    let body = request.split("\r\n\r\n").nth(1).unwrap_or("").to_string();

    let cors = [
        "Access-Control-Allow-Origin: *",
        "Access-Control-Allow-Methods: GET, POST, OPTIONS",
        "Access-Control-Allow-Headers: content-type",
    ];

    match (method, path.split('?').next().unwrap_or("/")) {
        ("OPTIONS", _) => {
            write_response_with_headers(&mut stream, "204 No Content", "text/plain", b"", &cors)?;
        }
        ("POST", "/publish") => {
            if body.trim().is_empty() {
                write_response_with_headers(
                    &mut stream,
                    "400 Bad Request",
                    "text/plain; charset=utf-8",
                    b"empty body",
                    &cors,
                )?;
            } else {
                if let Ok(mut slot) = identity.lock() {
                    *slot = Some(body.trim().to_string());
                }
                write_response_with_headers(
                    &mut stream,
                    "200 OK",
                    "application/json",
                    b"{\"ok\":true}",
                    &cors,
                )?;
            }
        }
        ("GET", "/well-known/identity") => {
            let snapshot = identity.lock().ok().and_then(|slot| slot.clone());
            match snapshot {
                Some(json) => write_response_with_headers(
                    &mut stream,
                    "200 OK",
                    "application/json; charset=utf-8",
                    json.as_bytes(),
                    &cors,
                )?,
                None => write_response_with_headers(
                    &mut stream,
                    "404 Not Found",
                    "text/plain; charset=utf-8",
                    b"no identity published yet",
                    &cors,
                )?,
            }
        }
        _ => write_response_with_headers(
            &mut stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"Not Found",
            &cors,
        )?,
    }
    Ok(())
}

fn write_response_with_headers(
    stream: &mut std::net::TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
    extra_headers: &[&str],
) -> Result<(), io::Error> {
    let mut head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for header in extra_headers {
        head.push_str(header);
        head.push_str("\r\n");
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    Ok(())
}

fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    format!("\"{out}\"")
}

fn spawn_bundled_server(
    dist_root: PathBuf,
    host: &str,
    port: u16,
    config_json: String,
) -> Result<(BundledServer, u16), io::Error> {
    // Port 0: let the OS pick a free port so the desktop app never fights
    // trunk serve, vite, or anything else for 8080.
    let listener = std::net::TcpListener::bind((host, port))?;
    let bound_port = listener.local_addr()?.port();
    listener.set_nonblocking(true)?;

    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown_flag = Arc::clone(&shutdown);
    let join = thread::spawn(move || {
        while !shutdown_flag.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let _ = handle_http_request(stream, &dist_root, &config_json);
                }
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(20));
                }
                Err(_) => break,
            }
        }
    });

    Ok((
        BundledServer {
            shutdown,
            join: Mutex::new(Some(join)),
        },
        bound_port,
    ))
}

fn handle_http_request(
    mut stream: std::net::TcpStream,
    dist_root: &PathBuf,
    config_json: &str,
) -> Result<(), io::Error> {
    stream.set_nonblocking(false)?;
    let mut buffer = [0_u8; 4096];
    let bytes_read = stream.read(&mut buffer)?;
    let request = String::from_utf8_lossy(&buffer[..bytes_read]);
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/");

    let clean_path = path.split('?').next().unwrap_or("/");
    // CLI config for the JS bridge (--kubo / --repo). Served at both path
    // spellings so a trunk-style './assets/' relative fetch also resolves.
    if clean_path == "/config.json" || clean_path == "/assets/config.json" {
        write_response(
            &mut stream,
            "200 OK",
            "application/json; charset=utf-8",
            config_json.as_bytes(),
        )?;
        return Ok(());
    }

    let file_path = match clean_path {
        "/" | "/index.html" | "/index-rust.html" => dist_root.join("index-rust.html"),
        other => safe_dist_path(dist_root, other),
    };

    if file_path.is_file() {
        let body = fs::read(&file_path)?;
        let content_type = content_type(&file_path);
        write_response(&mut stream, "200 OK", content_type, &body)?;
    } else {
        write_response(
            &mut stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"Not Found",
        )?;
    }

    Ok(())
}

fn safe_dist_path(dist_root: &PathBuf, request_path: &str) -> PathBuf {
    let mut path = PathBuf::new();
    for component in Path::new(request_path).components() {
        use std::path::Component;
        match component {
            Component::Normal(part) => path.push(part),
            Component::CurDir | Component::RootDir => {}
            _ => return dist_root.join("__invalid__"),
        }
    }
    dist_root.join(path)
}

fn content_type(path: &PathBuf) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "wasm" => "application/wasm",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

fn write_response(
    stream: &mut std::net::TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
) -> Result<(), io::Error> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)?;
    Ok(())
}

// wry 0.55: one constructor on every platform — WebViewBuilder::new().
// (The old WebViewBuilder::new_gtk(vbox) constructor is gone; unix
// attachment moved to WebViewBuilderExtUnix::build_gtk at build time,
// which the call site does per-platform.)
fn create_webview(_window: &Window) -> Result<wry::WebViewBuilder<'_>, wry::Error> {
    Ok(WebViewBuilder::new())
}
