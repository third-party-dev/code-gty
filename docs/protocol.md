# Sidecar protocol (version 1)

The extension host starts `gty-sidecar` with no arguments and talks to it over stdin and stdout. stderr is free-form log text. When stdin closes, the sidecar sends SIGHUP to every session's process group, sends SIGKILL to any group still alive after one second, and exits.

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

`env` is the child's complete environment: the sidecar does not pass on its own.

## Flow control

Each session has a window (`codeGty.flowControlWindow`, default 256 KiB). The reader thread stops reading the PTY while unacknowledged output is at or above the window, so the overshoot is at most one 64 KiB read. Output first goes through the host's libghostty-vt engine, which forwards the same bytes to the webview. The webview acks each chunk once its mirror engine has parsed it, and the host passes the credit on. Parsing, not drawing, is the cost the window has to bound, and drawing pauses in hidden tabs. When no webview can draw (not ready, or hidden without `retainContextWhenHidden`), the host acks on its behalf and the next webview starts from a snapshot of the host engine. Bytes the host injects itself (notices, Clear) carry no credit.

## Coalescing

The single stdout thread merges output that arrives within 4 ms (up to 128 KiB) into one frame per session. Control frames flush pending output first, so frame order always matches event order.

## Replay

Each session keeps the last `replayLimit` bytes (default 2 MiB). `attach` snapshots the buffer under the same lock the reader uses to queue output. Every `output` frame queued before the snapshot is therefore also in the replay, and the host drops `output` frames between sending `attach` and receiving `replay`. `attach` resets the session's credit to the replay size.
