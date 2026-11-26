//! The system clipboard (text).
//!
//! On Linux (and the BSDs, wherever the window is GTK's) this is GTK's own
//! clipboard: the same on X11, XWayland and every Wayland compositor, with no
//! protocol a compositor may lack. Under Wayland it follows Wayland's rule, as
//! native terminals do: an app may set or read the clipboard only while its
//! window has keyboard focus. Elsewhere (Windows, macOS) it is arboard.
//!
//! Used on the event loop's thread only (GTK's main thread).

pub struct Clipboard {
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    gtk: gtk::Clipboard,
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    arboard: Option<arboard::Clipboard>,
}

impl Clipboard {
    /// Once the event loop exists (on Linux, it starts GTK).
    pub fn new() -> Self {
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            Self { gtk: gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD) }
        }
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            let arboard = arboard::Clipboard::new().map_err(|e| eprintln!("[gty] no clipboard: {e}")).ok();
            Self { arboard }
        }
    }

    pub fn set_text(&mut self, text: &str) {
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        self.gtk.set_text(text);
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        if let Some(c) = self.arboard.as_mut() {
            if let Err(e) = c.set_text(text) {
                eprintln!("[gty] clipboard: {e}");
            }
        }
    }

    /// Calls `done` with the clipboard's text ("" when it holds none), on this
    /// thread: later on Linux, where GTK asks the clipboard's owner for it.
    pub fn read_text(&mut self, done: impl FnOnce(String) + 'static) {
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        self.gtk.request_text(move |_, text| done(text.map(str::to_owned).unwrap_or_default()));
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        done(self.arboard.as_mut().and_then(|c| c.get_text().ok()).unwrap_or_default());
    }
}
