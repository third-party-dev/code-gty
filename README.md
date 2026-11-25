# code-gty

A VS Code extension that shows a Ghostty-emulated terminal in an editor tab. It implements [PLAN.md](PLAN.md), with the terminal itself rebuilt on libghostty-vt as described in [PLAN-redo.md](PLAN-redo.md). The user-facing description is in [extension/README.md](extension/README.md).

## Layout

| Path | What it is |
| --- | --- |
| `sidecar/` | Rust PTY broker (`gty-sidecar`): spawns shells with `portable-pty`, multiplexes sessions over stdin/stdout frames, handles flow control, coalescing, the replay buffer and process-group kill |
| `extension/vt/` | gty-vt: TypeScript bindings for libghostty-vt (WASM), shared by host and webview. `layout.generated.ts` comes from the module's own type manifest (`scripts/gen-vt-layout.mjs`) |
| `extension/src/engine/` | The authoritative engine per session: every byte from the sidecar goes through it; it owns replies and effects and snapshots for webviews |
| `extension/src/` | Extension host (TypeScript): sessions, settings, environment, profiles, links, clipboard, effects to VS Code APIs, serializer, exported API |
| `extension/src/shared/` | Code used by both the host and the webview: message schema and validation, key pass-through, paste preparation |
| `extension/term/` | gty-term: the browser terminal on a mirror engine: canvas renderer, sprites, keyboard/IME, mouse, selection, find, links, images |
| `extension/webview/` | Webview glue (bundled to `media/webview.js`): messages, settings, pass-through keys, clipboard |
| `vt-wasm/` | `build.sh` builds `extension/media/ghostty-vt.wasm` (libghostty-vt 1.0.2, wasm32-wasi, Zig 0.17) with the patches in `vt-wasm/patches` |
| `extension/shell-integration/` | bash, zsh, fish and PowerShell scripts that emit OSC 133 and OSC 7 |
| `extension/test/` | `unit`, `conformance` (real sidecar), `webview` (Chromium), `integration` (VS Code under Xvfb), `e2e` (code-server) |
| `docs/` | [Protocol](docs/protocol.md), [spike findings](docs/spikes.md) (including the libghostty-vt Phase 0 measurements), [release checklist](docs/release-checklist.md) |

## Building and testing

Docker with BuildKit is the only requirement.

```sh
# VSIXes for linux-x64, linux-arm64, alpine-x64 and alpine-arm64, plus SHA256SUMS, into ./dist
docker build --target dist --output type=local,dest=dist .

# Every platform (adds darwin-x64, darwin-arm64, win32-x64, win32-arm64)
docker build --target dist --build-arg SIDECAR_TARGETS=all --output type=local,dest=dist .

# All container tests: clippy + cargo test, conformance and shell integration,
# Debian/Alpine portability, webview in Chromium, Firefox and WebKit, VS Code
# integration under Xvfb
docker build --target ci .

# Licence and advisory audit of the Rust dependencies
docker build --target sidecar-audit .

# Browser end to end against code-server (needs ./dist from the first command);
# GTY_BROWSER=firefox or webkit for the other engines
docker compose run --rm e2e

# Just the libghostty-vt module, into extension/media
docker build --target vt-wasm-out --output type=local,dest=extension/media .

# Try it in a browser at http://localhost:8080
docker compose up dev
```

Individual test stages can be built on their own, for example `docker build --target test-webview .`. The integration stage tests against VS Code 1.90.0 (the minimum supported version) by default; use `--build-arg VSCODE_TEST_VERSION=stable` for the latest.

### Local development

Open the repo in the dev container (`.devcontainer/`), or with Node 22 and Rust installed:

```sh
cd sidecar && cargo build
# extension/media/ghostty-vt.wasm: docker build --target vt-wasm-out (above),
# or vt-wasm/build.sh extension/media with Zig 0.17 and minisign installed
cd ../extension && npm ci && npm run build
npm run test:unit && npm run test:conformance
```

Then press F5 from the `extension` folder, or start VS Code with `--extensionDevelopmentPath=extension`. Without a packaged `bin/` folder, the extension falls back to `../sidecar/target/{release,debug}/gty-sidecar` and logs that the binary is unverified.

## Release

```sh
docker build --target release \
  --secret id=vsce_pat,env=VSCE_PAT --secret id=ovsx_pat,env=OVSX_PAT \
  --build-arg SIDECAR_TARGETS=all .
```

The tokens are BuildKit secrets, so they never end up in an image layer, and no test stage can read them. Before publishing, run [docs/release-checklist.md](docs/release-checklist.md) on real machines.

## Decisions taken for the plan's open questions

These are defaults to confirm or change:

1. **Windows** is built (GNU target, cross-compiled with Zig) but untested. Treat it as preview until the checklist has been run on Windows.
2. **Sessions survive reloads and closed windows** (`codeGty.persistentSessions`, on by default, following `terminal.integrated.enablePersistentSessions`). A per-user sidecar daemon keeps them, and the next window of the workspace reattaches its tabs with an exact snapshot of the screen. **Ghostty: Manage Sessions…** lists them, opens one in the current window (moving it from another window, like `tmux attach -d`) or kills it. With the setting off, a reload restores the tab with a fresh shell in the same directory.
3. **Oldest VS Code version** is 1.90 (`engines.vscode`). Floating editor windows need 1.85 or later.
4. **Manual checklist** for Windows, macOS, Remote SSH and WSL, in `docs/release-checklist.md`.
5. **Name, publisher and licence** are placeholders: `code-gty`, publisher `code-gty`, MIT. libghostty-vt is MIT, so it is compatible with MIT and most other licences. Change `publisher` and `repository` in `extension/package.json` before publishing.
6. **No telemetry.**

## Decisions taken for PLAN-redo.md

1. **Two engines**: an authoritative libghostty-vt terminal in the extension host and a mirror in the webview, fed the same bytes in order.
2. **Kitty graphics** ship: the module is built from source for wasm32-wasi (the official wasm32-freestanding module disables Kitty graphics). Building it needed two small fixes to upstream, in `vt-wasm/patches`; both are worth sending upstream.
3. **Migration in one release**: ghostty-web and its patches are gone; there is no `codeGty.engine` switch.
4. **`retainContextWhenHidden`** stays on by default. With exact snapshot restore it can be turned off with no loss other than a redraw.
5. **Notifications and progress** are on by default; notifications only when the tab is not focused.
6. **Upstream contributions**: not sent. The two patches and the JavaScript bindings are candidates, if you agree.

