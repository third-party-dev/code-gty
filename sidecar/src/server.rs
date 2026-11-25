//! Daemon mode: `gty-sidecar --server <dir> [--vt <ghostty-vt.wasm>]`.
//!
//! The sidecar outlives VS Code windows, so terminal sessions survive window
//! reloads and closes, like tmux. Clients (extension hosts of the same user)
//! connect to a Unix socket in `<dir>` (a loopback TCP port on Windows) and
//! must first send the token from `<dir>/daemon-v<N>.json`, which only the
//! user can read. One daemon runs per directory; it exits on its own once no
//! client has been connected and no session has been running for a while.

use std::fs;
use std::io::{self, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::protocol::{self, kind, Frame, Hello};
use crate::router::{Ctl, Router, Sessions};
use crate::session::Out;
use crate::vtengine::VtModule;
use crate::{handle, output_loop, spawn_process_poller, Client, BUILD_ID};

/// How long the daemon stays up with no clients and nothing running.
const IDLE_EXIT: Duration = Duration::from_secs(60);
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);

macro_rules! log {
    ($($arg:tt)*) => { eprintln!("[gty-sidecar] {}", format!($($arg)*)) };
}

fn state_file(dir: &Path) -> PathBuf {
    dir.join(format!("daemon-v{}.json", protocol::PROTOCOL_VERSION))
}

#[cfg(unix)]
fn socket_path(dir: &Path) -> PathBuf {
    dir.join(format!("sidecar-v{}.sock", protocol::PROTOCOL_VERSION))
}

fn token() -> io::Result<String> {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).map_err(|e| io::Error::other(e.to_string()))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// Equal-time comparison, so a wrong token reveals nothing.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Writes a file only the user can read, atomically.
fn write_private(path: &Path, data: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension("tmp");
    let _ = fs::remove_file(&tmp);
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    let mut f = opts.open(&tmp)?;
    f.write_all(data)?;
    f.sync_all()?;
    drop(f);
    fs::rename(&tmp, path)
}

fn private_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
        // Refuse a directory someone else owns: they could swap the socket.
        if fs::metadata(dir)?.uid() != unsafe { libc::getuid() } {
            return Err(io::Error::other(format!("{} is not owned by this user", dir.display())));
        }
    }
    Ok(())
}

trait Conn: Read + Write + Send {
    fn split(&self) -> io::Result<Box<dyn Conn>>;
    fn read_timeout(&self, d: Option<Duration>) -> io::Result<()>;
}

#[cfg(unix)]
impl Conn for std::os::unix::net::UnixStream {
    fn split(&self) -> io::Result<Box<dyn Conn>> {
        Ok(Box::new(self.try_clone()?))
    }
    fn read_timeout(&self, d: Option<Duration>) -> io::Result<()> {
        self.set_read_timeout(d)
    }
}

impl Conn for std::net::TcpStream {
    fn split(&self) -> io::Result<Box<dyn Conn>> {
        Ok(Box::new(self.try_clone()?))
    }
    fn read_timeout(&self, d: Option<Duration>) -> io::Result<()> {
        self.set_read_timeout(d)
    }
}

type Accept = Box<dyn Fn() -> io::Result<Box<dyn Conn>> + Send>;

pub fn run(dir: PathBuf, vt: Option<PathBuf>) -> i32 {
    #[cfg(unix)]
    unsafe {
        // Detached from any terminal: a hangup must not end the daemon.
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    if let Err(e) = private_dir(&dir) {
        log!("cannot use {}: {e}", dir.display());
        return 1;
    }
    let module = vt.and_then(|p| match fs::read(&p).map_err(|e| e.to_string()).and_then(|b| VtModule::load(&b)) {
        Ok(m) => {
            log!("libghostty-vt {} loaded from {}", m.version, p.display());
            Some(m)
        }
        Err(e) => {
            log!("no engine for detached sessions ({}): {e}", p.display());
            None
        }
    });
    let token = match token() {
        Ok(t) => t,
        Err(e) => {
            log!("no randomness: {e}");
            return 1;
        }
    };

    let (accept, address): (Accept, serde_json::Value) = {
        #[cfg(unix)]
        {
            use std::os::unix::net::{UnixListener, UnixStream};
            let path = socket_path(&dir);
            if path.exists() {
                if UnixStream::connect(&path).is_ok() {
                    log!("a daemon is already running at {}", path.display());
                    return 0;
                }
                let _ = fs::remove_file(&path);
            }
            let listener = match UnixListener::bind(&path) {
                Ok(l) => l,
                Err(e) => {
                    // Another daemon may have won the race.
                    log!("cannot listen at {}: {e}", path.display());
                    return if UnixStream::connect(&path).is_ok() { 0 } else { 1 };
                }
            };
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
            (Box::new(move || listener.accept().map(|(s, _)| Box::new(s) as Box<dyn Conn>)), serde_json::json!({ "socket": path }))
        }
        #[cfg(not(unix))]
        {
            // Only one daemon per directory: hold a lock file open exclusively.
            let lock_path = dir.join(format!("sidecar-v{}.lock", protocol::PROTOCOL_VERSION));
            let mut opts = fs::OpenOptions::new();
            opts.write(true).create(true);
            #[cfg(windows)]
            std::os::windows::fs::OpenOptionsExt::share_mode(&mut opts, 0);
            let lock = match opts.open(&lock_path) {
                Ok(f) => f,
                Err(_) => {
                    log!("a daemon is already running for {}", dir.display());
                    return 0;
                }
            };
            std::mem::forget(lock);
            let listener = match std::net::TcpListener::bind("127.0.0.1:0") {
                Ok(l) => l,
                Err(e) => {
                    log!("cannot listen: {e}");
                    return 1;
                }
            };
            let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
            (
                Box::new(move || {
                    listener.accept().map(|(s, _)| {
                        let _ = s.set_nodelay(true);
                        Box::new(s) as Box<dyn Conn>
                    })
                }),
                serde_json::json!({ "port": port }),
            )
        }
    };

    let mut state = serde_json::json!({
        "pid": std::process::id(),
        "protocol": protocol::PROTOCOL_VERSION,
        "build": BUILD_ID,
        "token": token,
        "vt": module.as_ref().map(|m| m.version.clone()),
    });
    state.as_object_mut().unwrap().extend(address.as_object().unwrap().clone());
    if let Err(e) = write_private(&state_file(&dir), serde_json::to_string(&state).unwrap().as_bytes()) {
        log!("cannot write {}: {e}", state_file(&dir).display());
        return 1;
    }
    log!("daemon {} ready (pid {})", BUILD_ID, std::process::id());

    let sessions: Sessions = Arc::new(Mutex::new(Default::default()));
    let (rtx, rrx) = mpsc::channel::<Out>();
    {
        let router = Router::new(sessions.clone(), module, true);
        thread::Builder::new().name("router".into()).spawn(move || router.run(rrx)).expect("spawn router");
    }
    spawn_process_poller(sessions.clone(), rtx.clone());

    let clients = Arc::new(AtomicUsize::new(0));
    spawn_idle_watch(dir.clone(), sessions.clone(), clients.clone());

    let next_id = Arc::new(AtomicU64::new(1));
    let token = Arc::new(token);
    loop {
        let conn = match accept() {
            Ok(c) => c,
            Err(e) => {
                log!("accept failed: {e}");
                thread::sleep(Duration::from_millis(100));
                continue;
            }
        };
        let (sessions, rtx, clients, token) = (sessions.clone(), rtx.clone(), clients.clone(), token.clone());
        let id = next_id.fetch_add(1, Ordering::SeqCst);
        let _ = thread::Builder::new().name(format!("client-{id}")).spawn(move || serve(id, conn, sessions, rtx, clients, &token));
    }
}

fn serve(id: u64, conn: Box<dyn Conn>, sessions: Sessions, router: Sender<Out>, clients: Arc<AtomicUsize>, token: &str) {
    let Ok(out_conn) = conn.split() else { return };
    let _ = conn.read_timeout(Some(AUTH_TIMEOUT));
    let mut reader = BufReader::with_capacity(256 * 1024, conn);
    match protocol::read_frame(&mut reader) {
        Ok(Some(f)) if f.kind == kind::AUTH && same(&f.payload, token.as_bytes()) => {}
        _ => {
            log!("client {id}: refused (no valid token)");
            return;
        }
    }
    let _ = reader.get_ref().read_timeout(None);
    clients.fetch_add(1, Ordering::SeqCst);

    let (wtx, wrx) = mpsc::channel::<Out>();
    let writer = thread::Builder::new().name(format!("client-{id}-out")).spawn(move || output_loop(wrx, out_conn));
    let _ = router.send(Out::Ctl(Ctl::NewClient(id, wtx.clone())));
    let _ = wtx.send(Out::Frame(Frame::json(
        kind::HELLO,
        0,
        &Hello { protocol: protocol::PROTOCOL_VERSION, build: BUILD_ID, pid: std::process::id(), os: std::env::consts::OS },
    )));
    let client = Client { id, writer: wtx, router: router.clone() };
    loop {
        match protocol::read_frame(&mut reader) {
            Ok(Some(frame)) => handle(frame, &sessions, &client),
            Ok(None) => break,
            Err(e) => {
                log!("client {id}: {e}");
                break;
            }
        }
    }
    // Its sessions stay; the router detaches them.
    let _ = router.send(Out::Ctl(Ctl::ClientGone(id)));
    drop(client);
    clients.fetch_sub(1, Ordering::SeqCst);
    if let Ok(w) = writer {
        let _ = w.join();
    }
}

/// Exits once no client has been connected and no session has been running
/// for IDLE_EXIT.
fn spawn_idle_watch(dir: PathBuf, sessions: Sessions, clients: Arc<AtomicUsize>) {
    let _ = thread::Builder::new().name("idle".into()).spawn(move || {
        let mut idle_since: Option<Instant> = None;
        loop {
            thread::sleep(Duration::from_secs(2));
            let running = sessions.lock().unwrap().values().any(|s| !s.is_exited());
            if clients.load(Ordering::SeqCst) > 0 || running {
                idle_since = None;
                continue;
            }
            let since = *idle_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= IDLE_EXIT {
                log!("idle, exiting");
                let _ = fs::remove_file(state_file(&dir));
                #[cfg(unix)]
                let _ = fs::remove_file(socket_path(&dir));
                std::process::exit(0);
            }
        }
    });
}
