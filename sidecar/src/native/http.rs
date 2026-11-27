//! Browser mode's HTTP: just enough of HTTP/1.1 to serve the page, its
//! start-up data and two WebSockets on 127.0.0.1, and the checks that keep
//! every other web page out (PLAN-browser-support.md, D5):
//!
//! - `Host` must be 127.0.0.1:<port> or localhost:<port>, so a page that
//!   rebinds its own domain to 127.0.0.1 (DNS rebinding) is refused;
//! - WebSocket handshakes must come from the page's own origin (browsers
//!   always send `Origin` for them, and pages cannot forge it);
//! - /boot.json needs the page's `X-Gty` header, which a page on another
//!   origin cannot send without a CORS preflight, and this server answers no
//!   preflight (no CORS headers, GET only);
//! - only GET.
//!
//! There is no authentication: any process on the machine can connect.

use super::bridge::Nonblocking;
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

const MAX_HEAD: usize = 16 * 1024;

/// A request's first line and headers (names in lower case).
pub struct Head {
    pub method: String,
    /// Without the query.
    pub path: String,
    pub headers: Vec<(String, String)>,
}

impl Head {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }
}

/// What a checked request is for.
#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    /// A page file (the asset table decides whether it exists).
    Asset(String),
    Boot,
    /// The daemon bridge (bridge::pump).
    Daemon,
    /// The page's messages to the program (title, clipboard, links, ...).
    Ipc,
}

/// Reads up to the end of the headers. Returns the head and every byte read
/// (a WebSocket handshake reads the request again from these).
pub fn read_head(stream: &mut TcpStream) -> io::Result<(Head, Vec<u8>)> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    let end = loop {
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "connection closed in the request"));
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        if buf.len() > MAX_HEAD {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "request head too large"));
        }
    };
    let text = std::str::from_utf8(&buf[..end]).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "request head is not UTF-8"))?;
    Ok((parse_head(text)?, buf))
}

pub fn parse_head(text: &str) -> io::Result<Head> {
    let bad = || io::Error::new(io::ErrorKind::InvalidData, "bad request line");
    let mut lines = text.split("\r\n");
    let mut first = lines.next().ok_or_else(bad)?.split(' ');
    let method = first.next().ok_or_else(bad)?.to_string();
    let target = first.next().ok_or_else(bad)?;
    let path = target.split(['?', '#']).next().unwrap_or("/").to_string();
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(n, v)| (n.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    Ok(Head { method, path, headers })
}

/// Decides whether to serve a request; on refusal, the status and a reason.
pub fn check(head: &Head, port: u16) -> Result<Route, (u16, &'static str)> {
    let host = head.header("host").unwrap_or("");
    if host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}") {
        return Err((403, "unexpected Host"));
    }
    if head.method != "GET" {
        return Err((405, "only GET"));
    }
    let own_origin = format!("http://127.0.0.1:{port}");
    let origin = head.header("origin");
    match head.path.as_str() {
        "/ws" | "/ipc" => {
            let upgrade = head.header("upgrade").is_some_and(|u| u.eq_ignore_ascii_case("websocket"));
            if !upgrade {
                return Err((400, "WebSocket only"));
            }
            if origin != Some(own_origin.as_str()) {
                return Err((403, "foreign Origin"));
            }
            Ok(if head.path == "/ws" { Route::Daemon } else { Route::Ipc })
        }
        "/boot.json" => {
            if head.header("x-gty") != Some("boot") {
                return Err((403, "missing X-Gty"));
            }
            if origin.is_some_and(|o| o != own_origin) {
                return Err((403, "foreign Origin"));
            }
            if head.header("sec-fetch-site").is_some_and(|s| s != "same-origin") {
                return Err((403, "not same-origin"));
            }
            Ok(Route::Boot)
        }
        p => Ok(Route::Asset(if p == "/" { "/index.html".into() } else { p.into() })),
    }
}

pub fn respond(stream: &mut TcpStream, status: u16, mime: &str, body: &[u8]) -> io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Error",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store\r\n\
         X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

/// The connection, replaying the bytes already read (the request) first: a
/// WebSocket handshake reads the request itself.
pub struct Replay {
    read: Vec<u8>,
    pos: usize,
    pub stream: TcpStream,
}

impl Replay {
    pub fn new(read: Vec<u8>, stream: TcpStream) -> Replay {
        Replay { read, pos: 0, stream }
    }
}

impl Read for Replay {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.pos < self.read.len() {
            let n = buf.len().min(self.read.len() - self.pos);
            buf[..n].copy_from_slice(&self.read[self.pos..self.pos + n]);
            self.pos += n;
            return Ok(n);
        }
        self.stream.read(buf)
    }
}

impl Write for Replay {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.stream.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.stream.flush()
    }
}

impl Nonblocking for Replay {
    fn nonblocking(&mut self) -> io::Result<()> {
        self.stream.set_nonblocking(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn head(text: &str) -> Head {
        parse_head(text).unwrap()
    }

    const P: u16 = 4242;

    #[test]
    fn page_files_need_only_the_right_host() {
        assert_eq!(check(&head("GET / HTTP/1.1\r\nHost: 127.0.0.1:4242"), P), Ok(Route::Asset("/index.html".into())));
        assert_eq!(check(&head("GET /app.js?x=1 HTTP/1.1\r\nHost: localhost:4242"), P), Ok(Route::Asset("/app.js".into())));
        // DNS rebinding: evil.example resolved to 127.0.0.1.
        assert_eq!(check(&head("GET / HTTP/1.1\r\nHost: evil.example:4242"), P), Err((403, "unexpected Host")));
        assert_eq!(check(&head("GET / HTTP/1.1"), P), Err((403, "unexpected Host")));
        assert_eq!(check(&head("POST / HTTP/1.1\r\nHost: 127.0.0.1:4242"), P), Err((405, "only GET")));
        assert_eq!(check(&head("OPTIONS /boot.json HTTP/1.1\r\nHost: 127.0.0.1:4242"), P), Err((405, "only GET")));
    }

    #[test]
    fn websockets_need_the_page_origin() {
        let ok = "GET /ws HTTP/1.1\r\nHost: 127.0.0.1:4242\r\nUpgrade: websocket\r\nOrigin: http://127.0.0.1:4242";
        assert_eq!(check(&head(ok), P), Ok(Route::Daemon));
        assert_eq!(check(&head(&ok.replace("/ws", "/ipc")), P), Ok(Route::Ipc));
        let foreign = ok.replace("Origin: http://127.0.0.1:4242", "Origin: https://evil.example");
        assert_eq!(check(&head(&foreign), P), Err((403, "foreign Origin")));
        let other_port = ok.replace("Origin: http://127.0.0.1:4242", "Origin: http://127.0.0.1:9999");
        assert_eq!(check(&head(&other_port), P), Err((403, "foreign Origin")));
        let none = ok.replace("\r\nOrigin: http://127.0.0.1:4242", "");
        assert_eq!(check(&head(&none), P), Err((403, "foreign Origin")));
        assert_eq!(check(&head("GET /ws HTTP/1.1\r\nHost: 127.0.0.1:4242"), P), Err((400, "WebSocket only")));
    }

    #[test]
    fn boot_needs_the_page_header_and_same_origin() {
        let ok = "GET /boot.json HTTP/1.1\r\nHost: 127.0.0.1:4242\r\nX-Gty: boot\r\nSec-Fetch-Site: same-origin";
        assert_eq!(check(&head(ok), P), Ok(Route::Boot));
        // Browsers without Sec-Fetch-Site still send the header.
        assert_eq!(check(&head("GET /boot.json HTTP/1.1\r\nHost: 127.0.0.1:4242\r\nX-Gty: boot"), P), Ok(Route::Boot));
        assert_eq!(check(&head("GET /boot.json HTTP/1.1\r\nHost: 127.0.0.1:4242"), P), Err((403, "missing X-Gty")));
        let cross = ok.replace("same-origin", "cross-site");
        assert_eq!(check(&head(&cross), P), Err((403, "not same-origin")));
        let foreign = format!("{ok}\r\nOrigin: https://evil.example");
        assert_eq!(check(&head(&foreign), P), Err((403, "foreign Origin")));
    }
}
