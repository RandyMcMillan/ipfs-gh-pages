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
    accelerator::{Accelerator, Code, CMD_OR_CTRL},
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

use ipfs_gh_pages::cli::Cli;

enum UserEvent {
    MenuEvent(MenuEvent),
}

pub fn run(cli: &Cli) -> Result<(), Box<dyn Error>> {
    let app_source = app_source(cli)?;
    println!("Serving web UI at {}", app_source.url);

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
        Some(Accelerator::new(Some(CMD_OR_CTRL), Code::KeyQ)),
    );
    app_menu
        .append_items(&[&about_item, &PredefinedMenuItem::separator(), &quit_item])
        .unwrap();
    menu_bar.append(&app_menu).unwrap();

    let window = WindowBuilder::new()
        .with_title("ipfs-gh-pages")
        .build(&event_loop)?;

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

    let _webview = create_webview(&window)?
        .with_url(&app_source.url)
        .build(&window)?;

    let mut modifiers = ModifiersState::default();
    let mut about_window: Option<(Window, WebView)> = None;

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
                } else {
                    stop_server(&app_source.server, control_flow);
                }
            }
            Event::UserEvent(UserEvent::MenuEvent(event)) => {
                if event.id() == about_item.id() {
                    if about_window.is_none() {
                        match create_about_window(window_target) {
                            Ok(pair) => about_window = Some(pair),
                            Err(err) => eprintln!("failed to open About window: {err}"),
                        }
                    }
                } else if event.id() == quit_item.id() {
                    stop_server(&app_source.server, control_flow);
                }
            }
            _ => {}
        }
    });
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

#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd"
))]
fn create_webview(_window: &Window) -> Result<wry::WebViewBuilder<'_>, wry::Error> {
    Ok(WebViewBuilder::new_gtk(window.default_vbox().unwrap()))
}

#[cfg(not(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd"
)))]
fn create_webview(_window: &Window) -> Result<wry::WebViewBuilder<'_>, wry::Error> {
    Ok(WebViewBuilder::new())
}
