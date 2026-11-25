//! Which client gets each session's output, and what happens while no client
//! has it.
//!
//! Every session's output and frames come through one router thread, which
//! keeps them in order. A session has at most one owner (a VS Code window).
//!
//! While owned, output goes to the owner, and the router also keeps the
//! owner's latest checkpoint (a libghostty-vt snapshot at a known output
//! position) plus every byte after it. If the owner disappears (window
//! reloaded, closed or crashed) the session is detached: the checkpoint is
//! restored into an engine of our own (vtengine.rs), the bytes after it are
//! replayed, and from then on output feeds that engine, on its own thread,
//! for as long as nobody claims the session.
//!
//! A claim (a reloaded tab reclaiming its session, or another window taking
//! it over) is answered with an exact snapshot: from the detached engine, or
//! built from the checkpoint and the bytes after it. If the client that owned
//! the session is still connected, it is told the session moved.

use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::protocol::{kind, ErrorMsg, Frame};
use crate::session::{Out, Session};
use crate::vtengine::{VtModule, VtTerm};

pub type ClientId = u64;
pub type Sessions = Arc<Mutex<HashMap<u32, Session>>>;

/// Bytes kept after the last checkpoint. Owners checkpoint every few seconds,
/// so this only fills if one stops (a hung window): then restore falls back
/// to the raw replay buffer.
const TAIL_MAX: usize = 32 * 1024 * 1024;
const DEFAULT_SCROLLBACK: u32 = 10_000;

pub enum Ctl {
    /// A client connected; frames for it go to this writer.
    NewClient(ClientId, Sender<Out>),
    ClientGone(ClientId),
    /// A session was spawned by a client, which owns it.
    Spawned { client: ClientId, session: u32, cols: u16, rows: u16 },
    Resized { session: u32, cols: u16, rows: u16 },
    Claim { client: ClientId, session: u32 },
    Checkpoint { client: ClientId, session: u32, position: u64, meta: Vec<u8>, snapshot: Vec<u8> },
    List(ClientId),
    Killed(u32),
}

enum EngineMsg {
    Data(Vec<u8>),
    Snapshot(Sender<Result<Vec<u8>, String>>),
}

struct Detached {
    tx: Sender<EngineMsg>,
}

struct Route {
    owner: Option<ClientId>,
    /// Output bytes routed so far.
    seq: u64,
    /// `seq` when the current owner got the session; owners count from there.
    base: u64,
    checkpoint: Option<(u64, Vec<u8>)>,
    /// Output from `tail_start` on (the checkpoint position, or `base`).
    tail: Vec<u8>,
    tail_start: u64,
    tail_lost: bool,
    meta: serde_json::Value,
    cols: u16,
    rows: u16,
    exit: Option<Frame>,
    detached: Option<Detached>,
    created_ms: u64,
}

impl Route {
    fn new(owner: Option<ClientId>, cols: u16, rows: u16) -> Route {
        Route {
            owner,
            seq: 0,
            base: 0,
            checkpoint: None,
            tail: Vec::new(),
            tail_start: 0,
            tail_lost: false,
            meta: serde_json::Value::Null,
            cols,
            rows,
            exit: None,
            detached: None,
            created_ms: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
        }
    }

    fn scrollback(&self) -> u32 {
        self.meta.get("scrollback").and_then(|v| v.as_u64()).map_or(DEFAULT_SCROLLBACK, |v| v.min(u64::from(u32::MAX)) as u32)
    }
}

pub struct Router {
    clients: HashMap<ClientId, Sender<Out>>,
    routes: HashMap<u32, Route>,
    sessions: Sessions,
    module: Option<Arc<VtModule>>,
    /// Daemon mode keeps sessions of departed clients; stdio mode has one
    /// client and ends everything when it goes.
    pub persistent: bool,
}

fn json_frame<T: serde::Serialize>(k: u8, session: u32, v: &T) -> Out {
    Out::Frame(Frame::json(k, session, v))
}

impl Router {
    pub fn new(sessions: Sessions, module: Option<Arc<VtModule>>, persistent: bool) -> Router {
        Router { clients: HashMap::new(), routes: HashMap::new(), sessions, module, persistent }
    }

    /// Runs until every sender is gone.
    pub fn run(mut self, rx: Receiver<Out>) {
        for msg in rx {
            match msg {
                Out::Data(id, data) => self.data(id, data),
                Out::Frame(f) => self.frame(f),
                Out::Ctl(c) => self.ctl(c),
            }
        }
    }

    fn send(&self, client: ClientId, out: Out) {
        if let Some(tx) = self.clients.get(&client) {
            let _ = tx.send(out);
        }
    }

    fn ack(&self, session: u32, n: usize) {
        if let Some(s) = self.sessions.lock().unwrap().get(&session) {
            s.ack(n);
        }
    }

    fn data(&mut self, id: u32, data: Vec<u8>) {
        let Some(r) = self.routes.get_mut(&id) else {
            // Not routed (stdio legacy before Spawned arrives cannot happen;
            // a killed session's trailing output): release its credit.
            self.ack(id, data.len());
            return;
        };
        r.seq += data.len() as u64;
        if let Some(owner) = r.owner {
            if !r.tail_lost {
                if r.tail.len() + data.len() > TAIL_MAX {
                    r.tail = Vec::new();
                    r.checkpoint = None;
                    r.tail_lost = true;
                } else {
                    r.tail.extend_from_slice(&data);
                }
            }
            if let Some(tx) = self.clients.get(&owner) {
                let _ = tx.send(Out::Data(id, data));
            }
            return;
        }
        let n = data.len();
        match &r.detached {
            // The engine thread acknowledges once it has parsed the bytes.
            Some(d) => {
                let _ = d.tx.send(EngineMsg::Data(data));
            }
            None => self.ack(id, n),
        }
    }

    fn frame(&mut self, f: Frame) {
        let id = f.session;
        let Some(r) = self.routes.get_mut(&id) else { return };
        if f.kind == kind::EXIT {
            r.exit = Some(f.clone());
        }
        if let Some(owner) = r.owner {
            self.send(owner, Out::Frame(f));
        }
    }

    fn ctl(&mut self, c: Ctl) {
        match c {
            Ctl::NewClient(id, tx) => {
                self.clients.insert(id, tx);
            }
            Ctl::ClientGone(client) => {
                self.clients.remove(&client);
                let owned: Vec<u32> = self.routes.iter().filter(|(_, r)| r.owner == Some(client)).map(|(id, _)| *id).collect();
                for id in owned {
                    self.detach(id);
                }
            }
            Ctl::Spawned { client, session, cols, rows } => {
                self.routes.insert(session, Route::new(Some(client), cols, rows));
            }
            Ctl::Resized { session, cols, rows } => {
                if let Some(r) = self.routes.get_mut(&session) {
                    r.cols = cols;
                    r.rows = rows;
                }
            }
            Ctl::Checkpoint { client, session, position, meta, snapshot } => {
                let Some(r) = self.routes.get_mut(&session) else { return };
                if r.owner != Some(client) {
                    return;
                }
                let abs = r.base + position;
                if abs > r.seq || abs < r.tail_start {
                    return;
                }
                let drop = (abs - r.tail_start) as usize;
                if !r.tail_lost {
                    r.tail.drain(..drop.min(r.tail.len()));
                } else {
                    // A fresh checkpoint makes the bytes from here on useful again.
                    r.tail = Vec::new();
                    r.tail_lost = abs != r.seq;
                }
                r.tail_start = abs;
                r.checkpoint = Some((abs, snapshot));
                if let Ok(m) = serde_json::from_slice::<serde_json::Value>(&meta) {
                    r.meta = m;
                }
            }
            Ctl::List(client) => {
                let list = self.list(client);
                self.send(client, json_frame(kind::SESSIONS, 0, &list));
            }
            Ctl::Claim { client, session } => self.claim(client, session),
            Ctl::Killed(session) => {
                self.routes.remove(&session);
            }
        }
    }

    fn list(&self, client: ClientId) -> Vec<serde_json::Value> {
        let sessions = self.sessions.lock().unwrap();
        let mut out: Vec<serde_json::Value> = self
            .routes
            .iter()
            .map(|(id, r)| {
                let s = sessions.get(id);
                serde_json::json!({
                    "id": id,
                    "pid": s.and_then(|s| s.pid()),
                    "exited": r.exit.is_some() || s.is_none_or(|s| s.is_exited()),
                    "attached": r.owner.is_some(),
                    "mine": r.owner == Some(client),
                    "cols": r.cols,
                    "rows": r.rows,
                    "created": r.created_ms,
                    "meta": r.meta,
                })
            })
            .collect();
        out.sort_by_key(|v| v["created"].as_u64());
        out
    }

    /// The session's current state: an exact snapshot when possible, else
    /// the raw replay buffer. Returns (bytes, exact).
    fn state(&mut self, id: u32) -> (Vec<u8>, bool) {
        let r = self.routes.get_mut(&id).unwrap();
        if let Some(d) = r.detached.take() {
            let (tx, rx) = mpsc::channel();
            if d.tx.send(EngineMsg::Snapshot(tx)).is_ok() {
                if let Ok(Ok(snap)) = rx.recv() {
                    return (snap, true);
                }
            }
        }
        if let Some(module) = &self.module {
            if !r.tail_lost {
                let built = match &r.checkpoint {
                    Some((_, snap)) => VtTerm::restore(module, snap, r.scrollback()),
                    None => VtTerm::new(module, r.cols, r.rows, r.scrollback()),
                };
                if let Ok(mut t) = built {
                    if t.write(&r.tail).is_ok() {
                        if let Ok(snap) = t.snapshot() {
                            return (snap, true);
                        }
                    }
                }
            }
        }
        let replay = self.sessions.lock().unwrap().get(&id).map(|s| s.replay_bytes().0).unwrap_or_default();
        (replay, false)
    }

    fn claim(&mut self, client: ClientId, id: u32) {
        if !self.routes.contains_key(&id) {
            self.send(client, json_frame(kind::ERROR, id, &ErrorMsg { message: format!("no session {id}") }));
            return;
        }
        let (bytes, exact) = self.state(id);
        let r = self.routes.get_mut(&id).unwrap();
        let previous = r.owner.replace(client);
        r.base = r.seq;
        r.checkpoint = if exact { Some((r.seq, bytes.clone())) } else { None };
        r.tail = Vec::new();
        r.tail_start = r.seq;
        r.tail_lost = !exact;
        let (cols, rows, meta, exit) = (r.cols, r.rows, r.meta.clone(), r.exit.clone());
        let (pid, exited) = {
            let sessions = self.sessions.lock().unwrap();
            let s = sessions.get(&id);
            if let Some(s) = s {
                // The new owner acknowledges from here on.
                s.reset_credit();
            }
            (s.and_then(|s| s.pid()), exit.is_some() || s.is_none_or(|s| s.is_exited()))
        };
        if let Some(prev) = previous.filter(|p| *p != client) {
            self.send(prev, json_frame(kind::DETACHED, id, &serde_json::json!({ "reason": "claimed" })));
        }
        let head = serde_json::to_vec(&serde_json::json!({ "cols": cols, "rows": rows, "pid": pid, "exact": exact, "exited": exited, "meta": meta })).unwrap();
        let mut payload = (head.len() as u32).to_le_bytes().to_vec();
        payload.extend_from_slice(&head);
        payload.extend_from_slice(&bytes);
        self.send(client, Out::Frame(Frame::new(kind::CLAIMED, id, payload)));
        if let Some(e) = exit {
            self.send(client, Out::Frame(e));
        }
    }

    /// The owner is gone: keep the session's state current in our own engine.
    fn detach(&mut self, id: u32) {
        let Some(r) = self.routes.get_mut(&id) else { return };
        r.owner = None;
        if let Some(s) = self.sessions.lock().unwrap().get(&id) {
            // In-flight output died with the client.
            s.reset_credit();
        }
        if !self.persistent {
            return;
        }
        let Some(module) = self.module.clone() else { return };
        let mut term = if r.tail_lost {
            // No usable checkpoint: start from the raw replay buffer.
            let replay = self.sessions.lock().unwrap().get(&id).map(|s| s.replay_bytes().0).unwrap_or_default();
            VtTerm::new(&module, r.cols, r.rows, r.scrollback()).and_then(|mut t| t.write(&replay).map(|_| t))
        } else {
            match &r.checkpoint {
                Some((_, snap)) => VtTerm::restore(&module, snap, r.scrollback()),
                None => VtTerm::new(&module, r.cols, r.rows, r.scrollback()),
            }
            .and_then(|mut t| t.write(&r.tail).map(|_| t))
        };
        let term = match term.as_mut() {
            Ok(_) => term.unwrap(),
            Err(e) => {
                eprintln!("[gty-sidecar] session {id}: cannot keep a detached engine: {e}");
                return;
            }
        };
        r.tail = Vec::new();
        let (tx, rx) = mpsc::channel::<EngineMsg>();
        let sessions = self.sessions.clone();
        let spawned = thread::Builder::new().name(format!("vt-{id}")).spawn(move || engine_loop(id, term, rx, sessions));
        if spawned.is_ok() {
            r.detached = Some(Detached { tx });
        }
    }
}

/// Feeds a detached session's output into its engine, acknowledging it after
/// parsing so the PTY never outruns the engine.
fn engine_loop(id: u32, mut term: VtTerm, rx: Receiver<EngineMsg>, sessions: Sessions) {
    for msg in rx {
        match msg {
            EngineMsg::Data(d) => {
                if let Err(e) = term.write(&d) {
                    eprintln!("[gty-sidecar] session {id}: engine write failed: {e}");
                }
                if let Some(s) = sessions.lock().unwrap().get(&id) {
                    s.ack(d.len());
                }
            }
            EngineMsg::Snapshot(reply) => {
                let _ = reply.send(term.snapshot());
                // The claiming client takes over from here.
                return;
            }
        }
    }
}
