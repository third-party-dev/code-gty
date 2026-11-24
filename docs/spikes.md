# Spike findings

What the build has established so far for each spike in the plan, and what still needs a real machine.

## B: ghostty-web (0.4.0, MIT, by Coder): go

| Question | Finding |
| --- | --- |
| Licence and maintenance | MIT. Published by Coder, the company behind code-server, and used in their own product, Mux. Young: 0.x versions, and a `next` channel with frequent builds. |
| WASM loading under CSP | Works with `script-src 'wasm-unsafe-eval'`. By default the library `fetch`es a base64 data: URL that is inlined in the bundle. We call `Ghostty.load(asWebviewUri(...))` instead and strip the inline copy at bundle time, which cuts the webview bundle from 714 KB to 150 KB. Tested in Chromium (`test/webview`). |
| Link hooks | `registerLinkProvider` is xterm-style and takes a callback, so it can be asynchronous. The built-in URL and OSC 8 providers activate through `window.open`, which the webview overrides to post to the host. The built-in providers always use Ctrl or Cmd; only our file-path provider follows `editor.multiCursorModifier`. |
| OSC handlers | None are exposed; only an internal title parser exists. Workaround: the host scans the byte stream for OSC 0, 2, 7, 52 and 133 (`src/osc.ts`), and the webview splits output at OSC 133 to record prompt lines exactly. |
| Scrollback access | `buffer.active.getLine(y)` covers scrollback plus screen, with `translateToString`, which is enough for find and the accessibility text. Watch out: `scrollToLine(n)` sets "lines scrolled back from the bottom", not an absolute line, and `select(col, row, len)` takes a viewport row. `webview/viewport.ts` hides both quirks. |
| Selection | `getSelection`, `hasSelection`, `select`, `selectAll` and `onSelectionChange` are available. There is no word-separator option. |
| Paste | `paste()` brackets the text when the shell has enabled it, but does not sanitise it. The library's own `paste` DOM handler sends raw text, so we intercept paste events in the capture phase and route them through the host. |
| Runtime option changes | Font family, font size and cursor can change at runtime. Theme and scrollback cannot (the palette lives in the WASM terminal), so the webview rebuilds the terminal and asks for a replay. |
| IME | The library has composition handlers. **Not yet tested with a real IME.** |
| Large output speed | The 50 MB `cat` target from Phase 1 has **not been measured in a real editor yet**. Flow control is proven in the conformance tests (output stops at the window until acked). |
| Unsupported options | `lineHeight`, `letterSpacing`, `fontWeight`, `minimumContrastRatio`, `wordSeparators`. These are listed in the README. |

## code-server (4.105.1) findings from the end-to-end test

- **Webviews need a secure context.** Over plain HTTP from a host other than localhost, code-server logs "'crypto.subtle' is not available so webviews will not work", and no webview renders. The compose e2e service shares code-server's network namespace and browses `http://localhost:8080`. Real deployments need HTTPS, which Coder and most reverse proxies provide.
- **Webview state is saved lazily.** A `cd` 0.5 s before a page reload was lost (the tab came back in the previous directory), while one 5 s before was kept. Possible fix, not yet tried: also persist the cwd from the host keyed by a session id. It is unproven whether code-server saves extension storage any sooner.
- Opening a tab, running commands, `Ctrl+Shift+P` pass-through, moving the tab into a split, restoring after a reload, and serving the WASM as `application/wasm` all pass.

## C: keyboard in webviews: partly tested

VS Code's webview host forwards bubbling `keydown` events from the window to the workbench. The webview calls `stopPropagation()` at the document for keys the shell handles, and lets pass-through keys bubble. The Chromium test checks this behaviour (`Ctrl+R` stays in the terminal; `Ctrl+P` and `F1` reach the window). The code-server end-to-end test checks `Ctrl+Shift+P` in a real workbench. **Still to measure:** Electron desktop behaviour for copy and paste keys, and whether browser-reserved keys behave the same in Firefox and Safari.

## D: Docker cross-compile matrix

- Linux x86_64 and aarch64 build as static musl binaries with `cargo zigbuild`. The x86_64 binary passes `--selftest` (spawning a shell in a PTY) on both `debian:bookworm-slim` and `alpine:3.22`, so one binary serves both the `linux-*` and `alpine-*` packages.
- With `--build-arg SIDECAR_TARGETS=all`, all eight targets cross-compile from the Linux container with Zig 0.13 and cargo-zigbuild 0.24.1: `x86_64-apple-darwin`, `aarch64-apple-darwin`, `x86_64-pc-windows-gnu` and `aarch64-pc-windows-gnullvm` as well as the Linux ones. No Apple or Microsoft SDK was needed, because `portable-pty` uses only libc on Unix and loads ConPTY dynamically on Windows. **None of these binaries has been run on its real OS yet.** ConPTY behaviour of the GNU build is the main thing to check on Windows.

## Reproducibility

Two `--target dist` builds with the build caches disabled (`--no-cache-filter webview,sidecar-build,package`) produced identical `SHA256SUMS`. The packaging stage pins file timestamps to `SOURCE_DATE_EPOCH`, and the sidecar build remaps source paths.

## A: environment parity: needs a real VS Code

The integration test checks `TERM_PROGRAM`, `COLORTERM` and the removal of `ELECTRON_RUN_AS_NODE` in VS Code under Xvfb. **Still to do on desktop, Remote SSH and WSL:** diff `env` from a built-in terminal against one of ours, and check that `code file.txt` opens in the current window (this depends on `VSCODE_IPC_HOOK_CLI` and the remote-cli PATH entry being present in the extension host).
