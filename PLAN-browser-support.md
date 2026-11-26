# gty in a web browser: Plan (on hold)

Nov 26, 2026. Status: **on hold**, because of the browser-reserved keys (§5.1). Nothing in this plan has been built.

This plan adds a second way for the native app, `gty`, to show its terminal: in a web browser the user already has (Chrome, Chromium, Edge, Brave or Firefox), not in the system web view. It changes nothing in the VS Code and VSCodium extension, and the app's default stays the system web view (WebKitGTK on Linux, WebView2 on Windows). The browser is used only when the configuration asks for it or, optionally, when WebKitGTK is not installed. See [app/README.md](app/README.md) for the app as it is.

## 1. Why

On Linux, `gty` needs WebKitGTK 4.1 and GTK 3. Desktop distributions have them, but minimal installs, servers reached over X forwarding or VNC, some containers and locked-down machines may not, and the user may not be able to install packages. Most of these machines do have a browser. The launcher already detects the missing libraries and prints how to install them (`app/gty.sh`). This plan lets it offer a working terminal instead.

**Goals**

- An opt-in browser viewer for the native app, chosen by configuration, a command-line flag or an environment variable.
- Optionally, a fallback to it when WebKitGTK is missing (decision D1).
- The same terminal: the same page, session code, settings, daemon and shared sessions as the web-view app and the VS Code extension.

**Non-goals**

- Any change to the VS Code or VSCodium extension.
- A hosted or remote web terminal. The server listens on 127.0.0.1 only, for the user on that machine. code-server already covers remote use.
- Replacing the system web view as the default.

## 2. Facts this plan rests on

Each one is a constraint on the design.

1. **The page is already a plain web page.** `webview/main.ts` plus `native/` runs in the system web view, and the page's tests already run in Chromium, Firefox and WebKit (`test-webview` in the Dockerfile). The page needs no new rendering code: it uses only the 2D canvas.
2. **The app already talks to the page over a WebSocket on 127.0.0.1**, with a random token in the URL and checks on where requests come from (`app/src/bridge.rs`). Only the window's IPC channel (`window.ipc`: title, clipboard, links, notifications, close) and the injected start-up script (`window.__GTY_BOOT__`) are specific to the web view.
3. **The `gty` binary cannot start without WebKitGTK.** It links `libwebkit2gtk-4.1.so.0` and GTK at load time (wry and tao), so the fallback cannot live in it: the dynamic loader fails before `main`. Loading WebKitGTK only when needed (dlopen) is not practical with wry.
4. **The sidecar is a static binary with no dependencies.** `gty-sidecar` is built static against musl for linux-x64 and linux-arm64 (`sidecar-build` in the Dockerfile). It is the same code as `gty --server`, the session daemon. It can serve HTTP and WebSockets without new system libraries.
5. **Chromium-based browsers have an app mode.** `--app=URL` opens a window with no tabs, address bar or menus, close to the native window. `--user-data-dir=DIR` uses a separate profile, so the user's extensions, cookies and history are not involved.
6. **Firefox has no app mode.** Its site-specific browser feature was removed in 2021. `--new-window URL` opens an ordinary window with tabs and an address bar. `--kiosk` is full screen only. `-profile DIR -no-remote` gives a separate profile.
7. **Browsers keep some keys for themselves.** Pages cannot intercept Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Shift+N, Ctrl+Tab or Ctrl+Q, even in Chrome's app mode; Firefox reserves more. In a terminal, Ctrl+W is "delete the previous word" in bash, zsh and readline. The Keyboard Lock API (`navigator.keyboard.lock()`) gives a page these keys, but only in full screen and only in Chromium-based browsers.
8. **Web clipboard access is restricted.** Writing needs focus (Chrome) or a click or key press just before it (Firefox), so OSC 52 from a program running in the terminal would often fail. Reading prompts the user. The native process can use the system clipboard directly instead.
9. **A page cannot show its own confirmation on close.** `beforeunload` shows only the browser's generic "Leave page?" dialog.

## 3. Design

### 3.1 Pieces

```
gty (launcher script, app/gty.sh)
  ├─ WebKitGTK present, viewer not "browser"  ──>  gty-<platform> app (unchanged)
  └─ otherwise, viewer "browser" or "auto" fallback
        └─ gty-sidecar --browser   (static, embedded in the launcher too)
             ├─ HTTP on 127.0.0.1:<random port>: the page (extension/media + app/assets)
             ├─ WebSocket: bridge to the daemon (as bridge.rs), plus the IPC messages
             ├─ the daemon itself (as gty --server), shared with VS Code and the app
             ├─ clipboard (arboard), notifications (notify-send), links (xdg-open)
             └─ starts the browser:  chromium --app=http://127.0.0.1:<port>/#<token>
                                     --user-data-dir=<private profile>
```

### 3.2 Server (new mode in the sidecar)

- **`gty-sidecar --browser [--browser-path PATH]`.** A new mode in `sidecar/src/lib.rs::run_cli`, next to `--server` and `--selftest`. It reuses the bridge code, moved from `app/src/bridge.rs` into the sidecar crate so that the app and the browser mode share it.
- **HTTP.** It serves the embedded assets (the same set as `app/src/assets.rs`) on 127.0.0.1 on a random port, with `tungstenite` for the WebSocket, as in the app. Only GET is served.
- **Access control:**
  - a random 32-byte token in the URL fragment, which browsers do not send to servers, so it does not end up in logs. The page sends it in the WebSocket handshake;
  - origin checks;
  - a `Host` header check against `127.0.0.1:<port>` and `localhost:<port>`, against DNS rebinding;
  - no CORS headers.
- **Start-up configuration.** The boot data that `window.__GTY_BOOT__` now carries (settings, environment, shell, version, paths) comes from `GET /boot.json`, which also requires the token.
- **IPC.** `window.ipc` messages (title, open, clipboardWrite, clipboardRead, notify, log, quit) travel as WebSocket messages alongside the daemon frames.
- **Clipboard.** It is handled in this process with `arboard` (X11, or Wayland data-control), because GTK is what is missing. `arboard` is already used for Windows and macOS; its Linux backends would be compiled into the sidecar only.
- **Lifetime.** The server exits a short grace period (5 s) after the last page disconnects, so a page reload does not end it. Sessions live on in the daemon, as with persistent sessions in VS Code.

### 3.3 Page

- `native/boot.ts`: if `__GTY_BOOT__` is missing, fetch `/boot.json` with the token from the fragment.
- `native/ipc.ts`: send over the WebSocket when `window.ipc` is missing.
- `native/platform.ts`: the window title is `document.title`; links open through the server (`xdg-open`), not `window.open`, so they leave the app window.
- Closing: the page cannot confirm (§2.9). The session stays in the daemon, and the next start of `gty` reattaches to it. That needs the session list from the app's "Not yet" list, or a reattach-on-start rule.
- Keys: in browser mode, offer full screen with Keyboard Lock on Chromium (§5.1).

### 3.4 Choosing the browser

The order is: `--browser-path` or `gty.browser` if set; otherwise the first of these found on `PATH`:

1. `chromium`, `chromium-browser`, `google-chrome`, `google-chrome-stable`, `microsoft-edge`, `brave-browser`;
2. `firefox`.

Flatpak and Snap browsers have their own command names (`flatpak run org.chromium.Chromium`, `/snap/bin/chromium`). Detect the common ones, and document `gty.browser` for the rest.

The profile goes in `~/.cache/gty/browser-profile` (Chromium) or `~/.cache/gty/firefox-profile`, private to the user (0700). Chromium also gets `--no-first-run --no-default-browser-check --disable-features=Translate`; Firefox gets a `user.js` that turns off the first-run pages.

### 3.5 Configuration

| Where | Key / form | Values |
|---|---|---|
| `settings.json` | `gty.viewer` | `"webview"` (the default), `"browser"`, `"auto"` (the web view if WebKitGTK is present, else a browser; see D1) |
| `settings.json` | `gty.browser` | the browser's path or command, e.g. `"/usr/bin/chromium"` |
| command line | `gty --browser[=PATH]`, `gty --webview` | override the settings |
| environment | `GTY_VIEWER=browser\|webview\|auto`, `GTY_BROWSER=PATH` | for the launcher, which cannot easily read JSON |

The launcher decides before any binary starts, so it reads the flag and the environment. It reads `settings.json` with the Python it already uses for memfd when Python is present, or with a small `sed` match on the two keys otherwise.

### 3.6 Launcher and packaging

- Each Linux file (`gty-linux-*`, `gty-alpine-*`) embeds a second payload: the static `gty-sidecar` for that architecture, gzipped, a few MB.
  - linux-armhf has no static sidecar yet; one would be added to `sidecar-build` (armv7 musl).
  - The Alpine files can use the same static binary.
- `app/gty.sh` flow:
  1. When a flag, the environment or the settings say `browser`, run the sidecar payload (from memory or the cache, as now) with `--browser`.
  2. When the library check finds WebKitGTK missing:
     - `auto`: run the browser mode, saying so on stderr.
     - `webview` (the default): today's message plus one line: "or run `gty --browser` to use a web browser".
  3. If no browser is found either, show today's message and say that a browser was looked for.
- `app/pack.sh` takes the second binary; the payload offsets go in the header, as `GTY_LINE` does now.
- Windows: WebView2 is part of Windows 10 and 11, so the fallback matters little there. `--browser` could still use Edge's app mode (`msedge --app=`). macOS: WKWebView is always present; same.

## 4. Testing

- **Unit (page):** boot from `/boot.json`, and IPC over the WebSocket, with a fake server.
- **Sidecar:**
  - the HTTP server refuses a missing or wrong token, a foreign `Origin` or `Host`, and non-GET requests;
  - it serves only the embedded assets;
  - it exits after the grace period.
- **End to end, in Docker:**
  - headless Chromium (`--app`) and Firefox from the Playwright image already used for `test-webview`, against `gty-sidecar --browser`;
  - the tests: start, PTY size, typing, OSC 52, paste, close, and a reattach after a reload.
- **Launcher:**
  - in an image without WebKitGTK but with Chromium: `auto` falls back, `webview` prints the message with the hint, and `--browser` works;
  - with no browser: the message;
  - Debian and Alpine.
- **Keys:** a test that records which Ctrl combinations reach the PTY in each browser, so the documented limits stay true.

## 5. Risks and open questions

### 5.1 Browser-reserved keys (why this is on hold)

Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Tab and Ctrl+Q never reach the page (§2.7). Ctrl+W is used constantly in shells and editors. In a browser it would close the terminal window: the session survives in the daemon, but the user loses the window. Options:

1. **Full screen with Keyboard Lock (Chromium only).** `navigator.keyboard.lock()` delivers these keys while the page is full screen. The terminal is then full screen, and there is no Firefox equivalent.
2. **Remap in the page.** Offer Ctrl+Shift+W, or a configurable prefix, as a way to send Ctrl+W. It works everywhere, but differs from every other terminal.
3. **Accept and document it.** The browser viewer is an emergency fallback, and the install message stays the recommended fix.

A combination is likely: option 1 when Chromium is used and the user opts into full screen, option 2 as a setting, and option 3 for Firefox. Decide this before building.

### 5.2 Other risks

- **Clipboard:** handled by the server (`arboard`), so OSC 52 works. Under Wayland without data-control and without XWayland, the clipboard is unavailable, as it was for the app before it moved to GTK's clipboard.
- **Browser updates:** command-line flags and app-mode behaviour change over time. Keep the flag set small, and test with current Chromium and Firefox in CI.
- **Snap and Flatpak browsers:** sandboxing may block 127.0.0.1 or the profile path. Snap Chromium allows loopback. Profile directories under `~/.cache` may need `~/snap/chromium/...` instead. Test both.
- **Security:** the server is reachable by every process of the same user, as the daemon's socket already is. The token stops other users and web pages. The private profile keeps browser extensions out. Never listen on anything but 127.0.0.1.
- **Two lifetimes:** the browser can outlive the server or the reverse. The page shows "disconnected" with a retry. The server exits when no page has been connected for the grace period.

## 6. Decisions to make before starting

- **D1:** whether `auto` (fall back when WebKitGTK is missing) is the default, or stays opt-in with the default only printing a hint.
- **D2:** full Firefox support, or best effort with the key limits documented.
- **D3:** the key strategy from §5.1.
- **D4:** whether a few MB more per Linux file, for the embedded static sidecar, is acceptable, or whether browser mode ships as a separate file (`gty-browser-<platform>`).

## 7. Work, in order

1. Move the bridge into the sidecar crate; the app uses it from there (no change in behaviour; the existing app tests pass).
2. `gty-sidecar --browser`: the HTTP server, `/boot.json`, IPC over the WebSocket, `arboard`, `notify-send`, `xdg-open`, lifetime handling; and the sidecar tests.
3. Page changes in `native/` (boot, IPC, links, the disconnected state), with unit tests.
4. Starting the browser: detection, the profile, the flags; end-to-end tests with Chromium and Firefox.
5. The key strategy (D3), with its test.
6. Launcher and packaging: the second payload, the selection logic, the messages; launcher tests on Debian and Alpine; a static armhf sidecar.
7. Docs: `app/README.md` (the viewer options and their limits), the root README.
