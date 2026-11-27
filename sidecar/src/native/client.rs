//! Finding, starting and connecting to the sidecar daemon: the same steps as
//! the extension's src/daemon.ts, so the app, browser mode and VS Code share
//! one daemon (and so their sessions). The daemon is the running binary
//! itself, run as `--server`: gty, gty-browser and gty-sidecar all have it.

use serde::Deserialize;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::protocol::{kind, PROTOCOL_VERSION as PROTOCOL};

#[derive(Deserialize)]
struct State {
    pid: u32,
    protocol: u32,
    token: String,
    socket: Option<String>,
    port: Option<u16>,
}

/// Per-user directory: as defaultDaemonDir() in src/daemon.ts.
pub fn default_dir() -> PathBuf {
    #[cfg(windows)]
    {
        let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
        base.join("code-gty")
    }
    #[cfg(unix)]
    {
        if let Some(rt) = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from) {
            if rt.is_dir() {
                return rt.join("code-gty");
            }
        }
        // SAFETY: getuid cannot fail.
        let uid = unsafe { libc::getuid() };
        std::env::temp_dir().join(format!("code-gty-{uid}"))
    }
}

/// Creates `dir` private to this user (0700), as the daemon does.
pub fn private_dir(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    fs::create_dir_all(dir)?;
    Ok(())
}

fn read_state(dir: &Path) -> Option<State> {
    let s: State = serde_json::from_slice(&fs::read(dir.join(format!("daemon-v{PROTOCOL}.json"))).ok()?).ok()?;
    (s.protocol == PROTOCOL && !s.token.is_empty()).then_some(s)
}

/// A connection to the daemon, after authenticating.
pub enum Conn {
    #[cfg(unix)]
    Unix(std::os::unix::net::UnixStream),
    Tcp(std::net::TcpStream),
}

impl Conn {
    pub fn try_clone(&self) -> io::Result<Conn> {
        Ok(match self {
            #[cfg(unix)]
            Conn::Unix(s) => Conn::Unix(s.try_clone()?),
            Conn::Tcp(s) => Conn::Tcp(s.try_clone()?),
        })
    }
    pub fn shutdown(&self) {
        let _ = match self {
            #[cfg(unix)]
            Conn::Unix(s) => s.shutdown(std::net::Shutdown::Both),
            Conn::Tcp(s) => s.shutdown(std::net::Shutdown::Both),
        };
    }
}

impl Read for Conn {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            #[cfg(unix)]
            Conn::Unix(s) => s.read(buf),
            Conn::Tcp(s) => s.read(buf),
        }
    }
}

impl Write for Conn {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            #[cfg(unix)]
            Conn::Unix(s) => s.write(buf),
            Conn::Tcp(s) => s.write(buf),
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Conn::Unix(s) => s.flush(),
            Conn::Tcp(s) => s.flush(),
        }
    }
}

fn connect(state: &State) -> io::Result<Conn> {
    let mut conn = match (&state.socket, state.port) {
        #[cfg(unix)]
        (Some(path), _) => Conn::Unix(std::os::unix::net::UnixStream::connect(path)?),
        (_, Some(port)) => {
            let s = std::net::TcpStream::connect(("127.0.0.1", port))?;
            s.set_nodelay(true)?;
            Conn::Tcp(s)
        }
        _ => return Err(io::Error::other("daemon state has no address")),
    };
    // The token proves we are this user: only they can read the state file.
    let token = state.token.as_bytes();
    let mut frame = Vec::with_capacity(9 + token.len());
    frame.extend_from_slice(&((5 + token.len()) as u32).to_le_bytes());
    frame.push(kind::AUTH);
    frame.extend_from_slice(&0u32.to_le_bytes());
    frame.extend_from_slice(token);
    conn.write_all(&frame)?;
    Ok(conn)
}

pub struct Daemon {
    pub dir: PathBuf,
    /// libghostty-vt for keeping detached sessions current.
    pub vt: PathBuf,
}

impl Daemon {
    /// Connects to the running daemon, starting one (this binary) if there is none.
    pub fn connect(&self) -> io::Result<Conn> {
        let existing = read_state(&self.dir);
        if let Some(s) = &existing {
            if let Ok(c) = connect(s) {
                return Ok(c);
            }
            // Stale state from a daemon that is gone: start a new one.
        }
        private_dir(&self.dir)?;
        let log_path = self.dir.join("sidecar.log");
        let log = fs::OpenOptions::new().create(true).append(true).open(&log_path)?;
        // This binary again. On Linux by /proc/self/exe, which also works when
        // the launcher runs it from memory (a memfd), where the path
        // current_exe gives ("/memfd:gty (deleted)") cannot be run.
        #[cfg(target_os = "linux")]
        let exe = PathBuf::from("/proc/self/exe");
        #[cfg(not(target_os = "linux"))]
        let exe = std::env::current_exe()?;
        let mut cmd = Command::new(exe);
        cmd.arg("--server").arg(&self.dir).arg("--vt").arg(&self.vt);
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(log);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Its own session, so it outlives this app and its terminal.
            // SAFETY: setsid is async-signal-safe.
            unsafe {
                cmd.pre_exec(|| {
                    libc::setsid();
                    Ok(())
                });
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // Detached from this app (as Node's `detached: true`), so it
            // outlives it, with no console window.
            const DETACHED_PROCESS: u32 = 0x0000_0008;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
        }
        let child = cmd.spawn()?;
        eprintln!("[gty] started sidecar daemon (pid {}), log: {}", child.id(), log_path.display());
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut last = io::Error::other("no state file");
        while Instant::now() < deadline {
            if let Some(s) = read_state(&self.dir) {
                if Some(s.pid) != existing.as_ref().map(|e| e.pid) {
                    match connect(&s) {
                        Ok(c) => return Ok(c),
                        Err(e) => last = e,
                    }
                }
            }
            thread::sleep(Duration::from_millis(50));
        }
        Err(io::Error::other(format!("the sidecar daemon did not start: {last} (see {})", log_path.display())))
    }
}

/// Asks the daemon to end session `id` (as Manage Sessions' kill does).
pub fn kill(conn: &mut Conn, id: u32) -> io::Result<()> {
    let mut frame = Vec::with_capacity(9);
    frame.extend_from_slice(&5u32.to_le_bytes());
    frame.push(kind::KILL);
    frame.extend_from_slice(&id.to_le_bytes());
    conn.write_all(&frame)?;
    conn.flush()
}

/// Writes `data` to `path` unless it is already there with that content.
pub fn write_once(path: &Path, data: &[u8]) -> io::Result<()> {
    if fs::read(path).map(|d| d == data).unwrap_or(false) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    fs::write(&tmp, data)?;
    fs::rename(&tmp, path)
}
