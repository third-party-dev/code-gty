//! gty-browser: gty's browser mode as a binary of its own, for Linux
//! systems without WebKitGTK (PLAN-browser-support.md). The launcher
//! (app/gty.sh) runs it instead of the app when WebKitGTK is missing (the
//! default, "auto") or when the browser viewer is asked for. Built static
//! (musl), it links nothing from the system. It is also the session daemon
//! (`--server`), as the app is.
//!
//!   gty-browser [--browser[=PATH]]   the terminal in a web browser
//!   gty-browser --server ... | --selftest | --version

#[path = "../../src/assets.rs"]
mod assets;

use gty_sidecar::native::{boot, browser};

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() {
    // Run from memory or as /proc/self/exe: name the process "gty" in ps.
    #[cfg(target_os = "linux")]
    // SAFETY: PR_SET_NAME reads a NUL-terminated string of up to 16 bytes.
    unsafe {
        libc::prctl(libc::PR_SET_NAME, c"gty".as_ptr());
    }
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--server") | Some("--selftest") => std::process::exit(gty_sidecar::run_cli(&args)),
        Some("--version") => {
            println!("gty {VERSION} (browser mode; sidecar {})", gty_sidecar::BUILD_ID);
            return;
        }
        _ => {}
    }
    if let Err(e) = assets::load() {
        eprintln!("gty: {e}");
        std::process::exit(1);
    }
    let settings = boot::read_settings(&boot::settings_file());
    let browser_path = match boot::viewer(&mut args, &settings) {
        // This binary has no window of its own: every viewer is the browser.
        Ok((_, b)) => b,
        Err(e) => {
            eprintln!("gty: {e}");
            std::process::exit(2);
        }
    };
    if let Some(other) = args.first() {
        eprintln!("usage: gty [--browser[=PATH] | --version]  (unknown argument {other:?})");
        std::process::exit(2);
    }
    std::process::exit(browser::run(VERSION, &assets::ASSETS, browser_path));
}
