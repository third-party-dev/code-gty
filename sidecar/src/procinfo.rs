//! Foreground process detection, used for tab titles and close confirmation.

use crate::protocol::ProcessInfo;

/// `fg` is the terminal's foreground process group, `shell` the shell's pid.
#[cfg(unix)]
pub fn describe(fg: Option<i32>, shell: Option<u32>) -> ProcessInfo {
    match (fg, shell) {
        (Some(fg), Some(shell)) if fg > 0 => {
            ProcessInfo { name: process_name(fg), busy: Some(fg as u32 != shell) }
        }
        (_, Some(shell)) => ProcessInfo { name: process_name(shell as i32), busy: None },
        _ => ProcessInfo { name: None, busy: None },
    }
}

#[cfg(not(unix))]
pub fn describe(_fg: Option<i32>, _shell: Option<u32>) -> ProcessInfo {
    ProcessInfo { name: None, busy: None }
}

#[cfg(target_os = "linux")]
fn process_name(pid: i32) -> Option<String> {
    std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .ok()
        .map(|s| s.trim_end().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn process_name(pid: i32) -> Option<String> {
    let mut buf = [0u8; 256];
    // SAFETY: proc_name writes at most `buffersize` bytes into `buf`.
    let n = unsafe { libc::proc_name(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    Some(String::from_utf8_lossy(&buf[..n as usize]).into_owned())
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos", target_os = "ios"))))]
fn process_name(_pid: i32) -> Option<String> {
    None
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn own_process_has_name() {
        let me = std::process::id();
        let info = describe(Some(me as i32), Some(me));
        assert_eq!(info.busy, Some(false));
        assert!(info.name.is_some());
    }
}
