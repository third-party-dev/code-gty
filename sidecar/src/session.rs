//! One PTY session: a shell, its reader/writer threads, flow control and the
//! replay buffer.

use crate::procinfo;
use crate::protocol::{kind, Exit, Frame, ProcessInfo, SpawnRequest, Spawned};
use crate::replay::Replay;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

pub const DEFAULT_WINDOW: usize = 256 * 1024;
pub const DEFAULT_REPLAY: usize = 2 * 1024 * 1024;
const READ_CHUNK: usize = 64 * 1024;
/// How long the exit frame waits for the reader to drain trailing output.
const DRAIN_GRACE: Duration = Duration::from_millis(1000);
#[cfg(unix)]
const KILL_GRACE: Duration = Duration::from_secs(2);

/// Messages for the single thread that owns stdout.
pub enum Out {
    /// PTY output, eligible for coalescing.
    Data(u32, Vec<u8>),
    Frame(Frame),
}

struct Flow {
    unacked: usize,
    window: usize,
    closed: bool,
}

#[derive(Default)]
struct Done {
    reader_eof: bool,
    exited: bool,
}

struct Shared {
    flow: Mutex<Flow>,
    flow_cv: Condvar,
    replay: Mutex<Replay>,
    done: Mutex<Done>,
    done_cv: Condvar,
}

pub struct Session {
    id: u32,
    shared: Arc<Shared>,
    master: Box<dyn MasterPty + Send>,
    input: Sender<Vec<u8>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<u32>,
    last_info: Option<ProcessInfo>,
}

impl Session {
    pub fn spawn(id: u32, req: SpawnRequest, out: Sender<Out>) -> Result<Session, String> {
        let pty = native_pty_system();
        let pair = pty
            .openpty(size(req.cols, req.rows, req.width, req.height))
            .map_err(|e| format!("openpty failed: {e}"))?;

        let mut cmd = CommandBuilder::new(&req.command);
        cmd.args(&req.args);
        cmd.env_clear();
        for (k, v) in &req.env {
            cmd.env(k, v);
        }
        if let Some(cwd) = req.cwd.as_deref().filter(|c| std::path::Path::new(c).is_dir()) {
            cmd.cwd(cwd);
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("failed to start {}: {e}", req.command))?;
        // The slave must be closed here, or the reader never sees EOF.
        drop(pair.slave);

        let pid = child.process_id();
        let killer = child.clone_killer();
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        let shared = Arc::new(Shared {
            flow: Mutex::new(Flow {
                unacked: 0,
                window: req.window.unwrap_or(DEFAULT_WINDOW).max(4096),
                closed: false,
            }),
            flow_cv: Condvar::new(),
            replay: Mutex::new(Replay::new(req.replay_limit.unwrap_or(DEFAULT_REPLAY))),
            done: Mutex::new(Done::default()),
            done_cv: Condvar::new(),
        });

        // Announce before any output can be sent.
        let _ = out.send(Out::Frame(Frame::json(kind::SPAWNED, id, &Spawned { pid })));

        // Reader: PTY -> stdout thread, gated by the flow-control window.
        {
            let shared = shared.clone();
            let out = out.clone();
            thread::Builder::new()
                .name(format!("pty-read-{id}"))
                .spawn(move || {
                    let mut buf = vec![0u8; READ_CHUNK];
                    loop {
                        {
                            let mut flow = shared.flow.lock().unwrap();
                            while flow.unacked >= flow.window && !flow.closed {
                                flow = shared.flow_cv.wait(flow).unwrap();
                            }
                            if flow.closed {
                                break;
                            }
                        }
                        let n = match reader.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => n,
                            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                            // Linux reports EIO once the slave side is gone.
                            Err(_) => break,
                        };
                        // Replay and channel are updated under one lock so an
                        // attach snapshot is ordered exactly against Data.
                        let mut replay = shared.replay.lock().unwrap();
                        replay.push(&buf[..n]);
                        shared.flow.lock().unwrap().unacked += n;
                        if out.send(Out::Data(id, buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                    shared.done.lock().unwrap().reader_eof = true;
                    shared.done_cv.notify_all();
                })
                .map_err(|e| e.to_string())?;
        }

        // Writer: input frames -> PTY, on its own thread so a shell that is
        // not reading cannot stall other sessions.
        let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>();
        thread::Builder::new()
            .name(format!("pty-write-{id}"))
            .spawn(move || {
                for data in input_rx {
                    if writer.write_all(&data).and_then(|_| writer.flush()).is_err() {
                        break;
                    }
                }
            })
            .map_err(|e| e.to_string())?;

        // Waiter: reap the child, let the reader drain, then report exit.
        {
            let shared = shared.clone();
            thread::Builder::new()
                .name(format!("pty-wait-{id}"))
                .spawn(move || {
                    let status = child.wait();
                    let mut done = shared.done.lock().unwrap();
                    done.exited = true;
                    let (done, _) = shared
                        .done_cv
                        .wait_timeout_while(done, DRAIN_GRACE, |d| !d.reader_eof)
                        .unwrap();
                    drop(done);
                    let exit = match status {
                        Ok(s) => Exit {
                            code: if s.signal().is_some() { None } else { Some(s.exit_code()) },
                            signal: s.signal().map(str::to_string),
                        },
                        Err(_) => Exit { code: None, signal: None },
                    };
                    let _ = out.send(Out::Frame(Frame::json(kind::EXIT, id, &exit)));
                })
                .map_err(|e| e.to_string())?;
        }

        Ok(Session {
            id,
            shared,
            master: pair.master,
            input: input_tx,
            killer,
            pid,
            last_info: None,
        })
    }

    pub fn input(&self, data: Vec<u8>) {
        let _ = self.input.send(data);
    }

    pub fn resize(&self, cols: u16, rows: u16, width: u16, height: u16) -> Result<(), String> {
        self.master.resize(size(cols, rows, width, height)).map_err(|e| e.to_string())
    }

    pub fn ack(&self, bytes: usize) {
        let mut flow = self.shared.flow.lock().unwrap();
        flow.unacked = flow.unacked.saturating_sub(bytes);
        self.shared.flow_cv.notify_all();
    }

    /// Queue the replay buffer for a freshly attached webview. Credit is reset
    /// to the replay size, since earlier in-flight output died with the old
    /// webview and the new one acks the replay as it draws it.
    pub fn attach(&self, out: &Sender<Out>) {
        let replay = self.shared.replay.lock().unwrap();
        let snapshot = replay.snapshot();
        {
            let mut flow = self.shared.flow.lock().unwrap();
            flow.unacked = snapshot.len();
            self.shared.flow_cv.notify_all();
        }
        let mut payload = Vec::with_capacity(snapshot.len() + 1);
        payload.push(replay.truncated() as u8);
        payload.extend_from_slice(&snapshot);
        let _ = out.send(Out::Frame(Frame::new(kind::REPLAY, self.id, payload)));
    }

    /// Foreground process info, or `None` when unchanged since the last call
    /// with `only_changes`.
    pub fn process_info(&mut self, only_changes: bool) -> Option<ProcessInfo> {
        #[cfg(unix)]
        let fg = self.master.process_group_leader();
        #[cfg(not(unix))]
        let fg: Option<i32> = None;
        let info = procinfo::describe(fg, self.pid);
        if only_changes && self.last_info.as_ref() == Some(&info) {
            return None;
        }
        self.last_info = Some(info.clone());
        Some(info)
    }

    fn close_flow(&self) {
        let mut flow = self.shared.flow.lock().unwrap();
        flow.closed = true;
        self.shared.flow_cv.notify_all();
    }

    #[cfg(unix)]
    fn signal_group(&self, sig: libc::c_int) -> bool {
        match self.pid {
            // SAFETY: plain syscall on a pid we spawned. portable-pty calls
            // setsid() in the child, so its pid is also its process group id.
            Some(pid) => unsafe { libc::kill(-(pid as libc::pid_t), sig) == 0 },
            None => false,
        }
    }

    /// Hang up the whole process group, escalating to SIGKILL if it lingers.
    pub fn kill(mut self) {
        self.close_flow();
        #[cfg(unix)]
        if self.signal_group(libc::SIGHUP) {
            let shared = self.shared.clone();
            let pid = self.pid.unwrap_or(0) as libc::pid_t;
            let _ = thread::Builder::new().name("pty-reap".into()).spawn(move || {
                let done = shared.done.lock().unwrap();
                let (done, _) =
                    shared.done_cv.wait_timeout_while(done, KILL_GRACE, |d| !d.exited).unwrap();
                if !done.exited {
                    // SAFETY: see signal_group.
                    unsafe {
                        libc::kill(-pid, libc::SIGKILL);
                    }
                }
            });
            return;
        }
        let _ = self.killer.kill();
    }

    /// Used on shutdown: hang up now, and `force_kill` whatever is left later.
    pub fn hangup(&mut self) {
        self.close_flow();
        #[cfg(unix)]
        if self.signal_group(libc::SIGHUP) {
            return;
        }
        let _ = self.killer.kill();
    }

    pub fn force_kill(&mut self) {
        #[cfg(unix)]
        if self.signal_group(libc::SIGKILL) {
            return;
        }
        let _ = self.killer.kill();
    }

    pub fn is_exited(&self) -> bool {
        self.shared.done.lock().unwrap().exited
    }
}

fn size(cols: u16, rows: u16, width: u16, height: u16) -> PtySize {
    PtySize { cols: cols.max(1), rows: rows.max(1), pixel_width: width, pixel_height: height }
}
