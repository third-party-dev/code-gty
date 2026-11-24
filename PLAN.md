# Ghostty Terminal for VS Code: Implementation Plan

Nov 24, 2026 · @Vinnie

## Goals, non-goals and constraints

The plan is a VS Code extension that shows a Ghostty-emulated terminal in an ordinary editor tab, imitates the built-in terminal as far as the public API allows, and is built, tested and packaged only inside Docker. Nothing here is built yet.

**Goals**

- A terminal that opens as an editor tab, can be dragged, split, docked and popped into its own window like any editor.
- Ghostty's terminal emulation, via ghostty-web (Ghostty's parser compiled to WebAssembly, with an xterm.js-compatible API).
- Parity workarounds for what a real `vscode.Terminal` gets for free: environment variables, settings, theme, clipboard, link opening, keybinding handling, shell integration, title and cwd, workspace trust.
- Works on desktop VS Code, Remote SSH, WSL, Dev Containers, and server-hosted editors (code-server, Coder).
- Every build, test and packaging step runs in a container, so a clean checkout plus Docker is the only requirement.

**Non-goals**

- Being a real `vscode.Terminal` object. No public API lets an extension swap the renderer, so items like `window.terminals`, the Tasks system and other extensions' terminal link providers cannot see this terminal (see Known gaps).
- Forking VS Code.
- Running a shell where no extension host process can be spawned, such as a purely browser-hosted VS Code with no server.

**Decisions already taken**

- Emulation runs in the webview through ghostty-web, not in native code. The sidecar is only a PTY broker.
- The sidecar is Rust with `portable-pty` (Unix and Windows ConPTY), so no `node-pty` native module.
- The extension is TypeScript, because extension hosts run JavaScript. It spawns the sidecar and relays messages.

**Hard constraints**

- Docker-only builds, reproducible from pinned toolchains and lockfiles.
- The extension must run where the files and shell live, so it is declared a workspace extension.
- Webview content security policy must allow WebAssembly execution, which ghostty-web needs.

## Architecture

Three parts, each with one job: a webview draws the terminal, a TypeScript extension host adds VS Code behaviour, and a Rust sidecar owns the shell.

&#91;embedded content: architecture · 3 components, 1 shell\]

Keystrokes flow right through the host to the sidecar, and shell output flows back left, with the webview acknowledging what it has drawn.

**Protocol between the extension host and the sidecar**

- Transport is the sidecar's stdin and stdout with length-prefixed binary frames. No sockets means nothing to firewall or port-forward; stderr carries logs.
- Frames: `hello` (protocol version, build id), `spawn` (command, args, env, cwd, size), `input`, `resize`, `output`, `ack`, `kill`, `exit`, `attach` (ask for replay).
- Flow control is credit-based. The sidecar stops reading the PTY once unacknowledged output passes a window, and the webview acks as it draws. A 256 KB starting window is a guess to tune in the spike; without any window, `cat` on a large file floods the message channel and freezes the tab.
- Small PTY reads are coalesced for a few milliseconds into one frame, which cuts `postMessage` overhead.
- One sidecar process serves a whole VS Code window and multiplexes sessions by id. If it dies, every session shows an exit message instead of hanging.

**Sidecar (Rust)**

- `portable-pty` spawns the shell, resizes it, and gives blocking reader and writer handles. Each session gets a reader thread feeding a bounded channel.
- On exit it reaps the child, and on kill it signals the whole process group, so shell children do not linger.
- Each session keeps a bounded replay buffer of raw output so a recreated webview can catch up. The size is configurable; a few megabytes is the starting guess.

**Webview**

- ghostty-web with the WASM loaded through `webview.asWebviewUri`. The page's content security policy must include `'wasm-unsafe-eval'` for scripts, or the module will not instantiate.
- A fit step turns pane size into columns and rows and sends `resize`.

**Extension host (TypeScript)**

- Spawns the sidecar with `child_process`, owns the session list, and holds all VS Code API calls. The webview never touches VS Code APIs directly; it posts messages.

## Platforms and remote setups

The extension runs wherever the workspace lives, so one set of per-OS packages covers desktop, remote and server-hosted editors; only a browser-only VS Code with no server behind it is out of reach.

| Environment | Extension host and sidecar run on | Webview runs on | Sidecar build needed | Notes |
| --- | --- | --- | --- | --- |
| Desktop VS Code | Local machine | Local machine | win32, darwin, linux (x64 and arm64) | Baseline case |
| Remote SSH | Remote host | Local UI | Remote host's OS and CPU | Must be a workspace extension, installed on the remote |
| WSL | Inside WSL (Linux) | Windows UI | linux x64 or arm64 | Shell is the WSL shell |
| Dev Containers and Codespaces | Inside the container | Local UI or browser | linux, plus alpine for musl images | Static musl binary avoids glibc mismatches |
| code-server and Coder | The server, container or VM | The user's browser | linux, plus alpine | Install from Open VSX, which code-server uses by default (confirm for your deployment) |
| VS Code tunnels and Remote Server | The tunnel host | Local UI or vscode.dev | Host's OS and CPU | Same as Remote SSH |
| vscode.dev and github.dev with no remote | No process can be spawned | Browser | None | Unsupported: ship no `browser` entry point, so the extension simply does not load |

**Packaging**

- Build one VSIX per target platform with `vsce package --target`: `win32-x64`, `win32-arm64`, `darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64`, `alpine-x64`, `alpine-arm64`. Each contains only its own sidecar binary.
- A static musl build of the sidecar should run on both glibc and Alpine Linux, so one Linux binary per CPU can ship in the linux and alpine packages. This is an assumption to confirm in the build spike.
- Publish to the VS Code Marketplace and to Open VSX. Open VSX also reaches VSCodium and other forks, and code-server by default.
- Zip packaging can drop the executable bit. On activation the extension checks the binary and calls `chmod` if needed, then verifies a checksum recorded at build time before spawning it.

**Manifest settings that matter**

- `extensionKind: ["workspace"]` so it runs on the remote side.
- `capabilities.untrustedWorkspaces.supported: false` (a shell is code execution) and `virtualWorkspaces: false`.
- Activation on its commands and its webview serializer, not on startup.

**Browser-hosted editors (code-server, Coder)**

- `navigator.clipboard` needs a secure context. Over plain HTTP it fails, so paste must also work from the browser's `paste` event, with copy and OSC 52 routed through the extension host.
- Webview assets load through `asWebviewUri`, which works behind the server's proxy; verify the WASM file's MIME type and caching headers in the integration test.

## Docking and window behavior

Each terminal is a webview panel, which VS Code treats as an editor tab, so dragging, splitting, docking and floating windows come from the workbench with no window code of our own.

- **Panel creation.** `createWebviewPanel` with `enableScripts`, `localResourceRoots` limited to the extension's `media` folder, and a tab icon. The title follows the shell's title sequences (OSC 0 and 2), falling back to "Ghostty 1", "Ghostty 2".
- **Hidden tabs.** `retainContextWhenHidden: true` keeps the terminal's screen and scrollback alive while its tab is in the background, at the cost of memory per terminal. Treat it as an optimisation only: VS Code can still discard a webview, and a window reload always does, so correctness rests on the sidecar's replay buffer.
- **Focus.** When a panel becomes active (`onDidChangeViewState`), the host tells the webview to focus the terminal, so typing works immediately after a click on the tab.
- **Reload and restart.** Register a `WebviewPanelSerializer` and keep the session id in webview state, so tabs reappear after a reload. In version one the sidecar lives and dies with the extension host, so a reload restores each tab with a fresh shell in the same cwd and prints a divider saying the session restarted.
- **Sessions that survive reload (later phase).** Run the sidecar as a detached per-user process reached over a unix socket or named pipe with owner-only permissions and a token. This is what makes tmux-like persistence possible, and it brings real work: lifecycle, upgrade handling, and a security review of the socket.
- **Moving to another window.** The webview may be recreated when a tab is moved to a floating or new window. The replay buffer should cover this, but the behaviour differs across VS Code versions, so it gets an explicit test.
- **Closing a tab.** Kill the session, and mimic `terminal.integrated.confirmOnKill` by asking first when a foreground process is still running.
- **Commands.** New terminal, new terminal to the side, kill, clear, focus, and a `sendText` command that other extensions can call through the extension's exported API.
- **Optional panel-area view.** The same webview code can also be registered as a `WebviewView` in the bottom panel for users who want it docked there. A view is one container, so multiple terminals become tabs inside it. Keep this after the editor-tab version works.

## Parity workarounds

Because this terminal is a webview and not a `vscode.Terminal`, each behaviour below is rebuilt by hand; four early spikes (A to D, in the roadmap) decide how far each one can go.

| Area | How the plan matches the built-in terminal | Residual gap |
| --- | --- | --- |
| Environment variables | Start from the extension host's own environment, then set `TERM_PROGRAM=vscode`, `TERM_PROGRAM_VERSION`, `COLORTERM=truecolor`, `TERM=xterm-256color` (switch to `xterm-ghostty` only if its terminfo is shipped) and a locale. Apply `terminal.integrated.env.<os>` and `inheritEnv`, resolving `${workspaceFolder}`, `${env:X}` and `${userHome}`. Spike A diffs a built-in terminal's `env` against ours to find what is missing. | Other extensions' `environmentVariableCollection` changes cannot be read through the public API, so they will not reach this terminal. Offer an own setting and an exported API for extensions to contribute variables. |
| `code` command | Rely on the CLI IPC hook variable and PATH entry the extension host should already carry, so `code file.txt` opens in the current window (to confirm in Spike A). | If the host lacks them, `code` cannot reach the current window. |
| Shell and profile | Honour `terminal.integrated.defaultProfile.<os>` and `profiles.<os>` (path, args, env); fall back to the user's login shell. Match the built-in's macOS login-shell behaviour (verify in Spike A). | Fewer auto-detected Windows profiles at first; read configured ones, rebuild detection later. |
| Settings | Read `terminal.integrated.*` with `getConfiguration` and react to `onDidChangeConfiguration`: font family (falling back to `editor.fontFamily`), size, weight, line height, cursor style and blink, scrollback, `copyOnSelection`, `rightClickBehavior`, `macOptionIsMeta`, `wordSeparators`, `cwd`, `shellArgs`, `confirmOnKill`, `enableBell`. A `ghosttyTerminal.*` namespace holds extras and overrides. | Options ghostty-web cannot honour are listed in the README, not silently ignored. |
| Theme | Map the `terminal.*` colour tokens (background, foreground, the sixteen ANSI colours, selection, cursor) from the webview's `--vscode-*` CSS variables into the ghostty-web theme, and re-apply when the theme changes. | Minimum-contrast adjustment depends on ghostty-web. |
| Clipboard | Copy: the webview sends the selection to the host, which writes `vscode.env.clipboard`, so it works remotely and in browsers. Paste: take the browser `paste` event (no permission prompt) or ask the host for `readText`; use bracketed paste, strip embedded end markers, honour the multiline-paste warning. OSC 52 write is allowed, read is off by default. | Middle-click and the Linux primary selection come later. |
| Links | Detect URLs, `file://`, `path:line:col` and OSC 8 links in the webview. Resolve files in the host against the session cwd with `workspace.fs.stat` (remote-safe) and open with `showTextDocument` at the position. Open web URLs through `env.asExternalUri` and then `env.openExternal`, so localhost links are port-forwarded in remote and Coder setups. Activate with the same modifier key the built-in uses. | Needs link hooks in ghostty-web (Spike B); otherwise scan the visible rows. |
| Keybindings | The webview sends most keys to the shell and lets a pass-through list reach the workbench (Quick Open, Command Palette, panel toggles, tab switching), seeded from VS Code defaults. Honour `sendKeybindingsToShell` and `allowChords`, and add an editable `ghosttyTerminal.passThroughKeys`. | VS Code has no API to read a user's keybindings, so custom ones need the list. In browsers, keys the browser reserves (such as Ctrl+W) cannot be captured. Spike C measures all of this. |
| Shell integration | Ship scripts for bash, zsh, fish and PowerShell that emit OSC 133 (prompt and command boundaries, exit status) and OSC 7 (cwd), loaded through the usual startup hooks and gated by `terminal.integrated.shellIntegration.enabled`. Use them for cwd tracking, prompt-to-prompt navigation and exit-status marks. | VS Code's own shell integration API serves only real terminals, so these features are rebuilt. Needs OSC hooks in ghostty-web (Spike B). |
| Title, cwd, process | OSC 0 and 2 for titles, OSC 7 for cwd, and the sidecar reports the foreground process so tab names and the close confirmation are accurate. |  |
| Bell and zoom | `enableBell` maps to an audible or visual bell. Window zoom already scales the webview. |  |
| Trust and safety | Require workspace trust. Spawn with an argv list, never a built shell string. Validate every webview message against a schema. Use a strict CSP with a nonce, allow-list link schemes, and gate OSC 52 reads. |  |
| Find in terminal | A find widget in the webview that searches scrollback text. | Needs buffer access in ghostty-web (Spike B). |
| Accessibility | A visually hidden text mirror of the visible screen, plus a command that lists recent output. | Likely short of the built-in terminal's screen-reader support. Tracked as a known gap. |

## Docker build, test and release

One multi-stage Dockerfile builds, tests and packages everything, so a clean checkout and Docker with BuildKit are the only requirements; a limit is that Docker cannot run Windows or macOS, so runtime checks on those need real machines.

| Stage | Base | Produces | Checks |
| --- | --- | --- | --- |
| `webview` | Node LTS image pinned by digest | Bundled extension host and webview JS, plus the ghostty-web WASM and glue copied into `media/` | `npm ci` from the lockfile, WASM checksum, bundle size budget, type check, lint |
| `sidecar-*` | Rust image pinned by digest, with Zig and `cargo-zigbuild` | One stripped binary per target, with checksums | `cargo build --locked --release`, `cargo test`, `cargo clippy`, `cargo deny` or `cargo audit` |
| `package` | Node image with `@vscode/vsce` | One VSIX per target platform, plus `SHA256SUMS` | VSIX contents listing, each VSIX holds only its own binary |
| `test-*` | Node plus Chromium and `xvfb`; separate compose services | Test reports | Unit, protocol conformance, webview, desktop integration, code-server end to end (below) |
| `dist` | `scratch` | Only the VSIXes and checksums | Exported with `docker build --target dist --output type=local,dest=dist .` |

**Cross-compiling the sidecar**

- Linux targets are static musl builds for x86\_64 and aarch64.
- macOS and Windows binaries are cross-built from the Linux container with Zig as the linker through `cargo-zigbuild`. This should work for code that only needs libc, which `portable-pty` does on Unix, but it is unproven here. Spike D tests it.
- Windows has two routes: the GNU target (no Microsoft SDK, but ConPTY support must be checked) or the MSVC target through `cargo-xwin`, which downloads the Windows SDK under Microsoft's licence terms. Spike D picks one.
- If macOS ever needs Apple frameworks, the Apple SDK licence ties building to Apple hardware, which conflicts with a Docker-only Linux pipeline. That is the main risk to the Docker-only rule.

**Tests that run in containers**

- **Sidecar conformance.** A Node harness spawns the sidecar against a scripted fake shell and checks every frame type, flow-control windows, resize, kill and exit codes.
- **Binary portability.** Run the Linux binary in Debian and Alpine containers and assert it starts and spawns a shell.
- **Webview.** Playwright in headless Chromium loads the webview against a mock host: rendering, input, theme changes, paste, link detection.
- **Desktop integration.** `@vscode/test-electron` under `xvfb` in the container, with a pinned VS Code version.
- **code-server end to end.** A compose file runs a pinned code-server image with the Linux VSIX installed, and Playwright drives it in a browser: open a terminal tab, type commands, copy and paste, click a link, reload and restore, drag the tab into a split.
- **Remote SSH, WSL, Windows and macOS desktop.** Not runnable in Docker. A written release checklist covers them, run on real machines, until CI runners are an option.

**Reproducibility and security**

- Base images pinned by digest, lockfiles committed, `--locked` and `npm ci` everywhere, `SOURCE_DATE_EPOCH` set. CI builds twice and compares hashes.
- The extension verifies the sidecar's recorded checksum before each spawn.
- Marketplace and Open VSX tokens are passed as BuildKit secrets to a separate release target, never baked into a layer or available to test stages.

**Developer loop**

- A `devcontainer.json` uses the same builder image. A compose service runs code-server with the built VSIX mounted, for quick iteration in a browser. Desktop debugging uses the extension development host from inside the dev container.

## Roadmap

Four short spikes come first and end in a go or no-go decision; the build then runs in five phases. Durations are my rough estimates for one experienced developer, not measurements.

| Phase | Scope | Rough time | Done when |
| --- | --- | --- | --- |
| 0. Spikes | **A:** diff a built-in terminal's environment against the extension host's, and test the `code` command and login-shell behaviour. **B:** probe ghostty-web for link hooks, OSC handlers, scrollback access, selection, search, paste, IME, large-output speed, WASM loading under CSP, licence and maintenance status. **C:** keyboard forwarding in webviews on desktop and code-server. **D:** the Docker cross-compile matrix, including macOS and Windows from Linux and the musl binary on Debian and Alpine. | 3 to 5 days | A written finding per spike, and a go or no-go on ghostty-web (see gate below) |
| 1. Walking skeleton | Repo scaffold, Dockerfile for linux-x64 only, sidecar with spawn, input, output, resize and exit, webview panel, ghostty-web wired in, basic font and theme, copy and paste | 1 to 2 weeks | A usable shell in an editor tab; `vim`, `less` and `htop` render correctly; the tab drags into a split and a new window; `cat` of a 50 MB file does not freeze the tab |
| 2. Parity core | Environment, profiles, settings, theme sync, all clipboard paths, links, key pass-through, title and cwd, close confirmation, workspace trust | 2 to 3 weeks | The parity table is implemented, and a scripted scenario list runs the same in the built-in terminal and ours; `code file.txt` opens in the current window |
| 3. Shell integration and restore | OSC 133 and 7 scripts for four shells, prompt navigation, serializer restore, replay buffer, new tab in the same cwd | 1 to 2 weeks | Reloading the window restores tabs with a fresh shell in the right cwd; moving a tab to another window keeps its content |
| 4. All platforms and release | Every target built and packaged, publish to Marketplace and Open VSX, code-server end-to-end tests in CI, manual checklist for Remote SSH, WSL, Windows and macOS | 1 to 2 weeks | The test matrix is green, two builds produce identical hashes, and the checklist passes on real machines |
| 5. Hardening and extras | Accessibility mirror, find widget, optional panel-area view, detached sidecar for sessions that survive reload, exported API for other extensions, performance tuning | Ongoing | Prioritised from user feedback |

**Gate after the spikes.** If ghostty-web lacks hooks the parity work needs (links, OSC, selection, scrollback) and they cannot be worked around, choose one of: patch or fork ghostty-web, build on libghostty-vt with our own renderer, or narrow the scope. Decide before Phase 1 so the skeleton is not built on the wrong layer.

## Known gaps, risks and open questions

The gaps that matter most come from not being a real `vscode.Terminal`: other extensions and built-in features that look for one will not find this terminal.

**Gaps the public API cannot close**

- The terminal does not appear in `window.terminals`, so extensions that call `sendText` or read the active terminal will not see it.
- The Tasks system runs in real terminals and cannot target this one.
- Other extensions' terminal link providers, quick fixes and environment contributions do not apply.
- Built-in commands such as running selected text in the active terminal act on the built-in terminal. Mitigation: our own equivalent commands, and an exported API other extensions can call.
- In browser-hosted editors, keys the browser reserves cannot be captured by any page.
- A browser-only VS Code with no server cannot run a shell at all.
- Screen-reader support will likely trail the built-in terminal.

**Risks**

- **ghostty-web maturity.** It is a young project and its fit with our needs (hooks, performance, licence, maintenance) is unverified until Spike B. Fallbacks are in the roadmap gate.
- **Webview performance.** Large output and canvas drawing in remote browsers may lag even with flow control. Measure in Spike B and Phase 1.
- **Webview lifecycle differences.** Hidden tabs, window moves and reloads behave differently across VS Code versions, so these need explicit tests per supported version.
- **Inexact replay.** Replaying a truncated raw buffer can leave a fresh terminal in the wrong mode (for example alternate screen or mouse reporting). A later fix is to run libghostty-vt inside the sidecar and replay a state snapshot instead of raw bytes.
- **Undocumented environment.** Passing the `code` CLI through relies on variables the extension host happens to carry. Spike A confirms this, and it could change between VS Code releases.
- **Cross-compiling in Docker.** macOS and Windows builds from Linux are unproven (Spike D), and Apple's SDK licence is the main threat to a Docker-only pipeline.
- **Security surface.** An extension that spawns shells, handles OSC 52 and opens links needs a deliberate review before release.

**Open questions for you**

1. Is Windows required in the first release, or can it follow once Linux and macOS work?
2. Must sessions survive a window reload in version one, which means the detached-sidecar design?
3. What is the oldest VS Code version to support? It affects floating-window and webview behaviour.
4. Is a manual release checklist acceptable for Windows, macOS, Remote SSH and WSL, given Docker cannot run them?
5. What name, publisher and licence will the extension use, and is ghostty-web's licence compatible with that choice?
6. Should the extension collect no telemetry at all? That is the default assumed here.
