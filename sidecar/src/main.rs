//! gty-sidecar: a PTY broker for code-gty.
//!
//! The extension host talks to it over stdin/stdout with length-prefixed
//! frames (see `protocol.rs`); stderr carries logs. One sidecar serves a whole
//! VS Code window and multiplexes sessions by id. When stdin closes, every
//! session is hung up and the process exits.

mod procinfo;
mod protocol;
mod replay;
mod session;

use protocol::{kind, ErrorMsg, Frame, Hello, ResizeRequest, SpawnRequest};
use session::{Out, Session};
use std::collections::HashMap;
use std::io::{self, BufReader, Write};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const BUILD_ID: &str = match option_env!("GTY_BUILD_ID") {
    Some(id) => id,
    None => env!("CARGO_PKG_VERSION"),
};
/// Small PTY reads arriving within this window are merged into one frame.
const COALESCE: Duration = Duration::from_millis(4);
const MAX_BATCH: usize = 128 * 1024;
const PROCESS_POLL: Duration = Duration::from_millis(500);
const SHUTDOWN_GRACE: Duration = Duration::from_millis(1000);

type Sessions = Arc<Mutex<HashMap<u32, Session>>>;

macro_rules! log {
    ($($arg:tt)*) => { eprintln!("[gty-sidecar] {}", format!($($arg)*)) };
}

fn main() {
    let arg = std::env::args().nth(1);
    match arg.as_deref() {
        Some("--version") => {
            println!("gty-sidecar {} protocol {}", BUILD_ID, protocol::PROTOCOL_VERSION);
            return;
        }
        Some("--selftest") => std::process::exit(selftest()),
        Some(other) => {
            eprintln!("usage: gty-sidecar [--version]  (unknown argument {other:?})");
            std::process::exit(2);
        }
        None => {}
    }

    let (tx, rx) = mpsc::channel::<Out>();
    let writer = thread::Builder::new()
        .name("stdout".into())
        .spawn(move || output_loop(rx))
        .expect("spawn stdout thread");

    let _ = tx.send(Out::Frame(Frame::json(
        kind::HELLO,
        0,
        &Hello {
            protocol: protocol::PROTOCOL_VERSION,
            build: BUILD_ID,
            pid: std::process::id(),
            os: std::env::consts::OS,
        },
    )));

    let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));
    spawn_process_poller(sessions.clone(), tx.clone());

    let mut stdin = BufReader::with_capacity(256 * 1024, io::stdin().lock());
    loop {
        match protocol::read_frame(&mut stdin) {
            Ok(Some(frame)) => handle(frame, &sessions, &tx),
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
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(Out::Data(_, d)) => {
                session.ack(d.len());
                out.extend_from_slice(&d);
            }
            Ok(Out::Frame(f)) if f.kind == kind::EXIT => break,
            Ok(Out::Frame(_)) => {}
            Err(_) => {
                eprintln!("selftest: timed out");
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

fn handle(frame: Frame, sessions: &Sessions, tx: &Sender<Out>) {
    let id = frame.session;
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
            match Session::spawn(id, req, tx.clone()) {
                Ok(s) => {
                    map.insert(id, s);
                }
                Err(e) => err(e),
            }
        }
        kind::INPUT => with_session(sessions, id, &err, |s| s.input(frame.payload)),
        kind::RESIZE => match serde_json::from_slice::<ResizeRequest>(&frame.payload) {
            Ok(r) => with_session(sessions, id, &err, |s| {
                if let Err(e) = s.resize(r.cols, r.rows, r.width, r.height) {
                    err(format!("resize failed: {e}"));
                }
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
        }
        kind::QUERY_PROCESS => with_session(sessions, id, &err, |s| {
            if let Some(info) = s.process_info(false) {
                let _ = tx.send(Out::Frame(Frame::json(kind::PROCESS_INFO, id, &info)));
            }
        }),
        other => err(format!("unknown frame kind {other}")),
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
fn spawn_process_poller(sessions: Sessions, tx: Sender<Out>) {
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

/// Owns stdout. Coalesces PTY output for a few milliseconds per batch while
/// keeping every frame in channel order.
fn output_loop(rx: Receiver<Out>) {
    let mut stdout = io::stdout().lock();
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
            // Host is gone; nothing more can be delivered.
            std::process::exit(0);
        }
        buf.clear();
    }
    flush_pending(&mut pending, &mut pending_len, &mut buf);
    let _ = stdout.write_all(&buf);
    let _ = stdout.flush();
}
