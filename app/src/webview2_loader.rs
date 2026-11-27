//! WebView2's loader, for the Windows GNU builds, so that gty.exe is one file.
//!
//! webview2-com-sys links the loader statically on MSVC targets, but on GNU
//! targets it imports WebView2Loader.dll, which would have to ship beside the
//! exe. Instead, this defines the loader's five functions itself (the linker
//! then takes these and imports nothing): each writes the DLL, embedded here,
//! into the directory the app unpacks its other files to, loads it, and
//! forwards the call. The DLL comes from webview2-com-sys (Microsoft lets apps
//! redistribute it); build.rs finds it.

use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use std::sync::OnceLock;

static DLL: &[u8] = include_bytes!(env!("GTY_WEBVIEW2_LOADER"));

/// Where to unpack the DLL: set before the web view is created.
static DIR: OnceLock<PathBuf> = OnceLock::new();
static MODULE: OnceLock<Result<usize, i32>> = OnceLock::new();

pub fn set_dir(dir: PathBuf) {
    let _ = DIR.set(dir);
}

#[link(name = "ole32")]
extern "system" {
    fn CoTaskMemFree(p: *mut c_void);
}

/// Whether the WebView2 runtime is installed: the loader reports its
/// version, or fails when there is none.
pub fn runtime_available() -> bool {
    let mut version: *mut u16 = std::ptr::null_mut();
    // SAFETY: a null folder (the installed runtime) and a place for the string.
    let hr = unsafe { GetAvailableCoreWebView2BrowserVersionString(std::ptr::null(), &mut version) };
    if !version.is_null() {
        // SAFETY: the loader allocates the string with CoTaskMemAlloc.
        unsafe { CoTaskMemFree(version.cast()) };
    }
    hr >= 0 && !version.is_null()
}

#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryW(name: *const u16) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
    fn GetLastError() -> u32;
}

/// HRESULT_FROM_WIN32.
fn hresult(err: u32) -> i32 {
    if err == 0 {
        0x8000_4005_u32 as i32 // E_FAIL
    } else {
        ((err & 0xFFFF) | 0x8007_0000) as i32
    }
}

fn module() -> Result<*mut c_void, i32> {
    let m = MODULE.get_or_init(|| {
        let Some(dir) = DIR.get() else {
            return Err(hresult(0));
        };
        let path = dir.join("WebView2Loader.dll");
        if let Err(e) = gty_sidecar::native::client::write_once(&path, DLL) {
            eprintln!("[gty] cannot write {}: {e}", path.display());
            return Err(hresult(e.raw_os_error().unwrap_or(0) as u32));
        }
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
        // SAFETY: a NUL-terminated wide path.
        let h = unsafe { LoadLibraryW(wide.as_ptr()) };
        if h.is_null() {
            // SAFETY: no arguments.
            return Err(hresult(unsafe { GetLastError() }));
        }
        Ok(h as usize)
    });
    m.map(|h| h as *mut c_void)
}

/// The loader's function `name` (NUL-terminated).
fn function(name: &[u8]) -> Result<*mut c_void, i32> {
    let m = module()?;
    // SAFETY: a loaded module and a NUL-terminated name.
    let f = unsafe { GetProcAddress(m, name.as_ptr()) };
    if f.is_null() {
        // SAFETY: no arguments.
        Err(hresult(unsafe { GetLastError() }))
    } else {
        Ok(f)
    }
}

/// Defines `name` with the loader's signature, forwarding to the DLL's.
macro_rules! forward {
    ($name:ident($($arg:ident: $ty:ty),*)) => {
        #[no_mangle]
        pub unsafe extern "system" fn $name($($arg: $ty),*) -> i32 {
            match function(concat!(stringify!($name), "\0").as_bytes()) {
                Ok(f) => {
                    // SAFETY: the DLL's function of this name has this signature
                    // (the bindings in webview2-com-sys).
                    let f: unsafe extern "system" fn($($ty),*) -> i32 = std::mem::transmute(f);
                    f($($arg),*)
                }
                Err(hr) => hr,
            }
        }
    };
}

forward!(CompareBrowserVersions(version1: *const u16, version2: *const u16, result: *mut i32));
forward!(CreateCoreWebView2Environment(handler: *mut c_void));
forward!(CreateCoreWebView2EnvironmentWithOptions(
    browser_folder: *const u16,
    user_data_folder: *const u16,
    options: *mut c_void,
    handler: *mut c_void
));
forward!(GetAvailableCoreWebView2BrowserVersionString(browser_folder: *const u16, version: *mut *mut u16));
forward!(GetAvailableCoreWebView2BrowserVersionStringWithOptions(
    browser_folder: *const u16,
    options: *mut c_void,
    version: *mut *mut u16
));
