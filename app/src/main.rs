//! gty: code-gty's terminal as a desktop app.
//!
//! The window shows the extension's own terminal page in the system web view
//! (WebKitGTK, WKWebView or WebView2), and the page runs the extension's own
//! session code (extension/native/). Shells live in the sidecar daemon, the
//! same one VS Code uses, which is this binary run as `gty --server`. So the
//! terminal behaves the same in both, and sessions are shared.
//!
//!   page (WebSocket) --> bridge.rs --> daemon socket --> PTYs
//!   page (window.ipc) --> here: title, clipboard, links, notifications, close

mod assets;
mod bridge;
mod daemon;

use serde::Deserialize;
use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::window::WindowBuilder;
use wry::http::{header::CONTENT_TYPE, Request, Response, StatusCode};
use wry::WebViewBuilder;

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// From the page (native/ipc.ts).
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum FromPage {
    Title { title: String },
    Open { url: String },
    ClipboardWrite { text: String },
    ClipboardRead { id: u64 },
    Notify { title: String, body: String },
    Log { level: String, message: String },
    Quit,
}

enum UserEvent {
    Page(FromPage),
}

fn main() {
    // The launcher runs this from memory (/proc/self/fd/N), and the daemon
    // is started as /proc/self/exe, so the kernel would name the process
    // "3" or "exe" in ps and top.
    #[cfg(target_os = "linux")]
    // SAFETY: PR_SET_NAME reads a NUL-terminated string of up to 16 bytes.
    unsafe {
        libc::prctl(libc::PR_SET_NAME, c"gty".as_ptr());
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        // The session daemon, and the sidecar's other modes.
        Some("--server") | Some("--selftest") => std::process::exit(gty_sidecar::run_cli(&args)),
        Some("--version") => {
            println!("gty {VERSION} (sidecar {})", gty_sidecar::BUILD_ID);
            return;
        }
        Some(other) => {
            eprintln!("usage: gty [--version]  (unknown argument {other:?})");
            std::process::exit(2);
        }
        None => {}
    }
    if let Err(e) = run() {
        eprintln!("gty: {e}");
        std::process::exit(1);
    }
}

/// `$XDG_CONFIG_HOME/code-gty/settings.json` (or the platform's config dir):
/// VS Code's setting keys, e.g. {"terminal.integrated.fontSize": 15}.
fn settings_file() -> PathBuf {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")));
    base.unwrap_or_else(std::env::temp_dir).join("code-gty").join("settings.json")
}

fn read_settings(path: &PathBuf) -> serde_json::Value {
    match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(v @ serde_json::Value::Object(_)) => v,
            Ok(_) | Err(_) => {
                eprintln!("[gty] {} is not a JSON object; using the defaults", path.display());
                serde_json::json!({})
            }
        },
        Err(_) => serde_json::json!({}),
    }
}

fn login_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".into())
    }
    #[cfg(unix)]
    {
        std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into())
    }
}

fn os_names() -> (&'static str, &'static str) {
    if cfg!(target_os = "macos") {
        ("mac", "darwin")
    } else if cfg!(windows) {
        ("windows", "win32")
    } else {
        ("linux", "linux")
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    // The daemon gets libghostty-vt and the shells their integration scripts,
    // unpacked next to its socket (private to this user).
    let dir = daemon::default_dir();
    daemon::private_dir(&dir)?;
    let unpacked = dir.join(format!("gty-{VERSION}-{}", gty_sidecar::BUILD_ID));
    let vt = unpacked.join("ghostty-vt.wasm");
    daemon::write_once(&vt, assets::VT_WASM)?;
    let shell_integration = unpacked.join("shell-integration");
    for (name, data) in assets::SHELL_INTEGRATION {
        daemon::write_once(&shell_integration.join(name), data)?;
    }
    let daemon = Arc::new(daemon::Daemon { dir, vt });
    // Start it now, so the page does not wait for it.
    drop(daemon.connect()?);
    let bridge = bridge::start(daemon)?;

    let settings_path = settings_file();
    let (os, node_platform) = os_names();
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    let env: serde_json::Map<String, serde_json::Value> = std::env::vars().map(|(k, v)| (k, v.into())).collect();
    let boot = serde_json::json!({
        "ws": bridge.url,
        "version": VERSION,
        "os": os,
        "nodePlatform": node_platform,
        "env": env,
        "home": home,
        "shell": login_shell(),
        "shellIntegrationDir": shell_integration,
        "settings": read_settings(&settings_path),
        "settingsFile": settings_path,
    });
    // JSON is valid JavaScript, so this cannot inject anything.
    let init = format!("window.__GTY_BOOT__ = {boot};");

    // GLib names the program (and WebKit its cache, ~/.cache/<name>) after
    // argv[0], which the launcher's cached copy has as "gty-<build hash>".
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        extern "C" {
            fn g_set_prgname(name: *const std::ffi::c_char);
        }
        // SAFETY: GLib copies the string; called before GTK starts.
        unsafe { g_set_prgname(c"gty".as_ptr()) };
    }
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy: EventLoopProxy<UserEvent> = event_loop.create_proxy();
    let window = WindowBuilder::new()
        .with_title("Ghostty")
        .with_inner_size(tao::dpi::LogicalSize::new(960.0, 600.0))
        .build(&event_loop)?;

    let builder = WebViewBuilder::new()
        .with_custom_protocol("gty".into(), |_id, req: Request<Vec<u8>>| {
            match assets::get(req.uri().path()) {
                Some(a) => Response::builder().header(CONTENT_TYPE, a.mime).body(Cow::Borrowed(a.bytes)),
                None => Response::builder().status(StatusCode::NOT_FOUND).body(Cow::Borrowed(&b""[..])),
            }
            .expect("response")
        })
        .with_initialization_script(init)
        .with_ipc_handler(move |req: Request<String>| match serde_json::from_str::<FromPage>(req.body()) {
            Ok(m) => {
                let _ = proxy.send_event(UserEvent::Page(m));
            }
            Err(e) => eprintln!("[gty] bad message from the page: {e}"),
        })
        .with_devtools(std::env::var_os("GTY_DEVTOOLS").is_some())
        .with_url("gty://localhost/index.html");

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    let webview = builder.build(&window)?;
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        builder.build_gtk(window.default_vbox().ok_or("no GTK container")?)?
    };

    let mut clipboard = arboard::Clipboard::new().map_err(|e| eprintln!("[gty] no clipboard: {e}")).ok();
    let mut close_asked: Option<Instant> = None;
    let send = move |webview: &wry::WebView, event: serde_json::Value| {
        let _ = webview.evaluate_script(&format!("window.__gtyEvent && window.__gtyEvent({event})"));
    };

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                // The page closes its session first (and may ask to confirm,
                // as VS Code does). Asking twice quickly closes regardless, in
                // case the page cannot answer.
                if close_asked.is_some_and(|t| t.elapsed() < Duration::from_secs(2)) {
                    *control_flow = ControlFlow::Exit;
                    return;
                }
                close_asked = Some(Instant::now());
                send(&webview, serde_json::json!({ "type": "close" }));
            }
            Event::UserEvent(UserEvent::Page(m)) => match m {
                FromPage::Title { title } => window.set_title(&title),
                FromPage::Open { url } => open_url(&url),
                FromPage::ClipboardWrite { text } => {
                    if let Some(c) = clipboard.as_mut() {
                        if let Err(e) = c.set_text(text) {
                            eprintln!("[gty] clipboard: {e}");
                        }
                    }
                }
                FromPage::ClipboardRead { id } => {
                    let text = clipboard.as_mut().and_then(|c| c.get_text().ok()).unwrap_or_default();
                    send(&webview, serde_json::json!({ "type": "reply", "id": id, "value": text }));
                }
                FromPage::Notify { title, body } => notify(&title, &body),
                FromPage::Log { level, message } => eprintln!("[gty {level}] {message}"),
                FromPage::Quit => *control_flow = ControlFlow::Exit,
            },
            _ => {}
        }
    });
}

/// Web links only (the page checks too): anything else could open files or run handlers.
fn open_url(url: &str) {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) || url.chars().any(|c| c.is_control()) {
        return;
    }
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(url).spawn();
    #[cfg(windows)]
    let r = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(url).spawn();
    if let Err(e) = r {
        eprintln!("[gty] could not open {url}: {e}");
    }
}

/// A desktop notification, where there is a notifier (best effort).
fn notify(title: &str, body: &str) {
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("notify-send").args(["--app-name=Ghostty", "--", title, body]).spawn();
    }
    #[cfg(not(all(unix, not(target_os = "macos"))))]
    {
        let _ = (title, body);
    }
}
