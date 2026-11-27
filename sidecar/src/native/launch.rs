//! Finding and starting the web browser for browser mode: the one the user
//! named (gty.browser, GTY_BROWSER, --browser=PATH), or else the user's
//! default browser, or else a known browser on PATH. Chromium-family
//! browsers open the page in app mode (a window of its own, no tabs or
//! address bar) and Firefox in a new window, both in a private profile, so
//! the user's extensions, history and cookies are not involved. Other
//! browsers get the address alone, through the system's URL handler.

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Family {
    Chromium,
    Firefox,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Browser {
    /// The command; the address and flags are added after it.
    pub command: Vec<String>,
    pub family: Family,
    /// Names the private profile (e.g. "google-chrome", "org.mozilla.firefox").
    pub name: String,
}

const CHROMIUM: &[&str] = &[
    "chromium",
    "chromium-browser",
    "chrome",
    "google-chrome",
    "google-chrome-stable",
    "google-chrome-beta",
    "google-chrome-unstable",
    "microsoft-edge",
    "microsoft-edge-stable",
    "microsoft-edge-beta",
    "msedge",
    "brave",
    "brave-browser",
    "vivaldi",
    "vivaldi-stable",
    "opera",
    "thorium-browser",
    // Flatpak application ids
    "org.chromium.chromium",
    "com.google.chrome",
    "com.brave.browser",
    "com.microsoft.edge",
    "com.vivaldi.vivaldi",
    "io.github.ungoogled_software.ungoogled_chromium",
    // macOS bundle ids
    "com.google.chrome.beta",
    "com.google.chrome.canary",
    "com.microsoft.edgemac",
    "com.operasoftware.opera",
];
const FIREFOX: &[&str] = &[
    "firefox",
    "firefox-esr",
    "firefox-bin",
    "librewolf",
    "waterfox",
    "org.mozilla.firefox",
    "io.gitlab.librewolf-community",
    "org.mozilla.firefoxdeveloperedition",
    "org.mozilla.nightly",
];
/// Looked for on PATH when there is no default browser (Linux).
#[cfg(all(unix, not(target_os = "macos")))]
const ON_PATH: &[&str] = &[
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "microsoft-edge",
    "microsoft-edge-stable",
    "brave-browser",
    "firefox",
];

fn base(token: &str) -> String {
    let name = token.rsplit(['/', '\\']).next().unwrap_or(token).to_ascii_lowercase();
    name.strip_suffix(".exe").map(str::to_string).unwrap_or(name)
}

/// The family of a command, by any of its words (so `flatpak run
/// org.chromium.Chromium` is Chromium too).
pub fn family(command: &[String]) -> (Family, String) {
    for t in command {
        let b = base(t);
        if CHROMIUM.contains(&b.as_str()) {
            return (Family::Chromium, b);
        }
        if FIREFOX.contains(&b.as_str()) {
            return (Family::Firefox, b);
        }
    }
    (Family::Other, command.first().map(|c| base(c)).unwrap_or_default())
}

/// Splits a command line: double or single quotes group, a backslash escapes
/// in double quotes (as in .desktop files' Exec).
pub fn split(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut any = false;
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                any = true;
                while let Some(c) = chars.next() {
                    match c {
                        '"' => break,
                        '\\' => {
                            if let Some(n) = chars.next() {
                                cur.push(n);
                            }
                        }
                        c => cur.push(c),
                    }
                }
            }
            '\'' => {
                any = true;
                for c in chars.by_ref() {
                    if c == '\'' {
                        break;
                    }
                    cur.push(c);
                }
            }
            c if c.is_whitespace() => {
                if any || !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                    any = false;
                }
            }
            c => cur.push(c),
        }
    }
    if any || !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// The Exec command of a .desktop file's [Desktop Entry], without its field
/// codes (%u, %U, %f, ...).
pub fn desktop_exec(contents: &str) -> Option<Vec<String>> {
    let mut in_entry = false;
    for line in contents.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_entry {
            continue;
        }
        if let Some(v) = line.strip_prefix("Exec=") {
            let words: Vec<String> = split(v)
                .into_iter()
                .filter(|w| !matches!(w.as_str(), "%u" | "%U" | "%f" | "%F" | "%i" | "%c" | "%k"))
                .map(|w| w.replace("%%", "%"))
                .collect();
            return (!words.is_empty()).then_some(words);
        }
    }
    None
}

/// The value of a `reg query` line ("    ProgId    REG_SZ    MSEdgeHTM").
pub fn reg_value(output: &str) -> Option<String> {
    output.lines().find_map(|l| l.split_once("REG_SZ").map(|(_, v)| v.trim().to_string())).filter(|v| !v.is_empty())
}

/// The program of a Windows command line (`"C:\...\msedge.exe" --single-argument %1`).
pub fn windows_program(command: &str) -> Option<String> {
    let c = command.trim();
    let program = match c.strip_prefix('"') {
        Some(rest) => rest.split('"').next()?,
        None => c.split_whitespace().next()?,
    };
    (!program.is_empty()).then(|| program.to_string())
}

/// The https handler's bundle id in Launch Services' preferences, as
/// `plutil -convert json` prints them.
pub fn macos_https_handler(json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    v.get("LSHandlers")?.as_array()?.iter().find_map(|h| {
        let scheme = h.get("LSHandlerURLScheme")?.as_str()?;
        if !scheme.eq_ignore_ascii_case("https") {
            return None;
        }
        Some(h.get("LSHandlerRoleAll")?.as_str()?.to_ascii_lowercase())
    })
}

fn on_path(name: &str) -> Option<PathBuf> {
    if name.contains('/') || name.contains('\\') {
        let p = PathBuf::from(name);
        return p.is_file().then_some(p);
    }
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for candidate in [dir.join(name), dir.join(format!("{name}.exe"))] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn browser(command: Vec<String>) -> Browser {
    let (family, name) = family(&command);
    Browser { command, family, name }
}

/// The browser to use: `explicit` (a path or command), or the default one.
pub fn find(explicit: Option<&str>) -> Option<Browser> {
    if let Some(e) = explicit {
        let mut words = split(e);
        if words.is_empty() {
            return None;
        }
        if let Some(p) = on_path(&words[0]) {
            words[0] = p.to_string_lossy().into_owned();
        }
        return Some(browser(words));
    }
    default_browser()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn default_browser() -> Option<Browser> {
    let from_settings = Command::new("xdg-settings")
        .args(["get", "default-web-browser"])
        .stderr(Stdio::null())
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|id| id.ends_with(".desktop"))
        .and_then(|id| {
            let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
            let data_home = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".local/share"));
            let data_dirs = std::env::var("XDG_DATA_DIRS").unwrap_or_else(|_| "/usr/local/share:/usr/share".into());
            std::iter::once(data_home)
                .chain(data_dirs.split(':').filter(|d| !d.is_empty()).map(PathBuf::from))
                .find_map(|d| std::fs::read_to_string(d.join("applications").join(&id)).ok())
                .and_then(|c| desktop_exec(&c))
        });
    from_settings.map(browser).or_else(|| {
        ON_PATH.iter().find_map(|n| on_path(n)).map(|p| browser(vec![p.to_string_lossy().into_owned()]))
    })
}

#[cfg(windows)]
fn default_browser() -> Option<Browser> {
    let query = |args: &[&str]| -> Option<String> {
        let out = Command::new("reg").arg("query").args(args).stderr(Stdio::null()).output().ok()?;
        reg_value(&String::from_utf8_lossy(&out.stdout))
    };
    let from_settings = query(&[r"HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice", "/v", "ProgId"])
        .and_then(|prog_id| query(&[&format!(r"HKCR\{prog_id}\shell\open\command"), "/ve"]))
        .and_then(|cmd| windows_program(&cmd))
        .filter(|p| Path::new(p).is_file());
    from_settings.or_else(|| {
        ["ProgramFiles(x86)", "ProgramFiles"].iter().find_map(|v| {
            let p = PathBuf::from(std::env::var_os(v)?).join(r"Microsoft\Edge\Application\msedge.exe");
            p.is_file().then(|| p.to_string_lossy().into_owned())
        })
    })
    .map(|p| browser(vec![p]))
}

#[cfg(target_os = "macos")]
fn default_browser() -> Option<Browser> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let plist = home.join("Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist");
    let id = Command::new("plutil")
        .args(["-convert", "json", "-o", "-"])
        .arg(&plist)
        .stderr(Stdio::null())
        .output()
        .ok()
        .and_then(|o| macos_https_handler(&String::from_utf8_lossy(&o.stdout)));
    // `open -na -b <id> --args ...` starts a new instance of that browser
    // with our flags; anything else (Safari, the default when there is no
    // entry) gets the address through `open`.
    Some(match id {
        Some(id) if family(std::slice::from_ref(&id)).0 != Family::Other => {
            let (family, name) = family(std::slice::from_ref(&id));
            Browser { command: vec!["open".into(), "-na".into(), "-b".into(), id, "--args".into()], family, name }
        }
        _ => Browser { command: vec!["open".into()], family: Family::Other, name: "safari".into() },
    })
}

/// Where private browser profiles live.
pub fn profiles_dir() -> PathBuf {
    #[cfg(windows)]
    let base = std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("code-gty"));
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Caches/gty"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(|d| PathBuf::from(d).join("gty"))
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache/gty")));
    base.unwrap_or_else(|| std::env::temp_dir().join("gty")).join("browser-profiles")
}

/// Firefox's first-run pages and prompts, off in the private profile.
const FIREFOX_PREFS: &str = r#"user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("startup.homepage_welcome_url", "");
user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("trailhead.firstrun.didSeeAboutWelcome", true);
"#;

/// The full command line that opens `url` in `b` with `profile`.
pub fn command_line(b: &Browser, url: &str, profile: &Path) -> Vec<String> {
    let mut c = b.command.clone();
    let profile = profile.to_string_lossy().into_owned();
    match b.family {
        Family::Chromium => c.extend([
            format!("--app={url}"),
            format!("--user-data-dir={profile}"),
            "--no-first-run".into(),
            "--no-default-browser-check".into(),
        ]),
        Family::Firefox => c.extend(["-profile".into(), profile, "-no-remote".into(), "--new-window".into(), url.into()]),
        Family::Other => c.push(url.into()),
    }
    c
}

/// Starts the browser on `url`. Returns once it is started; the page's
/// connection, not the browser process, says when it is done (browsers often
/// hand the window to another process and exit).
pub fn launch(b: &Browser, url: &str) -> io::Result<()> {
    let profile = profiles_dir().join(b.name.replace(['/', '\\', ':'], "_"));
    if b.family != Family::Other {
        super::client::private_dir(&profile)?;
        if b.family == Family::Firefox {
            std::fs::write(profile.join("user.js"), FIREFOX_PREFS)?;
        }
    }
    let line = command_line(b, url, &profile);
    eprintln!("[gty] starting {}", line.join(" "));
    Command::new(&line[0]).args(&line[1..]).stdin(Stdio::null()).stdout(Stdio::null()).spawn()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(a: &[&str]) -> Vec<String> {
        a.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn splits_command_lines() {
        assert_eq!(split(r#"flatpak run "org.chromium.Chromium" --x='a b'"#), s(&["flatpak", "run", "org.chromium.Chromium", "--x=a b"]));
        assert_eq!(split(r#""/opt/My Browser/chrome" "" x"#), s(&["/opt/My Browser/chrome", "", "x"]));
        assert_eq!(split(r#""a\"b""#), s(&[r#"a"b"#]));
    }

    #[test]
    fn reads_desktop_files() {
        let firefox = "[Desktop Entry]\nName=Firefox\nExec=firefox %u\n\n[Desktop Action new-window]\nExec=firefox --new-window %u\n";
        assert_eq!(desktop_exec(firefox), Some(s(&["firefox"])));
        let flatpak = "[Desktop Entry]\nExec=/usr/bin/flatpak run --branch=stable --command=chromium org.chromium.Chromium @@u %U @@\n";
        let exec = desktop_exec(flatpak).unwrap();
        assert_eq!(family(&exec).0, Family::Chromium);
        assert_eq!(desktop_exec("[Other]\nExec=x\n"), None);
    }

    #[test]
    fn knows_the_families() {
        assert_eq!(family(&s(&["/usr/bin/google-chrome-stable"])), (Family::Chromium, "google-chrome-stable".into()));
        assert_eq!(family(&s(&[r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"])).0, Family::Chromium);
        assert_eq!(family(&s(&["/usr/lib/firefox-esr/firefox-esr"])).0, Family::Firefox);
        assert_eq!(family(&s(&["com.brave.browser"])).0, Family::Chromium);
        assert_eq!(family(&s(&["/usr/bin/epiphany"])), (Family::Other, "epiphany".into()));
    }

    #[test]
    fn reads_windows_registry_output() {
        let out = "\r\nHKEY_CURRENT_USER\\Software\\...\\UserChoice\r\n    ProgId    REG_SZ    MSEdgeHTM\r\n\r\n";
        assert_eq!(reg_value(out).as_deref(), Some("MSEdgeHTM"));
        assert_eq!(reg_value("ERROR: not found"), None);
        assert_eq!(
            windows_program(r#""C:\Program Files\Mozilla Firefox\firefox.exe" -osint -url "%1""#).as_deref(),
            Some(r"C:\Program Files\Mozilla Firefox\firefox.exe")
        );
        assert_eq!(windows_program(r"C:\x\chrome.exe %1").as_deref(), Some(r"C:\x\chrome.exe"));
    }

    #[test]
    fn reads_launch_services() {
        let json = r#"{"LSHandlers":[{"LSHandlerURLScheme":"mailto","LSHandlerRoleAll":"com.apple.mail"},
                      {"LSHandlerURLScheme":"https","LSHandlerRoleAll":"com.Google.Chrome"}]}"#;
        assert_eq!(macos_https_handler(json).as_deref(), Some("com.google.chrome"));
        assert_eq!(macos_https_handler(r#"{"LSHandlers":[]}"#), None);
    }

    #[test]
    fn builds_command_lines() {
        let p = Path::new("/p");
        let chrome = browser(s(&["chromium"]));
        assert_eq!(
            command_line(&chrome, "http://127.0.0.1:1/", p),
            s(&["chromium", "--app=http://127.0.0.1:1/", "--user-data-dir=/p", "--no-first-run", "--no-default-browser-check"])
        );
        let ff = browser(s(&["firefox"]));
        assert_eq!(command_line(&ff, "u", p), s(&["firefox", "-profile", "/p", "-no-remote", "--new-window", "u"]));
        let other = browser(s(&["xdg-open"]));
        assert_eq!(command_line(&other, "u", p), s(&["xdg-open", "u"]));
    }
}
