//! Wire protocol between the extension host and the sidecar.
//!
//! Every frame is `u32 LE length | u8 kind | u32 LE session | payload`, where
//! `length` counts the kind, session and payload bytes (so it is at least 5).
//! Control payloads are JSON; `input`, `output` and `replay` payloads are raw
//! bytes; `ack` is a `u32 LE` byte count. Session 0 is used for frames that do
//! not belong to a session (`hello`, global `error`).

use std::io::{self, Read};

pub const PROTOCOL_VERSION: u32 = 1;
/// Largest frame either side will accept. Guards against a corrupt length
/// prefix allocating gigabytes.
pub const MAX_FRAME: usize = 16 * 1024 * 1024;
#[cfg(test)]
pub const HEADER_LEN: usize = 4 + 1 + 4;

pub mod kind {
    // host -> sidecar
    pub const SPAWN: u8 = 2;
    pub const INPUT: u8 = 3;
    pub const RESIZE: u8 = 4;
    pub const ACK: u8 = 6;
    pub const KILL: u8 = 7;
    pub const ATTACH: u8 = 9;
    pub const QUERY_PROCESS: u8 = 13;
    /// Decode an image (iTerm2 inline image file or sixel); see decode.rs.
    pub const DECODE: u8 = 15;
    // sidecar -> host
    pub const HELLO: u8 = 1;
    pub const OUTPUT: u8 = 5;
    pub const EXIT: u8 = 8;
    pub const REPLAY: u8 = 10;
    pub const ERROR: u8 = 11;
    pub const SPAWNED: u8 = 12;
    pub const PROCESS_INFO: u8 = 14;
    /// Reply to DECODE, on the same session id.
    pub const DECODED: u8 = 16;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub kind: u8,
    pub session: u32,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn new(kind: u8, session: u32, payload: Vec<u8>) -> Self {
        Frame { kind, session, payload }
    }

    pub fn json<T: serde::Serialize>(kind: u8, session: u32, value: &T) -> Self {
        // Serialising our own plain structs cannot fail.
        let payload = serde_json::to_vec(value).expect("serialise frame payload");
        Frame { kind, session, payload }
    }

    #[cfg(test)]
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(HEADER_LEN + self.payload.len());
        self.encode_into(&mut out);
        out
    }

    pub fn encode_into(&self, out: &mut Vec<u8>) {
        let len = (1 + 4 + self.payload.len()) as u32;
        out.extend_from_slice(&len.to_le_bytes());
        out.push(self.kind);
        out.extend_from_slice(&self.session.to_le_bytes());
        out.extend_from_slice(&self.payload);
    }
}

/// Read one frame. Returns `Ok(None)` on a clean EOF at a frame boundary.
pub fn read_frame<R: Read>(r: &mut R) -> io::Result<Option<Frame>> {
    let mut len_buf = [0u8; 4];
    if !read_exact_or_eof(r, &mut len_buf)? {
        return Ok(None);
    }
    let len = u32::from_le_bytes(len_buf) as usize;
    if !(5..=MAX_FRAME).contains(&len) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("bad frame length {len}"),
        ));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body)?;
    let kind = body[0];
    let session = u32::from_le_bytes([body[1], body[2], body[3], body[4]]);
    body.drain(..5);
    Ok(Some(Frame { kind, session, payload: body }))
}


fn read_exact_or_eof<R: Read>(r: &mut R, buf: &mut [u8]) -> io::Result<bool> {
    let mut read = 0;
    while read < buf.len() {
        match r.read(&mut buf[read..]) {
            Ok(0) if read == 0 => return Ok(false),
            Ok(0) => {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "truncated frame header"))
            }
            Ok(n) => read += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(true)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRequest {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Complete environment for the child. The sidecar does not inherit its
    /// own environment, so the host is the single source of truth.
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    /// Size of the text area in pixels, for programs that read it from the
    /// PTY (TIOCGWINSZ), such as image viewers. 0 when unknown.
    #[serde(default)]
    pub width: u16,
    #[serde(default)]
    pub height: u16,
    /// Flow-control window in bytes of unacknowledged output.
    #[serde(default)]
    pub window: Option<usize>,
    /// Size of the replay buffer kept for re-attaching webviews.
    #[serde(default)]
    pub replay_limit: Option<usize>,
}

#[derive(Debug, serde::Deserialize)]
pub struct ResizeRequest {
    pub cols: u16,
    pub rows: u16,
    /// Pixel size of the text area; 0 when unknown.
    #[serde(default)]
    pub width: u16,
    #[serde(default)]
    pub height: u16,
}

#[derive(Debug, serde::Serialize)]
pub struct Hello<'a> {
    pub protocol: u32,
    pub build: &'a str,
    pub pid: u32,
    pub os: &'a str,
}

#[derive(Debug, serde::Serialize)]
pub struct Spawned {
    pub pid: Option<u32>,
}

#[derive(Debug, serde::Serialize)]
pub struct Exit {
    pub code: Option<u32>,
    pub signal: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct ErrorMsg {
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    /// Name of the foreground process, when it can be determined.
    pub name: Option<String>,
    /// Whether something other than the shell owns the terminal. `None` when
    /// the platform cannot tell (Windows).
    pub busy: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let f = Frame::new(kind::OUTPUT, 7, b"hello".to_vec());
        let bytes = f.encode();
        assert_eq!(bytes.len(), HEADER_LEN + 5);
        let mut cur = io::Cursor::new(bytes);
        assert_eq!(read_frame(&mut cur).unwrap(), Some(f));
        assert_eq!(read_frame(&mut cur).unwrap(), None);
    }

    #[test]
    fn rejects_bad_length() {
        let mut cur = io::Cursor::new(vec![2, 0, 0, 0, 1, 0]);
        assert!(read_frame(&mut cur).is_err());
        let mut huge = (MAX_FRAME as u32 + 1).to_le_bytes().to_vec();
        huge.extend_from_slice(&[0; 5]);
        assert!(read_frame(&mut io::Cursor::new(huge)).is_err());
    }

    #[test]
    fn truncated_header_is_error() {
        let mut cur = io::Cursor::new(vec![9, 0]);
        assert!(read_frame(&mut cur).is_err());
    }

    #[test]
    fn spawn_request_defaults() {
        let req: SpawnRequest =
            serde_json::from_str(r#"{"command":"/bin/sh","cols":80,"rows":24}"#).unwrap();
        assert!(req.args.is_empty());
        assert!(req.env.is_empty());
        assert!(req.window.is_none());
    }
}
