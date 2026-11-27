//! The native app's side of the sidecar crate (the `native` feature): what
//! the desktop app (app/) and its browser mode (app/browser/, and the app
//! itself on Windows and macOS) share. Not built into the VSIX sidecar.
//!
//! - client: finding, starting and connecting to the session daemon
//! - bridge: the page's WebSocket to the daemon
//! - boot: unpacking, the page's start-up data, settings, the viewer choice,
//!   links and notifications
//! - browser, http, launch: browser mode (PLAN-browser-support.md)
//! - page: the page's files as the Linux launcher carries them (app/pack.sh)

pub mod boot;
pub mod bridge;
pub mod browser;
pub mod client;
mod http;
pub mod launch;
pub mod page;

pub use boot::{Asset, Assets, Viewer};
