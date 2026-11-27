//! gty-sidecar: a PTY broker for code-gty.
//!
//! Two modes, with the same length-prefixed frames (see `protocol.rs`):
//!
//! - stdin/stdout (default): one VS Code window owns this process. When stdin
//!   closes, every session is hung up and the process exits.
//! - `--server <dir>` (server.rs): a daemon that outlives windows, so sessions
//!   survive reloads and can be reattached from any window, like tmux.
//!
//! Either way, output is routed by router.rs; stderr carries logs.
//!
//! A library too, so the native app (app/) is the same program: it runs the
//! daemon with `run_cli(["--server", ...])` and shares its sessions with
//! VS Code.

mod decode;
#[cfg(feature = "native")]
pub mod native;
mod procinfo;
mod protocol;
mod replay;
mod router;
mod server;
mod session;
mod vtengine;

use protocol::{kind, ErrorMsg, Frame, Hello, ResizeRequest, SpawnRequest};
use router::{ClientId, Ctl, Router, Sessions};
use session::{Out, Session};
use std::collections::HashMap;
use std::io::{self, BufReader, Write};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub const BUILD_ID: &str = match option_env!("GTY_BUILD_ID") {
    Some(id) => id,
    None => env!("CARGO_PKG_VERSION"),
};
/// Small PTY reads arriving within this window are merged into one frame.
const COALESCE: Duration = Duration::from_millis(4);
const MAX_BATCH: usize = 128 * 1024;
const PROCESS_POLL: Duration = Duration::from_millis(500);
const SHUTDOWN_GRACE: Duration = Duration::from_millis(1000);

/// What a connection handler needs: where replies go and where routing goes.
pub struct Client {
    pub id: ClientId,
    pub writer: Sender<Out>,
    pub router: Sender<Out>,
}

macro_rules! log {
    ($($arg:tt)*) => { eprintln!("[gty-sidecar] {}", format!($($arg)*)) };
}

/// The sidecar's command line (`args` without the program name). Returns
/// the exit code; stdio mode never returns.
pub fn run_cli(args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        Some("--version") => {
            println!("gty-sidecar {} protocol {}", BUILD_ID, protocol::PROTOCOL_VERSION);
            return 0;
        }
        Some("--selftest") => return selftest(),
        Some("--server") => {
            let args: Vec<String> = args[1..].to_vec();
            let Some(dir) = args.first() else {
                eprintln!("usage: gty-sidecar --server <dir> [--vt <ghostty-vt.wasm>]");
                return 2;
            };
            let vt = args.iter().position(|a| a == "--vt").and_then(|i| args.get(i + 1)).map(Into::into);
            return server::run(dir.into(), vt);
        }
        Some(other) => {
            eprintln!("usage: gty-sidecar [--version | --server <dir> [--vt <wasm>]]  (unknown argument {other:?})");
            return 2;
        }
        None => {}
    }

    // stdin/stdout mode: a single client, which owns every session.
    let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));
    let (tx, rx) = mpsc::channel::<Out>();
    {
        let router = Router::new(sessions.clone(), None, false);
        thread::Builder::new().name("router".into()).spawn(move || router.run(rx)).expect("spawn router");
    }
    let (wtx, wrx) = mpsc::channel::<Out>();
    let writer = thread::Builder::new()
        .name("stdout".into())
        .spawn(move || {
            output_loop(wrx, io::stdout().lock());
            // Host is gone; nothing more can be delivered.
            std::process::exit(0);
        })
        .expect("spawn stdout thread");
    let _ = tx.send(Out::Ctl(Ctl::NewClient(1, wtx.clone())));
    let client = Client { id: 1, writer: wtx, router: tx.clone() };

    let _ = client.writer.send(Out::Frame(Frame::json(
        kind::HELLO,
        0,
        &Hello {
            protocol: protocol::PROTOCOL_VERSION,
            build: BUILD_ID,
            pid: std::process::id(),
            os: std::env::consts::OS,
        },
    )));

    spawn_process_poller(sessions.clone(), tx.clone());

    let mut stdin = BufReader::with_capacity(256 * 1024, io::stdin().lock());
    loop {
        match protocol::read_frame(&mut stdin) {
            Ok(Some(frame)) => handle(frame, &sessions, &client),
            Ok(None) => break,
            Err(e) => {
                log!("protocol error, shutting down: {e}");
                break;
            }
        }
    }

    // Host went away: hang up everything we own, then force what lingers.
    let mut all: Vec<Session> = sessions.lock().unwrap().drain().map(|(_, s)| s).collect();
    for s in all.iter_mut() {
        s.hangup();
    }
    let deadline = Instant::now() + SHUTDOWN_GRACE;
    while Instant::now() < deadline && all.iter().any(|s| !s.is_exited()) {
        thread::sleep(Duration::from_millis(20));
    }
    for s in all.iter_mut().filter(|s| !s.is_exited()) {
        s.force_kill();
    }
    // Other threads still hold senders, so do not wait for the writer to see
    // a closed channel; just let it drain what is queued.
    drop(tx);
    drop(client);
    thread::sleep(Duration::from_millis(50));
    drop(writer);
    std::process::exit(0);
}

/// Spawns `/bin/sh` in a PTY and checks its output. Used by the portability
/// tests on Debian and Alpine, where no host is available to drive frames.
fn selftest() -> i32 {
    #[cfg(unix)]
    let (cmd, args) = ("/bin/sh", vec!["-c".to_string(), "echo gty-selftest-$((40+2)); stty size".to_string()]);
    #[cfg(windows)]
    let (cmd, args) = ("cmd.exe", vec!["/c".to_string(), "echo gty-selftest-42".to_string()]);
    let (tx, rx) = mpsc::channel::<Out>();
    let req = SpawnRequest {
        command: cmd.into(),
        args,
        env: std::env::vars().collect(),
        cwd: None,
        cols: 91,
        rows: 33,
        width: 0,
        height: 0,
        window: None,
        replay_limit: None,
    };
    let session = match Session::spawn(1, req, tx) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("selftest: spawn failed: {e}");
            return 1;
        }
    };
    let mut out = Vec::new();
    // Answer the queries a terminal would: newer ConPTY (Windows Server
    // 2025, Windows 11 24H2) asks for device attributes (DA1) and the cursor
    // position when it starts, and waits for the answers.
    let (mut da1, mut cpr) = (0, 0);
    let count = |hay: &[u8], needle: &[u8]| hay.windows(needle.len()).filter(|w| *w == needle).count();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(Out::Data(_, d)) => {
                session.ack(d.len());
                out.extend_from_slice(&d);
                let asked = count(&out, b"\x1b[c") + count(&out, b"\x1b[0c");
                for _ in da1..asked {
                    session.input(b"\x1b[?62;22c".to_vec());
                }
                da1 = da1.max(asked);
                let asked = count(&out, b"\x1b[6n");
                for _ in cpr..asked {
                    session.input(b"\x1b[1;1R".to_vec());
                }
                cpr = cpr.max(asked);
            }
            Ok(Out::Frame(f)) if f.kind == kind::EXIT => break,
            Ok(_) => {}
            Err(_) => {
                eprintln!("selftest: timed out; {da1} DA1 and {cpr} cursor-position queries answered; output so far: {:?}",
                    String::from_utf8_lossy(&out));
                return 1;
            }
        }
    }
    let text = String::from_utf8_lossy(&out);
    let ok = text.contains("gty-selftest-42") && (cfg!(windows) || text.contains("33 91"));
    println!("{}", if ok { "selftest ok" } else { "selftest FAILED" });
    if !ok {
        eprintln!("output was: {text:?}");
    }
    i32::from(!ok)
}

pub fn handle(frame: Frame, sessions: &Sessions, client: &Client) {
    let id = frame.session;
    let tx = &client.writer;
    let err = |message: String| {
        let _ = tx.send(Out::Frame(Frame::json(kind::ERROR, id, &ErrorMsg { message })));
    };
    match frame.kind {
        kind::SPAWN => {
            if id == 0 {
                return err("session id 0 is reserved".into());
            }
            let req: SpawnRequest = match serde_json::from_slice(&frame.payload) {
                Ok(r) => r,
                Err(e) => return err(format!("bad spawn request: {e}")),
            };
            let mut map = sessions.lock().unwrap();
            if map.contains_key(&id) {
                return err(format!("session {id} already exists"));
            }
            // Route first, so output that arrives immediately has an owner.
            let _ = client.router.send(Out::Ctl(Ctl::Spawned { client: client.id, session: id, cols: req.cols, rows: req.rows }));
            match Session::spawn(id, req, client.router.clone()) {
                Ok(s) => {
                    map.insert(id, s);
                }
                Err(e) => {
                    let _ = client.router.send(Out::Ctl(Ctl::Killed(id)));
                    err(e)
                }
            }
        }
        kind::INPUT => with_session(sessions, id, &err, |s| s.input(frame.payload)),
        kind::RESIZE => match serde_json::from_slice::<ResizeRequest>(&frame.payload) {
            Ok(r) => with_session(sessions, id, &err, |s| {
                if let Err(e) = s.resize(r.cols, r.rows, r.width, r.height) {
                    err(format!("resize failed: {e}"));
                }
                let _ = client.router.send(Out::Ctl(Ctl::Resized { session: id, cols: r.cols, rows: r.rows }));
            }),
            Err(e) => err(format!("bad resize request: {e}")),
        },
        kind::ACK => {
            if frame.payload.len() != 4 {
                return err("ack payload must be 4 bytes".into());
            }
            let n = u32::from_le_bytes(frame.payload[..4].try_into().unwrap()) as usize;
            // Acks for a session that is gone are harmless.
            if let Some(s) = sessions.lock().unwrap().get(&id) {
                s.ack(n);
            }
        }
        kind::ATTACH => with_session(sessions, id, &err, |s| s.attach(tx)),
        kind::KILL => {
            if let Some(s) = sessions.lock().unwrap().remove(&id) {
                if !s.is_exited() {
                    s.kill();
                }
            }
            let _ = client.router.send(Out::Ctl(Ctl::Killed(id)));
        }
        kind::DECODE => decode_async(id, frame.payload, tx.clone()),
        kind::QUERY_PROCESS => with_session(sessions, id, &err, |s| {
            if let Some(info) = s.process_info(false) {
                let _ = tx.send(Out::Frame(Frame::json(kind::PROCESS_INFO, id, &info)));
            }
        }),
        kind::LIST => {
            let _ = client.router.send(Out::Ctl(Ctl::List(client.id)));
        }
        kind::CLAIM => {
            let _ = client.router.send(Out::Ctl(Ctl::Claim { client: client.id, session: id }));
        }
        kind::CHECKPOINT => {
            // u64 position | u32 meta length | meta JSON | snapshot
            let p = &frame.payload;
            if p.len() < 12 {
                return err("checkpoint too short".into());
            }
            let position = u64::from_le_bytes(p[0..8].try_into().unwrap());
            let meta_len = u32::from_le_bytes(p[8..12].try_into().unwrap()) as usize;
            if p.len() < 12 + meta_len {
                return err("checkpoint too short".into());
            }
            let _ = client.router.send(Out::Ctl(Ctl::Checkpoint {
                client: client.id,
                session: id,
                position,
                meta: p[12..12 + meta_len].to_vec(),
                snapshot: p[12 + meta_len..].to_vec(),
            }));
        }
        kind::AUTH => {}
        other => err(format!("unknown frame kind {other}")),
    }
}

/// Decodes on a worker thread so PTY traffic never waits for an image. At
/// most a few decodes run at once; more are refused (the host shows nothing).
fn decode_async(session: u32, payload: Vec<u8>, tx: Sender<Out>) {
    static RUNNING: AtomicUsize = AtomicUsize::new(0);
    let req_id = payload.get(0..4).map(|b| u32::from_le_bytes(b.try_into().unwrap())).unwrap_or(0);
    if RUNNING.fetch_add(1, Ordering::SeqCst) >= 4 {
        RUNNING.fetch_sub(1, Ordering::SeqCst);
        let _ = tx.send(Out::Frame(Frame::new(kind::DECODED, session, decode::reply(req_id, Err("busy".into())))));
        return;
    }
    let spawned = thread::Builder::new().name("decode".into()).spawn(move || {
        let reply = match decode::parse_request(&payload) {
            Ok(req) => decode::reply(req.id, decode::decode(&req)),
            Err(e) => decode::reply(req_id, Err(e)),
        };
        RUNNING.fetch_sub(1, Ordering::SeqCst);
        let _ = tx.send(Out::Frame(Frame::new(kind::DECODED, session, reply)));
    });
    if spawned.is_err() {
        RUNNING.fetch_sub(1, Ordering::SeqCst);
    }
}

fn with_session(
    sessions: &Sessions,
    id: u32,
    err: &dyn Fn(String),
    f: impl FnOnce(&mut Session),
) {
    match sessions.lock().unwrap().get_mut(&id) {
        Some(s) => f(s),
        None => err(format!("no session {id}")),
    }
}

/// Pushes a `process_info` frame whenever a session's foreground process
/// changes, so tab titles can follow `vim`, `htop` and so on.
pub fn spawn_process_poller(sessions: Sessions, tx: Sender<Out>) {
    if cfg!(not(unix)) {
        return;
    }
    let _ = thread::Builder::new().name("proc-poll".into()).spawn(move || loop {
        thread::sleep(PROCESS_POLL);
        let mut map = sessions.lock().unwrap();
        for (id, s) in map.iter_mut() {
            if s.is_exited() {
                continue;
            }
            if let Some(info) = s.process_info(true) {
                if tx.send(Out::Frame(Frame::json(kind::PROCESS_INFO, *id, &info))).is_err() {
                    return;
                }
            }
        }
    });
}

/// Owns one client's output (stdout, or a socket). Coalesces PTY output for a
/// few milliseconds per batch while keeping every frame in channel order.
/// Returns when the client is gone.
pub fn output_loop<W: Write>(rx: Receiver<Out>, mut stdout: W) {
    let mut pending: Vec<(u32, Vec<u8>)> = Vec::new();
    let mut pending_len = 0usize;
    let mut buf: Vec<u8> = Vec::with_capacity(MAX_BATCH + 1024);

    fn flush_pending(pending: &mut Vec<(u32, Vec<u8>)>, len: &mut usize, buf: &mut Vec<u8>) {
        for (id, data) in pending.drain(..) {
            Frame::new(kind::OUTPUT, id, data).encode_into(buf);
        }
        *len = 0;
    }

    let accept = |msg: Out,
                      pending: &mut Vec<(u32, Vec<u8>)>,
                      pending_len: &mut usize,
                      buf: &mut Vec<u8>| match msg {
        Out::Data(id, data) => {
            *pending_len += data.len();
            match pending.last_mut() {
                Some((last, d)) if *last == id => d.extend_from_slice(&data),
                _ => pending.push((id, data)),
            }
        }
        Out::Frame(f) => {
            flush_pending(pending, pending_len, buf);
            f.encode_into(buf);
        }
        Out::Ctl(_) => {}
    };

    while let Ok(first) = rx.recv() {
        accept(first, &mut pending, &mut pending_len, &mut buf);
        if !pending.is_empty() {
            let deadline = Instant::now() + COALESCE;
            while pending_len < MAX_BATCH {
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                match rx.recv_timeout(deadline - now) {
                    Ok(m) => accept(m, &mut pending, &mut pending_len, &mut buf),
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
        }
        flush_pending(&mut pending, &mut pending_len, &mut buf);
        if stdout.write_all(&buf).and_then(|_| stdout.flush()).is_err() {
            // The client is gone; nothing more can be delivered.
            return;
        }
        buf.clear();
    }
    flush_pending(&mut pending, &mut pending_len, &mut buf);
    let _ = stdout.write_all(&buf);
    let _ = stdout.flush();
}
