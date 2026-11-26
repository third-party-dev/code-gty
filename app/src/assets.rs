//! The page and everything it loads, built into the binary: the extension's
//! terminal page (extension/media) and the app's page bundle (assets/, made
//! by `npm run build` in extension/). Served only from here, never from disk.

pub struct Asset {
    pub bytes: &'static [u8],
    pub mime: &'static str,
}

macro_rules! media {
    ($f:literal) => {
        include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../extension/media/", $f))
    };
}
macro_rules! app {
    ($f:literal) => {
        include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/assets/", $f))
    };
}
macro_rules! shell {
    ($f:literal) => {
        ($f, include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../extension/shell-integration/", $f)) as &[u8])
    };
}

pub const VT_WASM: &[u8] = media!("ghostty-vt.wasm");

pub fn get(path: &str) -> Option<Asset> {
    let (bytes, mime): (&'static [u8], &'static str) = match path {
        "/" | "/index.html" => (app!("index.html"), "text/html; charset=utf-8"),
        "/app.js" => (app!("app.js"), "text/javascript; charset=utf-8"),
        "/theme.css" => (app!("theme.css"), "text/css; charset=utf-8"),
        "/webview.css" => (media!("webview.css"), "text/css; charset=utf-8"),
        "/ghostty-vt.wasm" => (VT_WASM, "application/wasm"),
        "/fonts/IosevkaTermNerdFontMono-Regular.woff2" => (media!("fonts/IosevkaTermNerdFontMono-Regular.woff2"), "font/woff2"),
        "/fonts/IosevkaTermNerdFontMono-Bold.woff2" => (media!("fonts/IosevkaTermNerdFontMono-Bold.woff2"), "font/woff2"),
        "/fonts/IosevkaTermNerdFontMono-Italic.woff2" => (media!("fonts/IosevkaTermNerdFontMono-Italic.woff2"), "font/woff2"),
        "/fonts/IosevkaTermNerdFontMono-BoldItalic.woff2" => (media!("fonts/IosevkaTermNerdFontMono-BoldItalic.woff2"), "font/woff2"),
        _ => return None,
    };
    Some(Asset { bytes, mime })
}

/// The shell-integration scripts, written out for the shells to source.
pub const SHELL_INTEGRATION: &[(&str, &[u8])] = &[
    shell!("bash/gty.bash"),
    shell!("zsh/.zshenv"),
    shell!("zsh/.zprofile"),
    shell!("zsh/.zshrc"),
    shell!("zsh/.zlogin"),
    shell!("zsh/gty.zsh"),
    shell!("fish/gty.fish"),
    shell!("pwsh/gty.ps1"),
];
