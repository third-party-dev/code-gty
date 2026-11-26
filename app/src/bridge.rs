//! The page's way to the sidecar daemon: a WebSocket on loopback. Each
//! connection gets its own authenticated daemon connection, and bytes pass
//! through unchanged, so the page speaks the same frames as the extension
//! host (src/core/sidecarClient.ts).
//!
//! Only this app's page can use it: the URL carries a random token, and the
//! Origin must be the app's own scheme (a web page in a browser cannot
//! forge either).

use crate::daemon::Daemon;
use std::io::{self, ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::{Error as WsError, Message};

/// The page's origin as each platform's web view reports it.
const ORIGINS: &[&str] = &["gty://localhost", "http://gty.localhost", "https://gty.localhost"];

pub struct Bridge {
    pub url: String,
}

fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn start(daemon: Arc<Daemon>) -> io::Result<Bridge> {
    let mut raw = [0u8; 32];
    getrandom::fill(&mut raw).map_err(|e| io::Error::other(e.to_string()))?;
    let token: String = raw.iter().map(|b| format!("{b:02x}")).collect();
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let url = format!("ws://127.0.0.1:{}/?token={token}", listener.local_addr()?.port());
    let token = Arc::new(token);
    thread::Builder::new().name("bridge".into()).spawn(move || {
        for stream in listener.incoming().flatten() {
            let (daemon, token) = (daemon.clone(), token.clone());
            let _ = thread::Builder::new().name("bridge-conn".into()).spawn(move || {
                if let Err(e) = serve(stream, &daemon, &token) {
                    eprintln!("[gty] bridge connection: {e}");
                }
            });
        }
    })?;
    Ok(Bridge { url })
}

fn serve(stream: TcpStream, daemon: &Daemon, token: &str) -> io::Result<()> {
    stream.set_nodelay(true)?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let check = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        let query = req.uri().query().unwrap_or("");
        let given = query.split('&').find_map(|kv| kv.strip_prefix("token=")).unwrap_or("");
        let origin = req.headers().get("origin").and_then(|v| v.to_str().ok()).unwrap_or("");
        if same(given.as_bytes(), token.as_bytes()) && ORIGINS.contains(&origin) {
            Ok(resp)
        } else {
            let mut r = ErrorResponse::new(Some("forbidden".into()));
            *r.status_mut() = tungstenite::http::StatusCode::FORBIDDEN;
            Err(r)
        }
    };
    let mut ws = tungstenite::accept_hdr(stream, check).map_err(|e| io::Error::other(format!("handshake: {e}")))?;
    let mut conn = daemon.connect()?;
    let mut from_daemon = conn.try_clone()?;

    // Daemon -> page: a reader thread, handed over to the WebSocket loop.
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    thread::Builder::new().name("bridge-read".into()).spawn(move || {
        let mut buf = vec![0u8; 256 * 1024];
        loop {
            match from_daemon.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    })?;

    // One loop drives the WebSocket both ways: it is not split into halves.
    ws.get_mut().set_read_timeout(None)?;
    ws.get_mut().set_nonblocking(true)?;
    let result = (|| -> io::Result<()> {
        loop {
            let mut busy = false;
            loop {
                match rx.try_recv() {
                    Ok(bytes) => {
                        busy = true;
                        write(&mut ws, Message::binary(bytes))?;
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                    // The daemon closed the connection.
                    Err(mpsc::TryRecvError::Disconnected) => return Ok(()),
                }
            }
            match ws.flush() {
                Ok(()) => {}
                Err(WsError::Io(e)) if e.kind() == ErrorKind::WouldBlock => busy = true,
                Err(e) => return Err(io::Error::other(e.to_string())),
            }
            match ws.read() {
                Ok(Message::Binary(b)) => {
                    busy = true;
                    conn.write_all(&b)?;
                }
                Ok(Message::Close(_)) => return Ok(()),
                Ok(_) => busy = true,
                Err(WsError::Io(e)) if e.kind() == ErrorKind::WouldBlock => {}
                Err(WsError::ConnectionClosed | WsError::AlreadyClosed) => return Ok(()),
                Err(e) => return Err(io::Error::other(e.to_string())),
            }
            if !busy {
                // Nothing either way: wait briefly for the daemon (the page's
                // input is picked up on the next turn, within 2 ms).
                match rx.recv_timeout(Duration::from_millis(2)) {
                    Ok(bytes) => write(&mut ws, Message::binary(bytes))?,
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => return Ok(()),
                }
            }
        }
    })();
    conn.shutdown();
    result
}

fn write(ws: &mut tungstenite::WebSocket<TcpStream>, m: Message) -> io::Result<()> {
    match ws.write(m) {
        Ok(()) => Ok(()),
        // Queued; the loop flushes it.
        Err(WsError::Io(e)) if e.kind() == ErrorKind::WouldBlock => Ok(()),
        Err(e) => Err(io::Error::other(e.to_string())),
    }
}
