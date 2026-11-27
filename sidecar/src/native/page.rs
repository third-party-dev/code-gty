//! The page's files carried by the Linux launcher (app/gty.sh) instead of
//! being built into each of its two programs (the app and browser mode), so
//! the one file has them once. The launcher appends them after the programs
//! as one gzip stream of entries, each `<name>\n<length>\n<bytes>` (app/pack.sh),
//! and tells the program where it starts in GTY_PAGE: `<line> <skip> <file>`,
//! i.e. after the file's first line-1 lines and then `skip` bytes. The
//! program reads it once, at start, into memory, and serves it from there.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read};

pub type Files = HashMap<String, &'static [u8]>;

/// Reads the page from where GTY_PAGE says (`spec`).
pub fn from_launcher(spec: &str) -> Result<Files, String> {
    let mut it = spec.splitn(3, ' ');
    let (line, skip, path) = match (it.next(), it.next(), it.next()) {
        (Some(l), Some(s), Some(p)) if !p.is_empty() => (
            l.parse::<u64>().map_err(|_| format!("bad GTY_PAGE {spec:?}"))?,
            s.parse::<u64>().map_err(|_| format!("bad GTY_PAGE {spec:?}"))?,
            p,
        ),
        _ => return Err(format!("bad GTY_PAGE {spec:?}")),
    };
    let damaged = |e: io::Error| format!("{path} is damaged (the page it carries does not unpack: {e})");
    let mut f = BufReader::new(File::open(path).map_err(|e| format!("cannot read {path}: {e}"))?);
    let mut buf = Vec::new();
    for _ in 1..line {
        buf.clear();
        if f.read_until(b'\n', &mut buf).map_err(damaged)? == 0 {
            return Err(damaged(io::ErrorKind::UnexpectedEof.into()));
        }
    }
    if io::copy(&mut f.by_ref().take(skip), &mut io::sink()).map_err(damaged)? != skip {
        return Err(damaged(io::ErrorKind::UnexpectedEof.into()));
    }
    // The stream's CRC and length catch a damaged or truncated file.
    let mut data = Vec::new();
    flate2::bufread::GzDecoder::new(f).read_to_end(&mut data).map_err(damaged)?;
    parse(Box::leak(data.into_boxed_slice())).map_err(|e| format!("{path} is damaged ({e})"))
}

/// The entries of an unpacked page stream.
pub fn parse(mut data: &'static [u8]) -> Result<Files, String> {
    let mut files = HashMap::new();
    while !data.is_empty() {
        let (name, rest) = field(data)?;
        let (len, rest) = field(rest)?;
        let len: usize = len.parse().map_err(|_| format!("bad length {len:?} for {name}"))?;
        if rest.len() < len {
            return Err(format!("{name} is cut short"));
        }
        files.insert(name.to_string(), &rest[..len]);
        data = &rest[len..];
    }
    Ok(files)
}

fn field(data: &'static [u8]) -> Result<(&'static str, &'static [u8]), String> {
    let end = data.iter().position(|&b| b == b'\n').ok_or("an entry is cut short")?;
    let s = std::str::from_utf8(&data[..end]).map_err(|_| "an entry's name is not UTF-8")?;
    Ok((s, &data[end + 1..]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn entries(list: &[(&str, &[u8])]) -> Vec<u8> {
        let mut v = Vec::new();
        for (name, bytes) in list {
            v.extend_from_slice(format!("{name}\n{}\n", bytes.len()).as_bytes());
            v.extend_from_slice(bytes);
        }
        v
    }

    #[test]
    fn parses_entries() {
        let data: &'static [u8] = Box::leak(entries(&[("app/index.html", b"<html>\n"), ("media/x.wasm", b"\0\x01\n\n")]).into_boxed_slice());
        let files = parse(data).unwrap();
        assert_eq!(files["app/index.html"], b"<html>\n");
        assert_eq!(files["media/x.wasm"], b"\0\x01\n\n");
        assert_eq!(files.len(), 2);
        assert!(parse(Box::leak(b"a\n5\nabc".to_vec().into_boxed_slice())).is_err());
        assert!(parse(Box::leak(b"a\nx\n".to_vec().into_boxed_slice())).is_err());
        assert!(parse(Box::leak(b"a".to_vec().into_boxed_slice())).is_err());
    }

    #[test]
    fn reads_from_after_the_launcher_and_the_programs() {
        let dir = std::env::temp_dir().join(format!("gty-page-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("gty");
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(&entries(&[("app/app.js", b"go()")])).unwrap();
        let gz = gz.finish().unwrap();
        let mut file = b"#!/bin/sh\nexit\n".to_vec();
        file.extend_from_slice(b"PROGRAMS\n\n");
        file.extend_from_slice(&gz);
        std::fs::write(&path, &file).unwrap();
        let spec = format!("3 10 {}", path.display());
        assert_eq!(from_launcher(&spec).unwrap()["app/app.js"], b"go()");
        // Damaged: cut short, or the wrong place.
        std::fs::write(&path, &file[..file.len() - 4]).unwrap();
        assert!(from_launcher(&spec).unwrap_err().contains("damaged"));
        assert!(from_launcher(&format!("3 9 {}", path.display())).is_err());
        assert!(from_launcher("3 x /nowhere").is_err());
        assert!(from_launcher(&format!("9 0 {}", path.display())).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
