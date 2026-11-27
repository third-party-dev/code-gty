//! The page and everything it loads: the extension's terminal page
//! (extension/media) and the app's page bundle (assets/, made by `npm run
//! build` in extension/). Served only from memory, never from disk.
//!
//! Built into the binary, except with the `page-payload` feature (the Linux
//! builds): there the launcher (app/gty.sh) carries the page once for both
//! of its programs, the app and browser mode (app/pack.sh), and `load` reads
//! it into memory at start (gty_sidecar::native::page).
//!
//! Also built into browser mode's binary (app/browser/), so the paths are
//! relative to this file, not to a package.

use gty_sidecar::native::{Asset, Assets};

/// The table the shared code (gty_sidecar::native) serves and unpacks.
pub static ASSETS: Assets = Assets { get, shell_integration: SHELL_INTEGRATION };

/// The page's files: URL path => source directory (app: app/assets, media:
/// extension/media), file, MIME type. app/pack.sh packs the same files,
/// named "<dir>/<file>".
macro_rules! page {
    ($($url:literal => $dir:ident $file:literal, $mime:literal;)*) => {
        pub fn get(path: &str) -> Option<Asset> {
            let (bytes, mime): (&'static [u8], &'static str) = match path {
                $($url => (page_file!($dir, $file), $mime),)*
                _ => return None,
            };
            Some(Asset { bytes, mime })
        }
        /// The names the launcher's page must have.
        #[cfg(feature = "page-payload")]
        const NAMES: &[&str] = &[$(concat!(stringify!($dir), "/", $file)),*];
    };
}

#[cfg(not(feature = "page-payload"))]
macro_rules! page_file {
    (media, $f:literal) => {
        include_bytes!(concat!("../../extension/media/", $f))
    };
    (app, $f:literal) => {
        include_bytes!(concat!("../assets/", $f))
    };
}

#[cfg(feature = "page-payload")]
macro_rules! page_file {
    ($dir:ident, $f:literal) => {
        payload::get(concat!(stringify!($dir), "/", $f))
    };
}

page! {
    "/" => app "index.html", "text/html; charset=utf-8";
    "/index.html" => app "index.html", "text/html; charset=utf-8";
    "/app.js" => app "app.js", "text/javascript; charset=utf-8";
    "/theme.css" => app "theme.css", "text/css; charset=utf-8";
    "/webview.css" => media "webview.css", "text/css; charset=utf-8";
    "/ghostty-vt.wasm" => media "ghostty-vt.wasm", "application/wasm";
    "/fonts/IosevkaTermNerdFontMono-Regular.woff2" => media "fonts/IosevkaTermNerdFontMono-Regular.woff2", "font/woff2";
    "/fonts/IosevkaTermNerdFontMono-Bold.woff2" => media "fonts/IosevkaTermNerdFontMono-Bold.woff2", "font/woff2";
    "/fonts/IosevkaTermNerdFontMono-Italic.woff2" => media "fonts/IosevkaTermNerdFontMono-Italic.woff2", "font/woff2";
    "/fonts/IosevkaTermNerdFontMono-BoldItalic.woff2" => media "fonts/IosevkaTermNerdFontMono-BoldItalic.woff2", "font/woff2";
}

/// Makes the page ready to serve: with `page-payload`, reads it from the
/// launcher (GTY_PAGE, which it then removes, so the shells do not inherit
/// it); otherwise nothing to do. Call before anything serves the page.
pub fn load() -> Result<(), String> {
    #[cfg(feature = "page-payload")]
    payload::load(NAMES)?;
    Ok(())
}

#[cfg(feature = "page-payload")]
mod payload {
    use gty_sidecar::native::page::{self, Files};
    use std::sync::OnceLock;

    static FILES: OnceLock<Files> = OnceLock::new();

    pub fn load(names: &[&str]) -> Result<(), String> {
        let spec = std::env::var("GTY_PAGE").map_err(|_| {
            "the terminal's page comes with gty's launcher (the gty-<platform> file); run that instead of this program".to_string()
        })?;
        // Still one thread here.
        std::env::remove_var("GTY_PAGE");
        let files = page::from_launcher(&spec)?;
        if let Some(missing) = names.iter().find(|n| !files.contains_key(**n)) {
            return Err(format!("the page gty's launcher carries has no {missing} (a launcher from another build?)"));
        }
        let _ = FILES.set(files);
        Ok(())
    }

    pub fn get(name: &str) -> &'static [u8] {
        FILES.get().and_then(|f| f.get(name).copied()).expect("assets::load runs first")
    }
}

macro_rules! shell {
    ($f:literal) => {
        ($f, include_bytes!(concat!("../../extension/shell-integration/", $f)) as &[u8])
    };
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
