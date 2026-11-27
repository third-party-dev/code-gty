//! What the app and browser mode both need before the page runs: the files
//! the daemon and the shells read (unpacked next to the daemon's socket), the
//! daemon itself, the page's start-up data, the settings file, and the
//! choice of viewer. Also the desktop actions the page asks for (links,
//! notifications).

use super::client::{self, Daemon};
use serde_json::{json, Value};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// A file of the page: built into the binary, or (Linux) read from the
/// launcher at start (app/src/assets.rs).
pub struct Asset {
    pub bytes: &'static [u8],
    pub mime: &'static str,
}

/// Everything the binary embeds for the page and the shells.
pub struct Assets {
    /// A page file by its URL path ("/index.html", "/app.js", ...); the
    /// daemon's libghostty-vt is "/ghostty-vt.wasm".
    pub get: fn(&str) -> Option<Asset>,
    /// Shell-integration scripts: (path under shell-integration/, contents).
    pub shell_integration: &'static [(&'static str, &'static [u8])],
}

/// The daemon, running, and where the page's files were unpacked.
pub struct Prepared {
    pub daemon: Arc<Daemon>,
    /// gty-<version>-<build>/ next to the daemon's socket.
    pub unpacked: PathBuf,
    pub shell_integration: PathBuf,
}

/// Unpacks libghostty-vt (for the daemon) and the shell-integration scripts
/// (for the shells), private to this user, and starts the daemon so the page
/// does not wait for it.
pub fn prepare(version: &str, assets: &Assets) -> io::Result<Prepared> {
    let dir = client::default_dir();
    client::private_dir(&dir)?;
    let unpacked = unpacked_dir(version);
    let vt = unpacked.join("ghostty-vt.wasm");
    let wasm = (assets.get)("/ghostty-vt.wasm").ok_or_else(|| io::Error::other("the page has no ghostty-vt.wasm"))?;
    client::write_once(&vt, wasm.bytes)?;
    let shell_integration = unpacked.join("shell-integration");
    for (name, data) in assets.shell_integration {
        client::write_once(&shell_integration.join(name), data)?;
    }
    let daemon = Arc::new(Daemon { dir, vt });
    drop(daemon.connect()?);
    Ok(Prepared { daemon, unpacked, shell_integration })
}

/// Where `prepare` unpacks: gty-<version>-<build>/ next to the daemon's socket.
pub fn unpacked_dir(version: &str) -> PathBuf {
    client::default_dir().join(format!("gty-{version}-{}", crate::BUILD_ID))
}

/// `$XDG_CONFIG_HOME/code-gty/settings.json` (or the platform's config dir):
/// VS Code's setting keys, e.g. {"terminal.integrated.fontSize": 15}.
pub fn settings_file() -> PathBuf {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")));
    base.unwrap_or_else(std::env::temp_dir).join("code-gty").join("settings.json")
}

pub fn read_settings(path: &Path) -> Value {
    match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(v @ Value::Object(_)) => v,
            Ok(_) | Err(_) => {
                eprintln!("[gty] {} is not a JSON object; using the defaults", path.display());
                json!({})
            }
        },
        Err(_) => json!({}),
    }
}

fn login_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".into())
    }
    #[cfg(unix)]
    {
        std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into())
    }
}

fn os_names() -> (&'static str, &'static str) {
    if cfg!(target_os = "macos") {
        ("mac", "darwin")
    } else if cfg!(windows) {
        ("windows", "win32")
    } else {
        ("linux", "linux")
    }
}

/// Which viewer shows the page: native/boot.ts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    WebView,
    Browser,
}

/// The page's start-up data (native/boot.ts): the bridge's address, and
/// what the session code needs to start a shell.
pub fn boot(ws: &str, version: &str, shell_integration: &Path, mode: Mode) -> Value {
    let settings_path = settings_file();
    let (os, node_platform) = os_names();
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    let env: serde_json::Map<String, Value> = std::env::vars().map(|(k, v)| (k, v.into())).collect();
    json!({
        "ws": ws,
        "mode": match mode { Mode::WebView => "webview", Mode::Browser => "browser" },
        "version": version,
        "os": os,
        "nodePlatform": node_platform,
        "env": env,
        "home": home,
        "shell": login_shell(),
        "shellIntegrationDir": shell_integration,
        "settings": read_settings(&settings_path),
        "settingsFile": settings_path,
    })
}

/// How the terminal is shown: `gty.viewer` (settings), GTY_VIEWER, or
/// --browser[=PATH] / --webview.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Viewer {
    /// The system web view, or a browser when it is missing (the default).
    Auto,
    WebView,
    Browser,
}

/// The viewer and the browser asked for, from the command line, the
/// environment and the settings, in that order. `args` are the program's
/// arguments; the viewer flags are taken out of them.
pub fn viewer(args: &mut Vec<String>, settings: &Value) -> Result<(Viewer, Option<String>), String> {
    let mut viewer = None;
    let mut browser = None;
    let mut rest = Vec::new();
    for a in args.drain(..) {
        if a == "--browser" {
            viewer = Some(Viewer::Browser);
        } else if let Some(p) = a.strip_prefix("--browser=") {
            viewer = Some(Viewer::Browser);
            browser = Some(p.to_string()).filter(|p| !p.is_empty());
        } else if a == "--webview" {
            viewer = Some(Viewer::WebView);
        } else {
            rest.push(a);
        }
    }
    *args = rest;
    let parse = |v: &str| match v {
        "auto" | "" => Ok(Viewer::Auto),
        "webview" => Ok(Viewer::WebView),
        "browser" => Ok(Viewer::Browser),
        other => Err(format!("unknown viewer {other:?} (auto, webview or browser)")),
    };
    let viewer = match viewer {
        Some(v) => v,
        None => match std::env::var("GTY_VIEWER") {
            Ok(v) => parse(&v)?,
            Err(_) => parse(settings.get("gty.viewer").and_then(Value::as_str).unwrap_or("auto"))?,
        },
    };
    let browser = browser
        .or_else(|| std::env::var("GTY_BROWSER").ok().filter(|b| !b.is_empty()))
        .or_else(|| settings.get("gty.browser").and_then(Value::as_str).map(str::to_string).filter(|b| !b.is_empty()));
    Ok((viewer, browser))
}

/// Web links only (the page checks too): anything else could open files or run handlers.
pub fn open_url(url: &str) {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) || url.chars().any(|c| c.is_control()) {
        return;
    }
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(url).spawn();
    #[cfg(windows)]
    let r = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(url).spawn();
    if let Err(e) = r {
        eprintln!("[gty] could not open {url}: {e}");
    }
}

/// A desktop notification, where there is a notifier (best effort).
pub fn notify(title: &str, body: &str) {
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("notify-send").args(["--app-name=Ghostty", "--", title, body]).spawn();
    }
    // The text goes in as arguments, never into the script, so it cannot run anything.
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("osascript")
            .args(["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)"])
            .args(["-e", "end run", "--", title, body])
            .spawn();
    }
    #[cfg(windows)]
    {
        let _ = (title, body);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn viewer_flags_win_and_are_removed() {
        let settings = json!({ "gty.viewer": "webview", "gty.browser": "/usr/bin/firefox" });
        let mut a = args(&["--browser=/opt/chromium", "x"]);
        // GTY_VIEWER / GTY_BROWSER are not set in the test environment.
        let (v, b) = viewer(&mut a, &settings).unwrap();
        assert_eq!(v, Viewer::Browser);
        assert_eq!(b.as_deref(), Some("/opt/chromium"));
        assert_eq!(a, args(&["x"]));

        let mut a = args(&["--webview"]);
        assert_eq!(viewer(&mut a, &settings).unwrap(), (Viewer::WebView, Some("/usr/bin/firefox".into())));
    }

    #[test]
    fn viewer_settings_and_default() {
        assert_eq!(viewer(&mut vec![], &json!({})).unwrap(), (Viewer::Auto, None));
        assert_eq!(viewer(&mut vec![], &json!({ "gty.viewer": "browser" })).unwrap().0, Viewer::Browser);
        assert!(viewer(&mut vec![], &json!({ "gty.viewer": "tv" })).is_err());
    }
}
