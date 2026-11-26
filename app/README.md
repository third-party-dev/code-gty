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

| `gty-darwin-x64`, `gty-darwin-arm64`, and `.app.zip` of each | macOS 11 or later (WKWebView is part of macOS) |

`SHA256SUMS` lists the files' checksums.

On macOS, the `.app.zip` holds `gty.app`, which opens from Finder; the bare binary runs from a terminal. Release builds come from GitHub Actions, built on macOS and signed (and notarized, when the project's signing secrets are set). Development builds from Docker are cross-built with Apple's SDK and signed ad hoc only: macOS refuses to open them from a download until the quarantine flag is removed (`xattr -dr com.apple.quarantine gty.app`).

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
docker build --target app-out-linux-windows --output type=local,dest=dist/app .   # without macOS
docker build --target test-app .                                    # gty-linux-x64 under Xvfb (Debian)
docker build --target test-app-alpine .                             # gty-alpine-x64 under Xvfb (Alpine)
docker build --target test-app-deps .                               # the launcher without WebKitGTK (Debian), and on the wrong system
docker build --target test-app-deps-alpine .                        # the same on Alpine
app/pack.sh target/release/gty gty-linux-x64 linux-x64              # one file from a local cargo build (in app/)
```

`app/cross.sh` holds each cross build: Debian multiarch WebKitGTK and a cross gcc for linux-arm64 and linux-armhf; an aarch64 Alpine sysroot and clang for alpine-arm64; Zig for Windows, as the sidecar; Zig and Apple's macOS SDK (cargo-zigbuild's image, `ghcr.io/rust-cross/cargo-zigbuild`) for macOS. Using Apple's SDK outside a Mac is against its licence, which is accepted for these development builds; GitHub Actions builds the released macOS app on macOS. The macOS builds are checked with `app/macho-info.py` (frameworks, minimum version, signature); clippy for macOS runs in GitHub Actions. In Docker, the ARM builds are smoke-tested under qemu-user (`--version`, and `--selftest`, a shell in a PTY), and only the x64 builds run the app end to end; the Windows builds are linted and checked to import only Windows' own DLLs. GitHub Actions adds real machines: `gty-linux-arm64` end to end under Xvfb on an arm64 runner, the Windows exes' `--selftest` (a ConPTY shell) on Windows x64 and arm64, and the macOS app's `--selftest` on macOS (see the root README).

## Not yet

- Tabs and splits; a menu; a session list (Manage Sessions) to reattach VS Code's sessions.
- Terminal profiles (`terminal.integrated.profiles.*`): the login shell is used.
- File links (there is no editor to open them in); web links open in the browser.
- Running the macOS app: it builds (Docker and GitHub Actions) and GitHub Actions runs `--selftest`, but the window has not been used. It has no menu bar menus yet (so no Cmd+Q from a menu; closing the window quits).
- Testing the Windows window: GitHub Actions runs `--selftest` (a ConPTY shell) on Windows, but the window, WebView2 and the daemon over TCP have not been used.
- The page runs two libghostty-vt engines (the session's and the renderer's mirror), as the extension does. In one page, one would do; sharing them is an optimisation for later.
