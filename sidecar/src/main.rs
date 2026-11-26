//! gty-sidecar's entry point; everything is in lib.rs.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(gty_sidecar::run_cli(&args));
}
