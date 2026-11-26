//! For the Windows GNU builds: the WebView2Loader.dll that
//! src/webview2_loader.rs embeds (the one webview2-com-sys ships for this
//! architecture). GTY_WEBVIEW2_LOADER names it; app/cross.sh finds it with
//! `cargo metadata`.

fn main() {
    println!("cargo:rerun-if-env-changed=GTY_WEBVIEW2_LOADER");
    let windows_gnu = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("gnu");
    if !windows_gnu {
        return;
    }
    match std::env::var("GTY_WEBVIEW2_LOADER") {
        Ok(path) if std::path::Path::new(&path).is_file() => {
            println!("cargo:rerun-if-changed={path}");
            println!("cargo:rustc-env=GTY_WEBVIEW2_LOADER={path}");
        }
        _ => panic!(
            "GTY_WEBVIEW2_LOADER must name webview2-com-sys's WebView2Loader.dll for this architecture \
             (<webview2-com-sys>/x64/ or /arm64/); app/cross.sh sets it"
        ),
    }
}
