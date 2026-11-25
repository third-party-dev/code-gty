# Sidecar protocol (version 2)

The sidecar runs in one of two modes. With `codeGty.persistentSessions` off, the extension host starts `gty-sidecar` with no arguments and talks to it over stdin and stdout. stderr is free-form log text. When stdin closes, the sidecar sends SIGHUP to every session's process group, sends SIGKILL to any group still alive after one second, and exits. With persistent sessions (the default), one daemon per user serves every window; see [Daemon](#daemon).

## Framing

```
u32 LE length | u8 kind | u32 LE session | payload
```

`length` counts kind, session and payload, so it is at least 5. Frames over 16 MiB are a protocol error. Session 0 is for frames that do not belong to a session.

## Frames

| Kind | Name | Direction | Payload |
| --- | --- | --- | --- |
| 1 | `hello` | sidecar to host | JSON `{protocol, build, pid, os}`, always the first frame |
| 2 | `spawn` | host to sidecar | JSON `{command, args, env, cwd?, cols, rows, width?, height?, window?, replayLimit?}` |
| 12 | `spawned` | sidecar to host | JSON `{pid}` |
| 3 | `input` | host to sidecar | raw bytes for the PTY |
| 15 | `decode` | host to sidecar | Binary: `u32 request id, u8 kind (0 image file, 1 sixel DCS body), u8 flags (bit 0: sixel transparent), u8[4] background RGBA, data`. Decoded on a worker thread (at most 4 at once) with size limits; panics are caught. |
| 16 | `decoded` | sidecar to host | Binary: `u32 request id, u8 status`; on success `u32 width, u32 height, u32 frames`, then per frame `u32 delay ms, u32 length, zlib-compressed RGBA`; on failure a UTF-8 message. |
| 4 | `resize` | host to sidecar | JSON `{cols, rows, width?, height?}` (`width` and `height`: the text area in pixels, reported through `TIOCGWINSZ`; 0 when unknown) |
| 5 | `output` | sidecar to host | raw PTY bytes |
| 6 | `ack` | host to sidecar | `u32 LE` count of output bytes drawn |
| 9 | `attach` | host to sidecar | empty; asks for a replay |
| 10 | `replay` | sidecar to host | `u8 truncated` followed by the replay bytes |
| 7 | `kill` | host to sidecar | empty |
| 8 | `exit` | sidecar to host | JSON `{code, signal}` |
| 13 | `query_process` | host to sidecar | empty |
| 14 | `process_info` | sidecar to host | JSON `{name, busy}`; also pushed whenever the foreground process changes (Unix) |
| 11 | `error` | sidecar to host | JSON `{message}` |
| 17 | `auth` | host to daemon | the token from the state file; must be the first frame on a daemon connection |
| 18 | `list` | host to daemon | empty |
| 19 | `sessions` | daemon to host | JSON array of `{id, pid, exited, attached, mine, cols, rows, created (ms since epoch), meta}` |
| 20 | `claim` | host to daemon | empty; takes the session over |
| 21 | `claimed` | daemon to host | `u32 LE json length`, JSON `{cols, rows, pid, exact, exited, meta}`, then the data: a libghostty-vt snapshot when `exact`, else the recent raw output |
| 22 | `detached` | daemon to host | JSON `{reason}`; another window claimed the session |
| 23 | `checkpoint` | host to daemon | `u64 LE stream position`, `u32 LE meta length`, JSON meta, libghostty-vt snapshot |

`env` is the child's complete environment: the sidecar does not pass on its own.

## Flow control

Each session has a window (`codeGty.flowControlWindow`, default 256 KiB). The reader thread stops reading the PTY while unacknowledged output is at or above the window, so the overshoot is at most one 64 KiB read. Output first goes through the host's libghostty-vt engine, which forwards the same bytes to the webview. The webview acks each chunk once its mirror engine has parsed it, and the host passes the credit on. Parsing, not drawing, is the cost the window has to bound, and drawing pauses in hidden tabs. When no webview can draw (not ready, or hidden without `retainContextWhenHidden`), the host acks on its behalf and the next webview starts from a snapshot of the host engine. Bytes the host injects itself (notices, Clear) carry no credit.

## Coalescing

The single stdout thread merges output that arrives within 4 ms (up to 128 KiB) into one frame per session. Control frames flush pending output first, so frame order always matches event order.

## Replay

Each session keeps the last `replayLimit` bytes (default 2 MiB). `attach` snapshots the buffer under the same lock the reader uses to queue output. Every `output` frame queued before the snapshot is therefore also in the replay, and the host drops `output` frames between sending `attach` and receiving `replay`. `attach` resets the session's credit to the replay size.

## Daemon

`gty-sidecar --server <dir> --vt <ghostty-vt.wasm>` keeps sessions alive when windows reload or close, so the next window (or any other window of the same user) can reattach to them, like tmux.

- **Finding it.** `<dir>` is `$XDG_RUNTIME_DIR/code-gty`, else `$TMPDIR/code-gty-<uid>`, or `%LOCALAPPDATA%\code-gty` on Windows; it is created with mode 0700. The daemon writes `daemon-v2.json` there (mode 0600): `{pid, protocol, build, token, socket}` on Unix (a socket in the same directory, mode 0600) or `{..., port}` on Windows (a loopback TCP port, with an exclusive lock file so only one daemon runs). A host that finds no live daemon starts one detached from itself, with its log in `<dir>/sidecar.log`.
- **Authentication.** The first frame on a connection must be `auth` with the token, compared in constant time. Anything else closes the connection without a `hello`. Only the user can read the state file, so only they can connect.
- **Ownership.** A session belongs to the window that spawned or last claimed it. Output goes only to the owner. When the owner disconnects, the session is detached: the daemon goes on reading the PTY and feeds the output into its own libghostty-vt engine (the same WASM module, run with wasmi on a thread of its own), so the screen stays current. `claim` from another window moves the session; the previous owner gets `detached`, and its tab says the terminal moved.
- **Checkpoints.** The owner sends `checkpoint` about a second after output settles, and at least every 30 s while it does not. The stream position is the count of output bytes its engine consumed since it got the session. The daemon keeps the snapshot and the output after that position (up to 32 MiB; past that it gives up on an exact restore). On detach, its engine restores the snapshot and replays the rest, so `claimed` returns an exact snapshot. Without a checkpoint, `claimed` carries the recent raw output instead (`exact: false`).
- **Lifetime.** Sessions stay until their process exits and the exit is collected by a claim, or until `kill`. A detached session whose process exits keeps its exit status for the next claim. The daemon exits once no client has been connected and no session has been running for 60 s.
