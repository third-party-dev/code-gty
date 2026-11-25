//! Image decoding for the terminal: image files (iTerm2 inline images, in any
//! format the `image` crate reads) and sixel graphics. The host turns the
//! result into Kitty graphics commands, which libghostty-vt draws.
//!
//! Input is untrusted (anything a program prints), so decoding runs with
//! size and memory limits, on its own thread, with panics caught.
//!
//! Request payload: `u32 id | u8 kind | u8 flags | u8[4] background RGBA | data`
//!   kind 0: an image file; kind 1: a sixel DCS body (`P1;P2;P3q...`)
//!   flags bit 0 (sixel): pixels never drawn are transparent
//! Reply payload: `u32 id | u8 status`, then on success
//!   `u32 width | u32 height | u32 frames`, and per frame
//!   `u32 delay_ms | u32 len | zlib-compressed RGBA (len bytes)`;
//!   on failure a UTF-8 message.

use std::io::{Cursor, Write};

use flate2::{write::ZlibEncoder, Compression};
use image::{AnimationDecoder, ImageDecoder, ImageReader, Limits};

pub const KIND_FILE: u8 = 0;
pub const KIND_SIXEL: u8 = 1;

/// Largest image side we decode, in pixels.
const MAX_SIDE: u32 = 10_000;
/// Largest total of decoded pixels across all frames (about 400 MB of RGBA).
const MAX_PIXELS: u64 = 100_000_000;
/// Frames of an animation beyond this are dropped.
const MAX_FRAMES: usize = 1000;

pub struct Frame {
    pub delay_ms: u32,
    pub rgba: Vec<u8>,
}

pub struct Decoded {
    pub width: u32,
    pub height: u32,
    pub frames: Vec<Frame>,
}

pub struct Request<'a> {
    pub id: u32,
    pub kind: u8,
    pub transparent: bool,
    pub background: [u8; 4],
    pub data: &'a [u8],
}

pub fn parse_request(payload: &[u8]) -> Result<Request<'_>, String> {
    if payload.len() < 10 {
        return Err("decode request too short".into());
    }
    Ok(Request {
        id: u32::from_le_bytes(payload[0..4].try_into().unwrap()),
        kind: payload[4],
        transparent: payload[5] & 1 != 0,
        background: payload[6..10].try_into().unwrap(),
        data: &payload[10..],
    })
}

/// Decodes, with panics caught so a bad image can never take the sidecar down.
pub fn decode(req: &Request) -> Result<Decoded, String> {
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match req.kind {
        KIND_FILE => decode_file(req.data),
        KIND_SIXEL => decode_sixel(req.data, req.transparent, req.background),
        k => Err(format!("unknown decode kind {k}")),
    }));
    r.unwrap_or_else(|_| Err("decoder panicked".into()))
}

/// Encodes the reply frame payload.
pub fn reply(id: u32, result: Result<Decoded, String>) -> Vec<u8> {
    let mut out = id.to_le_bytes().to_vec();
    match result.and_then(|d| encode_frames(&d).map(|f| (d, f))) {
        Ok((d, frames)) => {
            out.push(0);
            out.extend_from_slice(&d.width.to_le_bytes());
            out.extend_from_slice(&d.height.to_le_bytes());
            out.extend_from_slice(&(frames.len() as u32).to_le_bytes());
            for (delay, z) in frames {
                out.extend_from_slice(&delay.to_le_bytes());
                out.extend_from_slice(&(z.len() as u32).to_le_bytes());
                out.extend_from_slice(&z);
            }
        }
        Err(e) => {
            out.push(1);
            out.extend_from_slice(e.as_bytes());
        }
    }
    out
}

fn encode_frames(d: &Decoded) -> Result<Vec<(u32, Vec<u8>)>, String> {
    let mut total = 0usize;
    let mut out = Vec::with_capacity(d.frames.len());
    for f in &d.frames {
        let mut z = ZlibEncoder::new(Vec::new(), Compression::fast());
        z.write_all(&f.rgba).map_err(|e| e.to_string())?;
        let z = z.finish().map_err(|e| e.to_string())?;
        total += z.len() + 8;
        // Keep the reply inside one protocol frame.
        if total > crate::protocol::MAX_FRAME - 64 {
            if out.is_empty() {
                return Err("image too large to send".into());
            }
            break;
        }
        out.push((f.delay_ms, z));
    }
    Ok(out)
}

fn limits() -> Limits {
    let mut l = Limits::default();
    l.max_image_width = Some(MAX_SIDE);
    l.max_image_height = Some(MAX_SIDE);
    l.max_alloc = Some(512 * 1024 * 1024);
    l
}

fn decode_file(data: &[u8]) -> Result<Decoded, String> {
    let reader = ImageReader::new(Cursor::new(data)).with_guessed_format().map_err(|e| e.to_string())?;
    let format = reader.format().ok_or("unknown image format")?;
    if format == image::ImageFormat::Gif {
        if let Some(d) = decode_gif(data)? {
            return Ok(d);
        }
    }
    let mut reader = reader;
    reader.limits(limits());
    let img = reader.decode().map_err(|e| e.to_string())?.to_rgba8();
    let (width, height) = img.dimensions();
    Ok(Decoded { width, height, frames: vec![Frame { delay_ms: 0, rgba: img.into_raw() }] })
}

/// Animated GIFs keep their frames; a single-frame GIF returns None.
fn decode_gif(data: &[u8]) -> Result<Option<Decoded>, String> {
    let mut dec = image::codecs::gif::GifDecoder::new(Cursor::new(data)).map_err(|e| e.to_string())?;
    dec.set_limits(limits()).map_err(|e| e.to_string())?;
    let mut frames = Vec::new();
    let (mut width, mut height) = (0, 0);
    let mut pixels: u64 = 0;
    for f in dec.into_frames() {
        let f = f.map_err(|e| e.to_string())?;
        let (num, den) = f.delay().numer_denom_ms();
        let buf = f.into_buffer();
        (width, height) = buf.dimensions();
        pixels += u64::from(width) * u64::from(height);
        if pixels > MAX_PIXELS || frames.len() >= MAX_FRAMES {
            break;
        }
        frames.push(Frame { delay_ms: num.checked_div(den).map_or(100, |d| d.max(20)), rgba: buf.into_raw() });
    }
    if frames.len() <= 1 {
        return Ok(None);
    }
    Ok(Some(Decoded { width, height, frames }))
}

// ---- sixel ------------------------------------------------------------------

/// The VT340's default 16 colour registers, in percent.
const VT340: [(u8, u8, u8); 16] = [
    (0, 0, 0),
    (20, 20, 80),
    (80, 13, 13),
    (20, 80, 20),
    (80, 20, 80),
    (20, 80, 80),
    (80, 80, 20),
    (53, 53, 53),
    (26, 26, 26),
    (33, 33, 60),
    (60, 26, 26),
    (33, 60, 33),
    (60, 33, 60),
    (33, 60, 60),
    (60, 60, 33),
    (80, 80, 80),
];

fn pct(v: u32) -> u8 {
    ((v.min(100) * 255 + 50) / 100) as u8
}

/// DEC HLS: hue 0 is blue, 120 red, 240 green; lightness and saturation in percent.
fn hls_to_rgb(h: u32, l: u32, s: u32) -> [u8; 3] {
    let h = ((h % 360) + 240) % 360; // DEC blue at 0 -> standard blue at 240
    let (l, s) = (l.min(100) as f64 / 100.0, s.min(100) as f64 / 100.0);
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = h as f64 / 60.0;
    let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
    let (r, g, b) = match hp as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    let f = |v: f64| ((v + m) * 255.0).round().clamp(0.0, 255.0) as u8;
    [f(r), f(g), f(b)]
}

struct Canvas {
    width: u32,
    height: u32,
    /// Colour register index + 1 per pixel; 0 means never drawn.
    px: Vec<u16>,
}

impl Canvas {
    fn ensure(&mut self, w: u32, h: u32) -> Result<(), String> {
        if w <= self.width && h <= self.height {
            return Ok(());
        }
        if w > MAX_SIDE || h > MAX_SIDE {
            return Err("sixel image too large".into());
        }
        // Grow in steps to avoid reallocating for every column.
        let nw = w.max(self.width).max((self.width * 3 / 2).min(MAX_SIDE));
        let nh = h.max(self.height);
        let mut next = vec![0u16; (nw * nh) as usize];
        for y in 0..self.height {
            let src = (y * self.width) as usize;
            let dst = (y * nw) as usize;
            next[dst..dst + self.width as usize].copy_from_slice(&self.px[src..src + self.width as usize]);
        }
        self.px = next;
        self.width = nw;
        self.height = nh;
        Ok(())
    }
}

fn decode_sixel(body: &[u8], transparent_flag: bool, background: [u8; 4]) -> Result<Decoded, String> {
    // Header: P1;P2;P3 then the final byte 'q'.
    let q = body.iter().position(|&b| b == b'q').ok_or("not a sixel sequence")?;
    let params: Vec<u32> = std::str::from_utf8(&body[..q])
        .unwrap_or("")
        .split(';')
        .map(|p| p.parse().unwrap_or(0))
        .collect();
    // P2 = 1: pixels that are not drawn keep their current (transparent) colour.
    let transparent = transparent_flag || params.get(1) == Some(&1);
    let data = &body[q + 1..];

    let mut palette: Vec<[u8; 3]> = vec![[0, 0, 0]; 1024];
    for (i, (r, g, b)) in VT340.iter().enumerate() {
        palette[i] = [pct(u32::from(*r)), pct(u32::from(*g)), pct(u32::from(*b))];
    }
    let mut canvas = Canvas { width: 0, height: 0, px: Vec::new() };
    let (mut raster_w, mut raster_h) = (0u32, 0u32);
    let (mut x, mut band) = (0u32, 0u32);
    let (mut max_x, mut max_y) = (0u32, 0u32);
    let mut color: u16 = 0;
    let mut i = 0;
    let num = |i: &mut usize| -> Vec<u32> {
        let mut out = vec![0u32];
        while *i < data.len() {
            match data[*i] {
                b'0'..=b'9' => {
                    let last = out.last_mut().unwrap();
                    *last = last.saturating_mul(10).saturating_add(u32::from(data[*i] - b'0'));
                }
                b';' => out.push(0),
                _ => break,
            }
            *i += 1;
        }
        out
    };
    while i < data.len() {
        let c = data[i];
        i += 1;
        match c {
            b'"' => {
                let p = num(&mut i);
                raster_w = p.get(2).copied().unwrap_or(0).min(MAX_SIDE);
                raster_h = p.get(3).copied().unwrap_or(0).min(MAX_SIDE);
            }
            b'#' => {
                let p = num(&mut i);
                let reg = (p[0] as usize).min(palette.len() - 1);
                if p.len() >= 5 {
                    palette[reg] = match p[1] {
                        1 => hls_to_rgb(p[2], p[3], p[4]),
                        _ => [pct(p[2]), pct(p[3]), pct(p[4])],
                    };
                }
                color = reg as u16;
            }
            b'$' => x = 0,
            b'-' => {
                x = 0;
                band += 1;
            }
            b'!' => {
                let n = num(&mut i)[0].clamp(1, MAX_SIDE);
                if i < data.len() && (0x3f..=0x7e).contains(&data[i]) {
                    let bits = data[i] - 0x3f;
                    i += 1;
                    put(&mut canvas, x, band, n, bits, color, &mut max_x, &mut max_y)?;
                    x = x.saturating_add(n);
                }
            }
            0x3f..=0x7e => {
                put(&mut canvas, x, band, 1, c - 0x3f, color, &mut max_x, &mut max_y)?;
                x += 1;
            }
            _ => {}
        }
    }
    let width = max_x.max(raster_w);
    let height = max_y.max(raster_h);
    if width == 0 || height == 0 {
        return Err("empty sixel image".into());
    }
    let mut rgba = vec![0u8; (width * height * 4) as usize];
    for y in 0..height {
        for xx in 0..width {
            let o = ((y * width + xx) * 4) as usize;
            let v = if xx < canvas.width && y < canvas.height { canvas.px[(y * canvas.width + xx) as usize] } else { 0 };
            if v == 0 {
                if !transparent {
                    rgba[o..o + 4].copy_from_slice(&background);
                }
            } else {
                let [r, g, b] = palette[(v - 1) as usize];
                rgba[o..o + 4].copy_from_slice(&[r, g, b, 255]);
            }
        }
    }
    Ok(Decoded { width, height, frames: vec![Frame { delay_ms: 0, rgba }] })
}

#[allow(clippy::too_many_arguments)]
fn put(c: &mut Canvas, x: u32, band: u32, n: u32, bits: u8, color: u16, max_x: &mut u32, max_y: &mut u32) -> Result<(), String> {
    if bits == 0 {
        // Nothing is drawn, but the image still extends this far.
        *max_x = (*max_x).max(x + n);
        return Ok(());
    }
    let y0 = band * 6;
    c.ensure(x + n, y0 + 6)?;
    for dy in 0..6 {
        if bits & (1 << dy) == 0 {
            continue;
        }
        let y = y0 + dy;
        let row = (y * c.width) as usize;
        for xx in x..x + n {
            c.px[row + xx as usize] = color + 1;
        }
        *max_y = (*max_y).max(y + 1);
    }
    *max_x = (*max_x).max(x + n);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sixel_red_rectangle() {
        // termseq.py's test image: 40 x 18 red.
        let d = decode_sixel(b"0;0;0q\"1;1;40;18#1;2;100;0;0#1!40~-!40~-!40~", false, [0, 0, 0, 255]).unwrap();
        assert_eq!((d.width, d.height), (40, 18));
        assert_eq!(&d.frames[0].rgba[0..4], &[255, 0, 0, 255]);
        let last = ((18 * 40) - 1) * 4;
        assert_eq!(&d.frames[0].rgba[last..last + 4], &[255, 0, 0, 255]);
    }

    #[test]
    fn sixel_transparency_and_repeat() {
        // Pixel 0 of band 0 only (bits=1 -> '@'), on a transparent background.
        let d = decode_sixel(b"0;1;0q#2;2;0;100;0#2@!3?", false, [9, 9, 9, 255]).unwrap();
        assert_eq!((d.width, d.height), (4, 1));
        assert_eq!(&d.frames[0].rgba[0..4], &[0, 255, 0, 255]);
        assert_eq!(&d.frames[0].rgba[4..8], &[0, 0, 0, 0]);
    }

    #[test]
    fn hls_primaries() {
        assert_eq!(hls_to_rgb(0, 50, 100), [0, 0, 255]);
        assert_eq!(hls_to_rgb(120, 50, 100), [255, 0, 0]);
        assert_eq!(hls_to_rgb(240, 50, 100), [0, 255, 0]);
    }

    #[test]
    fn png_file_round_trip() {
        let mut png = Vec::new();
        let img = image::RgbaImage::from_pixel(3, 2, image::Rgba([1, 2, 3, 255]));
        img.write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
        let d = decode_file(&png).unwrap();
        assert_eq!((d.width, d.height, d.frames.len()), (3, 2, 1));
        assert_eq!(&d.frames[0].rgba[0..4], &[1, 2, 3, 255]);
    }

    #[test]
    fn garbage_is_an_error_not_a_panic() {
        assert!(decode(&Request { id: 1, kind: KIND_FILE, transparent: false, background: [0; 4], data: b"\x89PNG\r\n\x1a\nbroken" }).is_err());
        assert!(decode(&Request { id: 1, kind: KIND_SIXEL, transparent: false, background: [0; 4], data: b"q!9999~!9999~" }).is_err());
    }

    #[test]
    fn reply_layout() {
        let r = reply(7, Ok(Decoded { width: 1, height: 1, frames: vec![Frame { delay_ms: 0, rgba: vec![1, 2, 3, 4] }] }));
        assert_eq!(&r[0..5], &[7, 0, 0, 0, 0]);
        assert_eq!(u32::from_le_bytes(r[5..9].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(r[13..17].try_into().unwrap()), 1);
        let e = reply(8, Err("bad".into()));
        assert_eq!(&e[4..], b"\x01bad");
    }
}
