//! Browser mode: the terminal page in a web browser instead of the system
//! web view (PLAN-browser-support.md). An HTTP server on 127.0.0.1 serves
//! the page (the same files as the app), its start-up data (/boot.json), the
//! daemon bridge (/ws) and the page's messages (/ipc: clipboard, links,
//! notifications), then the user's browser is started on it.
//!
//! It ends a few seconds after the last page has gone (a reload comes back
//! within that time and reattaches), or at once when the page says its
//! session has ended (whether or not the browser let the page close its
//! window). Sessions that pages left behind (a closed window) are
//! ended then, as closing a terminal's window ends its shell.

use super::boot::{self, Assets, Mode};
use super::bridge;
use super::http::{self, Replay, Route};
use super::launch;
use serde::Deserialize;
use std::collections::BTreeSet;
use std::io::{self, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tungstenite::Message;

/// How long after the last page has gone before ending (a reload is quicker).
const GRACE: Duration = Duration::from_secs(5);
/// How long the browser may take to open the page the first time.
const FIRST_PAGE: Duration = Duration::from_secs(120);

/// From the page (native/ipc.ts), as in the app.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum FromPage {
    Title {},
    Open { url: String },
    ClipboardWrite { text: String },
    ClipboardRead { id: u64 },
    Notify { title: String, body: String },
    Log { level: String, message: String },
    Quit,
    /// The page's session (to end it when no page is left).
    Session { id: u32 },
}

#[derive(Default)]
struct Pages {
    open: usize,
    ever: bool,
    /// A page said its session has ended: done, at once.
    quit: bool,
    since_empty: Option<Instant>,
    sessions: BTreeSet<u32>,
}

#[derive(Default)]
struct Life {
    pages: Mutex<Pages>,
    changed: Condvar,
}

impl Life {
    fn opened(&self) {
        let mut p = self.pages.lock().unwrap();
        p.open += 1;
        p.ever = true;
        p.quit = false;
        p.since_empty = None;
        self.changed.notify_all();
    }
    fn closed(&self) {
        let mut p = self.pages.lock().unwrap();
        p.open -= 1;
        if p.open == 0 {
            p.since_empty = Some(Instant::now());
        }
        self.changed.notify_all();
    }
}

/// The program's clipboard (the page's own clipboard access is too limited
/// in browsers for OSC 52). Made on first use and kept: on X11 the copied
/// text is served from here.
static CLIPBOARD: Mutex<Option<arboard::Clipboard>> = Mutex::new(None);

fn with_clipboard<T>(f: impl FnOnce(&mut arboard::Clipboard) -> Result<T, arboard::Error>) -> Option<T> {
    let mut c = CLIPBOARD.lock().unwrap();
    if c.is_none() {
        match arboard::Clipboard::new() {
            Ok(cb) => *c = Some(cb),
            Err(e) => {
                eprintln!("[gty] no clipboard: {e}");
                return None;
            }
        }
    }
    f(c.as_mut().unwrap()).map_err(|e| eprintln!("[gty] clipboard: {e}")).ok()
}

/// Runs browser mode until the page is gone. `browser`: the browser asked
/// for (otherwise the default one). Returns the exit code.
pub fn run(version: &str, assets: &'static Assets, browser: Option<String>) -> i32 {
    match serve(version, assets, browser) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("gty: {e}");
            1
        }
    }
}

fn serve(version: &str, assets: &'static Assets, browser: Option<String>) -> io::Result<i32> {
    // Find the browser before starting anything.
    let no_launch = std::env::var_os("GTY_BROWSER_NO_LAUNCH").is_some();
    let chosen = if no_launch { None } else { launch::find(browser.as_deref()) };
    if !no_launch && chosen.is_none() {
        eprintln!(
            "gty: no web browser found to show the terminal in (looked for {}, then for Chromium, Chrome, Edge, Brave \
             and Firefox on PATH). Install one, or set gty.browser in {} (or GTY_BROWSER) to the browser to use.",
            if browser.is_some() { "the browser named in the settings" } else { "the default web browser" },
            boot::settings_file().display()
        );
        return Ok(127);
    }

    let prepared = boot::prepare(version, assets)?;
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    let url = format!("http://127.0.0.1:{port}/");
    let boot_json: Arc<Vec<u8>> =
        Arc::new(boot::boot(&format!("ws://127.0.0.1:{port}/ws"), version, &prepared.shell_integration, Mode::Browser).to_string().into_bytes());
    let life = Arc::new(Life::default());

    {
        let (life, daemon, boot_json) = (life.clone(), prepared.daemon.clone(), boot_json.clone());
        thread::Builder::new().name("browser-http".into()).spawn(move || {
            for stream in listener.incoming().flatten() {
                let (life, daemon, boot_json) = (life.clone(), daemon.clone(), boot_json.clone());
                let _ = thread::Builder::new().name("browser-conn".into()).spawn(move || {
                    if let Err(e) = connection(stream, port, assets, &boot_json, &daemon, &life) {
                        if !matches!(e.kind(), io::ErrorKind::UnexpectedEof | io::ErrorKind::ConnectionReset) {
                            eprintln!("[gty] browser connection: {e}");
                        }
                    }
                });
            }
        })?;
    }

    match chosen {
        Some(b) => launch::launch(&b, &url)?,
        None => {
            // GTY_BROWSER_NO_LAUNCH: the address on stdout, for a browser started by hand (or a test).
            println!("{url}");
            io::stdout().flush()?;
            eprintln!("[gty] open {url} in a web browser");
        }
    }

    // Until the page is gone.
    let first_page = std::env::var("GTY_BROWSER_FIRST_PAGE_SECS").ok().and_then(|s| s.parse().ok()).map(Duration::from_secs).unwrap_or(FIRST_PAGE);
    let started = Instant::now();
    let sessions = {
        let mut p = life.pages.lock().unwrap();
        loop {
            if !p.ever && started.elapsed() >= first_page {
                eprintln!("gty: the browser did not open the terminal's page within {}s ({url})", first_page.as_secs());
                return Ok(1);
            }
            if p.quit {
                break std::mem::take(&mut p.sessions);
            }
            if p.open == 0 && p.ever && p.since_empty.is_some_and(|t| t.elapsed() >= GRACE) {
                break std::mem::take(&mut p.sessions);
            }
            p = life.changed.wait_timeout(p, Duration::from_millis(250)).unwrap().0;
        }
    };
    // A window closed without its session ending: end the session, as
    // closing a terminal window ends its shell.
    if !sessions.is_empty() {
        if let Ok(mut conn) = prepared.daemon.connect() {
            for id in sessions {
                let _ = super::client::kill(&mut conn, id);
            }
            thread::sleep(Duration::from_millis(100));
            conn.shutdown();
        }
    }
    Ok(0)
}

fn connection(
    mut stream: TcpStream,
    port: u16,
    assets: &Assets,
    boot_json: &[u8],
    daemon: &super::client::Daemon,
    life: &Life,
) -> io::Result<()> {
    stream.set_nodelay(true)?;
    let (head, read) = http::read_head(&mut stream)?;
    match http::check(&head, port) {
        Err((status, why)) => {
            eprintln!("[gty] refused {} {}: {why}", head.method, head.path);
            http::respond(&mut stream, status, "text/plain; charset=utf-8", why.as_bytes())
        }
        Ok(Route::Asset(path)) => match (assets.get)(&path) {
            Some(a) => http::respond(&mut stream, 200, a.mime, a.bytes),
            None => http::respond(&mut stream, 404, "text/plain; charset=utf-8", b"not found"),
        },
        Ok(Route::Boot) => http::respond(&mut stream, 200, "application/json", boot_json),
        Ok(Route::Daemon) => {
            stream.set_read_timeout(None)?;
            let ws = tungstenite::accept(Replay::new(read, stream)).map_err(|e| io::Error::other(format!("handshake: {e}")))?;
            bridge::pump(ws, daemon)
        }
        Ok(Route::Ipc) => {
            stream.set_read_timeout(None)?;
            let ws = tungstenite::accept(Replay::new(read, stream)).map_err(|e| io::Error::other(format!("handshake: {e}")))?;
            life.opened();
            let r = ipc(ws, life);
            life.closed();
            r
        }
    }
}

/// The page's messages, while the page is open (its /ipc socket is the
/// page's lifetime).
fn ipc(mut ws: tungstenite::WebSocket<Replay>, life: &Life) -> io::Result<()> {
    loop {
        let text = match ws.read() {
            Ok(Message::Text(t)) => t,
            Ok(Message::Close(_)) | Err(_) => return Ok(()),
            Ok(_) => continue,
        };
        let msg = match serde_json::from_str::<FromPage>(text.as_str()) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[gty] bad message from the page: {e}");
                continue;
            }
        };
        match msg {
            // The page sets its own document title.
            FromPage::Title {} => {}
            FromPage::Open { url } => boot::open_url(&url),
            FromPage::ClipboardWrite { text } => {
                let _ = with_clipboard(|c| c.set_text(text));
            }
            FromPage::ClipboardRead { id } => {
                let value = with_clipboard(|c| c.get_text()).unwrap_or_default();
                let reply = serde_json::json!({ "type": "reply", "id": id, "value": value }).to_string();
                if ws.send(Message::text(reply)).is_err() {
                    return Ok(());
                }
            }
            FromPage::Notify { title, body } => boot::notify(&title, &body),
            FromPage::Log { level, message } => eprintln!("[gty {level}] {message}"),
            FromPage::Quit => {
                life.pages.lock().unwrap().quit = true;
                life.changed.notify_all();
            }
            FromPage::Session { id } => {
                life.pages.lock().unwrap().sessions.insert(id);
            }
        }
    }
}
