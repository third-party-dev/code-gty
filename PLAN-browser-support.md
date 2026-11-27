# gty in a web browser: Plan

Nov 27, 2026. Status: **built**; §8 lists what is still open (decisions in §6).

This plan adds a second way for the native app, `gty`, to show its terminal: in a web browser the user already has, not in the system web view. It changes nothing in the VS Code and VSCodium extension. On every platform the system web view stays the first choice (WebKitGTK on Linux, WebView2 on Windows, WKWebView on macOS), and the browser is used when that web view is not available, or when the configuration asks for it. See [app/README.md](app/README.md) for the app as it is.

## 1. Why

On Linux, `gty` needs WebKitGTK 4.1 and GTK 3. Desktop distributions have them, but minimal installs, servers reached over X forwarding or VNC, some containers and locked-down machines may not, and the user may not be able to install packages. Windows Server and some Windows LTSC installs lack the WebView2 runtime. Most of these machines do have a browser. Today the Linux launcher detects the missing libraries and prints how to install them (`app/gty.sh`); with this plan it starts a working terminal in a browser instead.

**Goals**

- A browser viewer for the native app on every platform: used automatically when the system web view is missing (D1), and on request by configuration, a command-line flag or an environment variable.
- The same terminal: the same page, session code, settings, daemon and shared sessions as the web-view app and the VS Code extension.
- In a browser, the same keyboard behaviour as code-server (D2, D3): what the browser passes to the page reaches the terminal, and what the browser keeps for itself is lost.

**Non-goals**

- Any change to the VS Code or VSCodium extension.
- A hosted or remote web terminal, or use behind a reverse proxy (D6). The server listens on 127.0.0.1 only, for the user on that machine. code-server already covers remote use.
- Authentication (D5). The server checks where requests come from, but has no login, token or cookie.
- Recovering the keys browsers reserve: no full-screen Keyboard Lock, no remapping, no progressive web app (D3). Users who want them back can use a third-party tool, as with code-server.
- Replacing the system web view where it works.

## 2. Facts this plan rests on

Each one is a constraint on the design.

1. **The page is already a plain web page.** `webview/main.ts` plus `native/` runs in the system web view, and the page's tests already run in Chromium, Firefox and WebKit (`test-webview` in the Dockerfile). The page needs no new rendering code: it uses only the 2D canvas.
2. **The app already talks to the page over a WebSocket on 127.0.0.1** (`app/src/bridge.rs`). Only the window's IPC channel (`window.ipc`: title, clipboard, links, notifications, close) and the injected start-up script (`window.__GTY_BOOT__`) are specific to the web view.
3. **On Linux, the `gty` binary cannot start without WebKitGTK.** It links `libwebkit2gtk-4.1.so.0` and GTK at load time (wry and tao), so the dynamic loader fails before `main`. Loading WebKitGTK only when needed (dlopen) is not practical with wry. So on Linux, browser mode must be a separate binary that links nothing from the system.
4. **On Windows, the exe can detect a missing WebView2 itself.** It loads WebView2's loader at run time (`app/src/webview2_loader.rs`), so asking for the runtime's version (`GetAvailableCoreWebView2BrowserVersionString`) fails cleanly when the runtime is not installed. Browser mode can live in the same exe there. macOS always has WKWebView, so there browser mode is used only on request, and also lives in the app.
5. **The sidecar is a static binary with no dependencies.** `gty-sidecar` is built static against musl for linux-x64 and linux-arm64 (`sidecar-build` in the Dockerfile): 4.2 MB (1.8 MB gzipped) for x64, 3.7 MB (1.7 MB) for arm64. It is the same code as `gty --server`, the session daemon. It can serve HTTP and WebSockets without new system libraries.
6. **Chromium-based browsers have an app mode.** `--app=URL` opens a window with no tabs, address bar or menus, close to the native window. `--user-data-dir=DIR` runs a separate instance with its own profile, so the user's extensions, cookies and history are not involved.
7. **Firefox has no app mode.** Its site-specific browser feature was removed in 2021. `--new-window URL` opens an ordinary window with tabs and an address bar. `-profile DIR -no-remote` runs a separate instance with its own profile. Safari has no command-line options for this at all.
8. **Browsers keep some keys for themselves.** Pages cannot intercept Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Shift+N, Ctrl+Tab or Ctrl+Q, even in Chrome's app mode; Firefox reserves more. In a terminal, Ctrl+W is "delete the previous word" in bash, zsh and readline. code-server has the same limitation, and its FAQ recommends installing it as a progressive web app (Chrome), a third-party add-on (Firefox), or remapping keybindings; this plan takes the same position and leaves those to the user (D3).
9. **Browsers let any web page open a WebSocket to 127.0.0.1.** Without a check, a page on any website the user visits could connect to gty's port and get a shell. The browser sends an `Origin` header with every WebSocket handshake, and checking it (with the `Host` header, against DNS rebinding) keeps other sites out. It does not keep out other users on the same machine, who can reach 127.0.0.1 too.
10. **Web clipboard access is restricted.** Writing needs focus (Chrome) or a click or key press just before it (Firefox), so OSC 52 from a program running in the terminal would often fail. Reading prompts the user. The native process can use the system clipboard directly instead.
11. **A page cannot show its own confirmation on close.** `beforeunload` shows only the browser's generic "Leave page?" dialog.

## 3. Design

### 3.1 Pieces

```
Linux:  gty-<platform> (launcher script, app/gty.sh)
          ├─ WebKitGTK present, viewer not "browser"  ──>  the app (unchanged)
          └─ WebKitGTK missing ("auto"), or viewer "browser"
                └─ the static browser-mode binary (a second payload in the same file)

Windows: gty-win32-<arch>.exe
          ├─ WebView2 present, viewer not "browser"   ──>  the window (unchanged)
          └─ WebView2 missing ("auto"), or viewer "browser"  ──>  browser mode, same exe

macOS:   gty  ──  browser mode only with viewer "browser"  (WKWebView is always there)

browser mode
  ├─ HTTP on 127.0.0.1:<random port>: the page (extension/media + app/assets)
  ├─ WebSocket: bridge to the daemon (as bridge.rs), plus the IPC messages
  ├─ the daemon itself (as gty --server), shared with VS Code and the app
  ├─ clipboard (arboard), notifications, links (as the app: notify-send / osascript, xdg-open / open / rundll32)
  └─ starts the user's default browser: Chromium-family in app mode with a private profile,
     Firefox in a new window with a private profile, others with the URL alone
```

### 3.2 Server

- **Where it lives.** A new mode of the sidecar crate, `--browser [--browser-path PATH]`, next to `--server` and `--selftest`, built into:
  - the static `gty-sidecar` that Linux files carry as a second payload;
  - the app on Windows and macOS (which already links the sidecar crate).
  The bridge code moves from `app/src/bridge.rs` into the sidecar crate, so the app and browser mode share it.
- **HTTP.** It serves the embedded assets (the same set as `app/src/assets.rs`) on 127.0.0.1 on a random port, with `tungstenite` for the WebSocket, as in the app. Only GET is served.
- **Request checks (not authentication, D5):**
  - the `Origin` of every WebSocket handshake and of `/boot.json` must be `http://127.0.0.1:<port>`;
  - the `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`, against DNS rebinding;
  - no CORS headers, so other sites cannot read any response;
  - no token, cookie or login. Any process of any user on the machine can connect; see §5.2.
- **Start-up configuration.** The boot data that `window.__GTY_BOOT__` carries in the app (settings, environment, shell, version, paths) comes from `GET /boot.json`.
- **IPC.** `window.ipc` messages (title, open, clipboardWrite, clipboardRead, notify, log, quit) travel as WebSocket messages alongside the daemon frames.
- **Clipboard.** It is handled in this process with `arboard`. On Linux that is the X11 backend (`x11rb`, which talks to the X server's socket itself) or Wayland data-control, both pure Rust, so the static binary keeps linking nothing (to confirm in step 2 of §7). Windows and macOS already use `arboard`.
- **Lifetime.** The server exits a short grace period (5 s) after the last page disconnects, so a page reload does not end it. Sessions live on in the daemon, as with persistent sessions in VS Code.

### 3.3 Page

- `native/boot.ts`: if `__GTY_BOOT__` is missing, fetch `/boot.json`.
- `native/ipc.ts`: send over the WebSocket when `window.ipc` is missing.
- `native/platform.ts`: the window title is `document.title`; links open through the server, not `window.open`, so they leave the terminal's window.
- Closing: the page cannot confirm (§2.11). The session stays in the daemon, and the next start of `gty` reattaches to it. That needs the session list from the app's "Not yet" list, or a reattach-on-start rule.
- Keys: nothing special (D3). The page receives what the browser passes on, as it does in code-server.

### 3.4 Choosing the browser

`--browser-path`, `gty.browser` or `GTY_BROWSER` if set; otherwise the user's default browser (D4):

| Platform | Default browser | Fallback when there is none |
|---|---|---|
| Linux | `xdg-settings get default-web-browser`, then the `Exec` line of that `.desktop` file (`$XDG_DATA_DIRS`, `~/.local/share/applications`) | the first on `PATH` of `chromium`, `chromium-browser`, `google-chrome`, `google-chrome-stable`, `microsoft-edge`, `brave-browser`, `firefox` |
| Windows | the `https` association (`HKCU\...\Shell\Associations\UrlAssociations\https\UserChoice` ProgId, then its `shell\open\command`) | Edge (`msedge.exe`), part of Windows 10 and 11 |
| macOS | the default handler for `https` (Launch Services) | Safari |

How it is started depends on which browser it is:

- **Chromium-family** (Chromium, Chrome, Edge, Brave, Vivaldi, Opera): `--app=http://127.0.0.1:<port>/ --user-data-dir=<private profile> --no-first-run --no-default-browser-check`. This gives a window of its own, in an instance of its own, with no extensions.
- **Firefox:** `-profile <private profile> -no-remote --new-window <url>`, with a `user.js` that turns off the first-run pages.
- **Anything else** (Safari, or an unknown browser): the URL is opened with the system's handler (`xdg-open`, `open`, `start`), so it becomes a tab of the user's own browser, with their profile and extensions.

Private profiles go in `~/.cache/gty/browser-profiles/<browser>` (`%LOCALAPPDATA%\code-gty\browser-profiles` on Windows, `~/Library/Caches/gty` on macOS), private to the user. Flatpak and Snap browsers have their own command names (`flatpak run org.chromium.Chromium`, `/snap/bin/chromium`), and the `.desktop` file names them, so the default-browser lookup finds them; profile paths may need to be inside their sandbox (§5.2).

### 3.5 Configuration

| Where | Key / form | Values |
|---|---|---|
| `settings.json` | `gty.viewer` | `"auto"` (the default, D1: the system web view, or a browser when it is missing), `"webview"` (never a browser: the install message instead), `"browser"` (always a browser) |
| `settings.json` | `gty.browser` | the browser's path or command, e.g. `"/usr/bin/chromium"` (default: the user's default browser) |
| command line | `gty --browser[=PATH]`, `gty --webview` | override the settings |
| environment | `GTY_VIEWER=auto\|webview\|browser`, `GTY_BROWSER=PATH` | as the settings; the Linux launcher reads these most easily |

On Linux the launcher decides before any binary starts. It reads the flag and the environment, and `settings.json` with the Python it already uses for memfd when Python is present, or with a small `sed` match on the two keys otherwise. On Windows and macOS the app decides itself.

### 3.6 Launcher and packaging

- **Linux.** Each Linux file (`gty-linux-*`, `gty-alpine-*`) embeds a second payload: the static `gty-sidecar` with browser mode and the page, gzipped. That is about 4–6 MB more per file (today about 12 MB): 1.7–1.8 MB for the binary (§2.5) plus the page, which it needs a copy of. The app payload stays as it is.
  - linux-armhf has no static sidecar yet; one is added to `sidecar-build` (armv7 musl).
  - The Alpine files use the same static binary.
  - `app/gty.sh` flow:
    1. viewer `browser` (flag, environment or settings): run the second payload (from memory or the cache, as now) with `--browser`;
    2. viewer `auto` (the default) and the library check finds WebKitGTK missing: the same, saying on stderr that it is using a browser because WebKitGTK is missing, and how to install it;
    3. viewer `webview` and WebKitGTK missing: today's message, plus a line that `gty --browser` would use a web browser;
    4. no browser found either: today's message, saying that a browser was looked for.
  - `app/pack.sh` takes the second binary; the payload offsets go in the header, as `GTY_LINE` does now.
- **Windows.** No new file: `gty-win32-<arch>.exe` checks for WebView2 at start (§2.4) and runs browser mode itself under `auto` when it is missing, or always under `browser`. The default browser is usually Edge, which runs in app mode.
- **macOS.** No new file: browser mode under `browser` only.

## 4. Testing

- **Unit (page):** boot from `/boot.json`, and IPC over the WebSocket, with a fake server.
- **Server:**
  - it refuses a foreign or missing `Origin` (WebSocket and `/boot.json`), a foreign `Host`, and non-GET requests;
  - a page on another origin cannot connect or read `/boot.json` (a test page served from a second port);
  - it serves only the embedded assets;
  - it exits after the grace period.
- **Default-browser lookup:** each platform's lookup against fixtures (a `.desktop` tree, registry values on Windows), and the fallback order.
- **End to end, in Docker:** headless Chromium (`--app`) and Firefox from the Playwright image already used for `test-webview`, against `gty-sidecar --browser`: start, PTY size, typing, OSC 52, paste, close, and a reattach after a reload.
- **Linux launcher:**
  - in an image without WebKitGTK but with a browser: the default (`auto`) uses the browser, `webview` prints the message with the hint, and `--browser` works;
  - with no browser: the message;
  - Debian and Alpine;
  - the second payload links nothing (`ldd` reports a static binary).
- **Windows** (GitHub Actions): browser mode starts with `--browser`; a runner without WebView2 is unlikely, so the `auto` fallback is tested by making the runtime check fail (a test switch).
- **Keys:** a test that records which Ctrl combinations reach the PTY in Chromium (app mode) and Firefox, so the documented limits (§2.8) stay true.

## 5. Risks

### 5.1 Browser-reserved keys

Decided (D3): accepted, as in code-server. Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Tab and Ctrl+Q, and more in Firefox, never reach the terminal in a browser, and Ctrl+W closes the window. The session survives in the daemon, and the next `gty` reattaches to it. The README lists the lost keys per browser (from the keys test), and points to the system web view, the install command for WebKitGTK, and code-server's workarounds (a progressive web app in Chrome, a third-party add-on in Firefox) as the user's options.

### 5.2 Other risks

- **Other users on the same machine (D5):** with request checks but no authentication, another user who can log in to the same machine can connect to the port while browser mode runs, and get the shell of the user who started it. The README must say so: on a machine shared with people you do not trust, use the system web view (install WebKitGTK) and set `gty.viewer` to `webview`. Single-user machines, the usual case, are not affected. A later version could add a check that needs no login (for example, on Linux, comparing the connecting socket's user with `/proc/net/tcp`); that is not in this plan.
- **Clipboard:** handled by the server (`arboard`), so OSC 52 works. Under Wayland without data-control and without XWayland, the clipboard is unavailable on Linux in browser mode (the app itself uses GTK's clipboard).
- **Browser updates:** command-line flags and app-mode behaviour change over time. Keep the flag set small, and test with current Chromium and Firefox in CI.
- **Snap and Flatpak browsers:** sandboxing may block 127.0.0.1 or the profile path. Snap Chromium allows loopback. Profile directories under `~/.cache` may need `~/snap/chromium/...` instead. Test both.
- **A default browser opened without a private profile** (Safari, unknown browsers): the page runs among the user's own extensions, which could read it. The request checks still keep other websites out.
- **Two lifetimes:** the browser can outlive the server or the reverse. The page shows "disconnected" with a retry. The server exits when no page has been connected for the grace period.

## 6. Decisions

Taken Nov 27, 2026.

- **D1: `auto` is the default.** The system web view when it is there; otherwise a browser, without asking. `webview` keeps today's behaviour (the install message).
- **D2: Firefox gets the same support as code-server gets.** What Firefox passes to the page reaches the terminal; what it keeps is lost. Third-party add-ons that change that are the user's choice, not this project's.
- **D3: no work-around for reserved keys.** Not full screen with Keyboard Lock by default, not remapping, and no progressive web app (left out entirely for now). What reaches the page reaches the terminal, in every browser.
- **D4: a few MB more per Linux file is fine**, as long as nothing in browser mode needs WebKitGTK. Browser mode on Linux is a second, static payload in the same file (§3.6), so a system without WebKitGTK runs it. On Windows and macOS it is part of the app. The browser is the user's default browser.
- **D5: no authentication.** Authentication is the job of another component, such as a terminating web service, and browser mode can be tested locally without one. The server keeps request checks (`Origin`, `Host`), which are not authentication, so that no website can reach the shell. The shared-machine risk (§5.2) is accepted and documented.
- **D6: local only.** 127.0.0.1, and gty starts the browser itself. Not a server for use behind a reverse proxy.
- **D7: every platform has browser mode.** Linux and Windows fall back to it automatically when their web view is missing; macOS uses it on request.

## 7. Work, in order

1. Move the bridge into the sidecar crate; the app uses it from there (no change in behaviour; the existing app tests pass).
2. Browser mode in the sidecar crate: the HTTP server, the request checks, `/boot.json`, IPC over the WebSocket, `arboard`, notifications and links, lifetime handling; and the server tests. Confirm the static Linux build still links nothing.
3. Page changes in `native/` (boot, IPC, links, the disconnected state), with unit tests.
4. Starting the browser: the default-browser lookup on each platform, the private profiles, the flags; end-to-end tests with Chromium and Firefox.
5. Linux launcher and packaging: the second payload, the selection logic, the messages; launcher tests on Debian and Alpine; a static armhf sidecar.
6. Windows: the WebView2 check at start, `auto` and `--browser`; the GitHub Actions test. macOS: `--browser`.
7. The keys test, and docs: `app/README.md` (the viewer setting, the lost keys per browser, the shared-machine risk), the root README.

## 8. Open points (after building it)

Nov 27, 2026.

1. **Size: decided, carry the page once.** With the page in both programs each Linux file was about 24 MB (the page is mostly the bundled Nerd Font, about 10 MB of WOFF2, which does not compress further). Now the Linux builds use the `page-payload` feature: neither program has the page built in, and the launcher carries it once, as a third gzip stream after the two programs (app/pack.sh). The program that runs reads it from the launcher file into memory at start (`GTY_PAGE` says where; the program removes it from its environment), so the page is still served from memory, not unpacked to disk. Each Linux file is now about 13.6 MB, about 1.5 MB more than before browser mode. Windows and macOS keep the page built in. A program in `~/.cache/gty/bin` runs only from its launcher, and says so.
2. **The keys test (§4) cannot be automated.** Playwright sends keys to the page directly, past the browser's own shortcuts, so a test would see every key arrive. The reserved keys listed in app/README.md come from the browsers' documented behaviour, not from a measurement.
3. **Not run on a real machine yet:**
   - the default-browser lookup on Windows (registry) and macOS (Launch Services): unit-tested parsers, and GitHub Actions runs browser mode on both, but without starting a browser;
   - a real browser started by gty: the tests start real Chromium and Firefox themselves (Playwright, with `GTY_BROWSER_NO_LAUNCH`), and test gty's own launching with a stand-in browser that records its command line;
   - Flatpak and Snap browsers;
   - the clipboard in browser mode (arboard: X11, or Wayland data-control).
