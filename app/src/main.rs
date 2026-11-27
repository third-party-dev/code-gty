//! gty: code-gty's terminal as a desktop app.
//!
//! The window shows the extension's own terminal page in the system web view
//! (WebKitGTK, WKWebView or WebView2), and the page runs the extension's own
//! session code (extension/native/). Shells live in the sidecar daemon, the
//! same one VS Code uses, which is this binary run as `gty --server`. So the
//! terminal behaves the same in both, and sessions are shared.
//!
//!   page (WebSocket) --> bridge --> daemon socket --> PTYs
//!   page (window.ipc) --> here: title, clipboard, links, notifications, close
//!
//! With `--browser`, `gty.viewer: "browser"`, or (Windows) no WebView2, the
//! page is shown in a web browser instead (gty_sidecar::native::browser).

// A GUI program on Windows: no console window when started from Explorer.
#![cfg_attr(windows, windows_subsystem = "windows")]

mod assets;
mod clipboard;
#[cfg(all(windows, target_env = "gnu"))]
mod webview2_loader;

use gty_sidecar::native::{boot, bridge, browser, Viewer};
use serde::Deserialize;
use std::borrow::Cow;
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
    /// Browser mode only (sessions to end when the page is gone).
    Session {},
}

enum UserEvent {
    Page(FromPage),
    /// The clipboard's text, for the page's ClipboardRead `id`.
    ClipboardText { id: u64, text: String },
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
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        // The session daemon, and the sidecar's other modes.
        Some("--server") | Some("--selftest") => std::process::exit(gty_sidecar::run_cli(&args)),
        Some("--version") => {
            println!("gty {VERSION} (sidecar {})", gty_sidecar::BUILD_ID);
            return;
        }
        _ => {}
    }
    if let Err(e) = assets::load() {
        eprintln!("gty: {e}");
        std::process::exit(1);
    }
    // The system web view, or a web browser (PLAN-browser-support.md).
    let settings = boot::read_settings(&boot::settings_file());
    let (viewer, browser_path) = match boot::viewer(&mut args, &settings) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("gty: {e}");
            std::process::exit(2);
        }
    };
    if let Some(other) = args.first() {
        eprintln!("usage: gty [--browser[=PATH] | --webview | --version]  (unknown argument {other:?})");
        std::process::exit(2);
    }
    let in_browser = match viewer {
        Viewer::Browser => true,
        Viewer::WebView => false,
        Viewer::Auto => !webview_available(),
    };
    if in_browser {
        std::process::exit(browser::run(VERSION, &assets::ASSETS, browser_path));
    }
    if let Err(e) = run() {
        eprintln!("gty: {e}");
        std::process::exit(1);
    }
}

/// Whether the system web view can be used. Linux and macOS: always, as this
/// binary started (WebKitGTK is linked; WKWebView is part of macOS). Windows:
/// when the WebView2 runtime is installed; GTY_TEST_NO_WEBVIEW2 pretends it
/// is not (for testing the fallback on machines that have it).
fn webview_available() -> bool {
    #[cfg(windows)]
    {
        if std::env::var_os("GTY_TEST_NO_WEBVIEW2").is_some() {
            eprintln!("[gty] GTY_TEST_NO_WEBVIEW2: as if WebView2 were missing");
            return false;
        }
        #[cfg(target_env = "gnu")]
        webview2_loader::set_dir(boot::unpacked_dir(VERSION));
        #[cfg(target_env = "gnu")]
        if !webview2_loader::runtime_available() {
            eprintln!("gty: the WebView2 runtime is not installed; showing the terminal in a web browser instead.");
            eprintln!("gty: install WebView2 from https://developer.microsoft.com/microsoft-edge/webview2/ for gty's own window");
            return false;
        }
    }
    true
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    // The daemon gets libghostty-vt and the shells their integration
    // scripts, unpacked next to its socket (private to this user).
    let prepared = boot::prepare(VERSION, &assets::ASSETS)?;
    #[cfg(all(windows, target_env = "gnu"))]
    webview2_loader::set_dir(prepared.unpacked.clone());
    let bridge = bridge::start(prepared.daemon.clone())?;
    let boot_data = boot::boot(&bridge.url, VERSION, &prepared.shell_integration, boot::Mode::WebView);
    // JSON is valid JavaScript, so this cannot inject anything.
    let init = format!("window.__GTY_BOOT__ = {boot_data};");

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
    let clipboard_proxy = proxy.clone();
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

    let mut clipboard = clipboard::Clipboard::new();
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
                FromPage::Open { url } => boot::open_url(&url),
                FromPage::ClipboardWrite { text } => clipboard.set_text(&text),
                FromPage::ClipboardRead { id } => {
                    let proxy = clipboard_proxy.clone();
                    clipboard.read_text(move |text| {
                        let _ = proxy.send_event(UserEvent::ClipboardText { id, text });
                    });
                }
                FromPage::Notify { title, body } => boot::notify(&title, &body),
                FromPage::Log { level, message } => eprintln!("[gty {level}] {message}"),
                FromPage::Quit => *control_flow = ControlFlow::Exit,
                FromPage::Session {} => {}
            },
            Event::UserEvent(UserEvent::ClipboardText { id, text }) => {
                send(&webview, serde_json::json!({ "type": "reply", "id": id, "value": text }));
            }
            _ => {}
        }
    });
}
