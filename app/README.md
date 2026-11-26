# gty: the code-gty terminal as a desktop app

`gty` is the terminal from the code-gty VS Code extension, in a window of its own. It runs the extension's own code, so it behaves the same:

- the terminal page (renderer, keyboard, mouse, selection, find, links, images) is the extension's webview, unchanged;
- each tab's logic (the authoritative libghostty-vt engine, flow control, titles, notifications, OSC 52, ConEmu and Kitty notifications) is the extension's session code (`extension/src/core/`), running in the page;
- shells live in the extension's sidecar daemon. `gty` contains it (`gty --server`), and the app and VS Code use the same one, so they share sessions.

## Running it

Each build is one file, named for VS Code's platform it runs on:

| File | For |
|---|---|
| `gty-linux-x64`, `gty-linux-arm64`, `gty-linux-armhf` | glibc Linux (Debian, Ubuntu, Fedora, Arch, openSUSE, Raspberry Pi OS…), glibc 2.34 or later for x64 |
| `gty-alpine-x64`, `gty-alpine-arm64` | Alpine and other musl Linux |
| `gty-win32-x64.exe`, `gty-win32-arm64.exe` | Windows 10 and 11 (WebView2 is part of Windows) |

There is no macOS build yet: cross-building it needs Apple's macOS SDK, so it has to be built on a Mac. `SHA256SUMS` lists the files' checksums.

Put the file anywhere on `PATH`, under any name (`gty`, say), and run it. The Linux and Alpine files are shell scripts with the app appended, gzipped (about 12 MB). A file for another machine or C library says which one to use instead (on a 64-bit ARM system, `gty-linux-armhf` needs the 32-bit ARM libraries). The Windows exe unpacks WebView2's loader, with the app's other files, into `%LOCALAPPDATA%\code-gty`.

The script runs the app from memory: with Python 3.8 or later (`python3-minimal` is enough), it decompresses the app into a memfd and runs that, so nothing is written to disk. Without Python, or where the kernel does not allow running memfds (`vm.memfd_noexec=2`), it unpacks the app once per build into `~/.cache/gty/bin` and runs it from there; `GTY_NO_MEMFD=1` always does that. The script's Python is a section at its end, which the shell hands to `python3 -c`.

The app needs WebKitGTK 4.1 and GTK 3, which are system libraries on desktop distributions, and glibc 2.34 or later. Before starting the app, the launcher checks the libraries with `ldd`. If any are missing, it names them and prints the install command for apt, dnf, pacman and zypper (or apk, for the Alpine builds), then exits with 127. It does not guess which package manager the system has. `GTY_SKIP_CHECK=1` skips the check.

```sh
sudo apt install libwebkit2gtk-4.1-0     # Debian, Ubuntu (brings in the rest)
sudo dnf install webkit2gtk4.1           # Fedora
apk add webkit2gtk-4.1                   # Alpine
```

The clipboard is GTK's on Linux, so copy and paste work the same on X11 and on every Wayland compositor; on Wayland, as with any native app, a program in the terminal can set or read the clipboard (OSC 52) only while the window has focus. Windows uses its own clipboard.

One window holds one terminal for now. Closing the window ends its shell (with the same "still running" confirmation as a VS Code tab), and so does `exit`.

## Settings

`~/.config/code-gty/settings.json` (`$XDG_CONFIG_HOME`; `%APPDATA%\code-gty` on Windows, `~/Library/Application Support/code-gty` on macOS), with VS Code's setting names:

```json
{
  "terminal.integrated.fontSize": 15,
  "terminal.integrated.cursorStyle": "line",
  "terminal.integrated.scrollback": 10000,
  "codeGty.colors": { "background": "#101010" },
  "codeGty.notifications": "always"
}
```

Settings are read at start. The colour theme follows the system's light or dark mode (VS Code's Dark Modern and Light Modern colours); `codeGty.colors` overrides it.

## How it fits together

```
window (tao) + system web view (wry: WebKitGTK, WKWebView, WebView2)
  └─ gty://localhost/  embedded page: extension/media + app/assets
       ├─ webview/main.ts            the extension's terminal page
       └─ native/                    the page's host: core/session.ts with
            │                        a window view and a native platform
            ├─ WebSocket (127.0.0.1, random token, origin checked)
            │    └─ bridge.rs ── daemon socket ── PTYs   (same daemon as VS Code)
            └─ window.ipc ── main.rs: title, clipboard, web links, notifications, close
```

The page is built by `npm run build` in `extension/` (it writes `app/assets/`); `cargo build` embeds it.

```sh
docker build --target app-out --output type=local,dest=dist/app .   # all builds, and SHA256SUMS
docker build --target test-app .                                    # gty-linux-x64 under Xvfb (Debian)
docker build --target test-app-alpine .                             # gty-alpine-x64 under Xvfb (Alpine)
docker build --target test-app-deps .                               # the launcher without WebKitGTK (Debian), and on the wrong system
docker build --target test-app-deps-alpine .                        # the same on Alpine
app/pack.sh target/release/gty gty-linux-x64 linux-x64              # one file from a local cargo build (in app/)
```

`app/cross.sh` holds each cross build: Debian multiarch WebKitGTK and a cross gcc for linux-arm64 and linux-armhf; an aarch64 Alpine sysroot and clang for alpine-arm64; Zig for Windows, as the sidecar. The ARM builds are smoke-tested under qemu-user (`--version`, and `--selftest`, a shell in a PTY); only the x64 builds run the app end to end. The Windows builds are linted and checked to import only Windows' own DLLs; nothing runs them.

## Not yet

- Tabs and splits; a menu; a session list (Manage Sessions) to reattach VS Code's sessions.
- Terminal profiles (`terminal.integrated.profiles.*`): the login shell is used.
- File links (there is no editor to open them in); web links open in the browser.
- A macOS build (it needs Apple's SDK, so a Mac). The code has its paths (WKWebView), untested.
- Testing on Windows: the exes are built and linted, but the Windows code paths (WebView2, the daemon over TCP, ConPTY shells, `cmd.exe` as the default shell) have not run.
- The page runs two libghostty-vt engines (the session's and the renderer's mirror), as the extension does. In one page, one would do; sharing them is an optimisation for later.
