//! libghostty-vt in the sidecar, for sessions no window is attached to.
//!
//! The same WebAssembly module the extension uses (media/ghostty-vt.wasm) runs
//! here through wasmi, a pure-Rust interpreter, so it works on every sidecar
//! target. While a session is detached its output is fed into this engine, so
//! the session's screen, scrollback and modes stay current for hours with no
//! window open; a window that claims the session gets an exact snapshot.
//!
//! Only what that needs is bound: create, restore from a snapshot, write,
//! snapshot. Option and enum values are read from the module's own type
//! manifest (ghostty_type_json), not hard-coded.

use std::collections::HashMap;
use std::sync::Arc;

use wasmi::{Caller, Engine, Extern, Instance, Linker, Memory, Module, Store, TypedFunc};

pub struct VtModule {
    engine: Engine,
    module: Module,
    /// Enum constants by "Type.NAME", from the manifest.
    consts: HashMap<String, i64>,
    pub version: String,
}

pub struct VtTerm {
    store: Store<()>,
    memory: Memory,
    term: u32,
    alloc: TypedFunc<i32, i32>,
    free: TypedFunc<(i32, i32), ()>,
    lib_free: TypedFunc<(i32, i32, i32), ()>,
    write: TypedFunc<(i32, i32, i32), ()>,
    module: Arc<VtModule>,
    instance: Instance,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn instantiate(engine: &Engine, module: &Module) -> Result<(Store<()>, Instance), String> {
    let mut store = Store::new(engine, ());
    let mut linker = <Linker<()>>::new(engine);
    // The only import of our WASI build: log writes, which we discard.
    linker
        .func_wrap("wasi_snapshot_preview1", "fd_write", |mut caller: Caller<'_, ()>, _fd: i32, iovs: i32, n: i32, written: i32| -> i32 {
            let Some(Extern::Memory(mem)) = caller.get_export("memory") else { return 8 };
            let data = mem.data_mut(&mut caller);
            let mut total: u32 = 0;
            for i in 0..n.max(0) as usize {
                let at = iovs as usize + i * 8 + 4;
                if let Some(b) = data.get(at..at + 4) {
                    total = total.wrapping_add(u32::from_le_bytes(b.try_into().unwrap()));
                }
            }
            if let Some(b) = data.get_mut(written as usize..written as usize + 4) {
                b.copy_from_slice(&total.to_le_bytes());
            }
            0
        })
        .map_err(err)?;
    let instance = linker.instantiate_and_start(&mut store, module).map_err(err)?;
    if let Ok(init) = instance.get_typed_func::<(), ()>(&store, "_initialize") {
        init.call(&mut store, ()).map_err(err)?;
    }
    Ok((store, instance))
}

fn cstr(mem: &Memory, store: &Store<()>, p: u32) -> String {
    let data = mem.data(store);
    let start = p as usize;
    let end = data[start..].iter().position(|&b| b == 0).map_or(data.len(), |n| start + n);
    String::from_utf8_lossy(&data[start..end]).into_owned()
}

impl VtModule {
    pub fn load(bytes: &[u8]) -> Result<Arc<VtModule>, String> {
        let engine = Engine::default();
        let module = Module::new(&engine, bytes).map_err(err)?;
        // Read the manifest once, from a throwaway instance.
        let (mut store, instance) = instantiate(&engine, &module)?;
        let mem = instance.get_memory(&store, "memory").ok_or("no memory export")?;
        let type_json = instance.get_typed_func::<(), i32>(&store, "ghostty_type_json").map_err(err)?;
        let version = instance.get_typed_func::<(), i32>(&store, "ghostty_version").map_err(err)?;
        let json_ptr = type_json.call(&mut store, ()).map_err(err)? as u32;
        let json = cstr(&mem, &store, json_ptr);
        let version_ptr = version.call(&mut store, ()).map_err(err)? as u32;
        let version = cstr(&mem, &store, version_ptr);
        let manifest: serde_json::Value = serde_json::from_str(&json).map_err(err)?;
        let mut consts = HashMap::new();
        if let Some(types) = manifest.get("types").and_then(|t| t.as_object()) {
            for (name, t) in types {
                if let Some(values) = t.get("values").and_then(|v| v.as_object()) {
                    for (k, v) in values {
                        if let Some(n) = v.as_i64() {
                            consts.insert(format!("{name}.{k}"), n);
                        }
                    }
                }
            }
        }
        Ok(Arc::new(VtModule { engine, module, consts, version }))
    }

    fn c(&self, key: &str) -> Result<i32, String> {
        self.consts.get(key).map(|&v| v as i32).ok_or_else(|| format!("libghostty-vt has no {key}"))
    }
}

impl VtTerm {
    fn open(module: &Arc<VtModule>) -> Result<VtTerm, String> {
        let (store, instance) = instantiate(&module.engine, &module.module)?;
        let memory = instance.get_memory(&store, "memory").ok_or("no memory export")?;
        let f = |name: &str| instance.get_func(&store, name).ok_or_else(|| format!("no export {name}"));
        let alloc = f("ghostty_wasm_alloc")?.typed::<i32, i32>(&store).map_err(err)?;
        let free = f("ghostty_wasm_free")?.typed::<(i32, i32), ()>(&store).map_err(err)?;
        let lib_free = f("ghostty_free")?.typed::<(i32, i32, i32), ()>(&store).map_err(err)?;
        let write = f("ghostty_terminal_vt_write")?.typed::<(i32, i32, i32), ()>(&store).map_err(err)?;
        Ok(VtTerm { store, memory, term: 0, alloc, free, lib_free, write, module: module.clone(), instance })
    }

    fn func<P: wasmi::WasmParams, R: wasmi::WasmResults>(&self, name: &str) -> Result<TypedFunc<P, R>, String> {
        self.instance.get_typed_func::<P, R>(&self.store, name).map_err(|e| format!("{name}: {e}"))
    }

    fn malloc(&mut self, len: usize) -> Result<i32, String> {
        let p = self.alloc.call(&mut self.store, len.max(1) as i32).map_err(err)?;
        if p == 0 {
            return Err("libghostty-vt: out of memory".into());
        }
        Ok(p)
    }

    fn put(&mut self, p: i32, bytes: &[u8]) {
        self.memory.data_mut(&mut self.store)[p as usize..p as usize + bytes.len()].copy_from_slice(bytes);
    }

    fn get_u32(&self, p: i32) -> u32 {
        let d = self.memory.data(&self.store);
        u32::from_le_bytes(d[p as usize..p as usize + 4].try_into().unwrap())
    }

    fn check(&self, r: i32, what: &str) -> Result<(), String> {
        if r == 0 {
            Ok(())
        } else {
            Err(format!("libghostty-vt {what}: result {r}"))
        }
    }

    /// Calls a constructor that writes a handle through an opaque out-slot.
    fn construct(&mut self, what: &str, call: impl FnOnce(&mut Self, i32) -> Result<i32, String>) -> Result<u32, String> {
        let slot = self.func::<(), i32>("ghostty_wasm_alloc_opaque")?.call(&mut self.store, ()).map_err(err)?;
        let r = call(self, slot)?;
        let handle = self.func::<i32, i32>("ghostty_wasm_take_opaque")?.call(&mut self.store, slot).map_err(err)? as u32;
        self.func::<i32, ()>("ghostty_wasm_free_opaque")?.call(&mut self.store, slot).map_err(err)?;
        self.check(r, what)?;
        if handle == 0 {
            return Err(format!("libghostty-vt {what}: no handle"));
        }
        Ok(handle)
    }

    fn set_u32(&mut self, option: &str, value: u32) -> Result<(), String> {
        let opt = self.module.c(&format!("GhosttyTerminalOption.{option}"))?;
        let p = self.malloc(4)?;
        self.put(p, &value.to_le_bytes());
        let r = self.func::<(i32, i32, i32), i32>("ghostty_terminal_set")?.call(&mut self.store, (self.term as i32, opt, p)).map_err(err)?;
        (self.free).call(&mut self.store, (p, 4)).map_err(err)?;
        self.check(r, option)
    }

    /// Settings both engines share: unfinished input is kept (so a snapshot
    /// can be taken mid-sequence), scrollback, and Ghostty's mode defaults.
    fn configure(&mut self, scrollback_lines: u32) -> Result<(), String> {
        self.set_u32("CONTINUATION_MAX_BYTES", 64 * 1024)?;
        self.set_u32("SCROLLBACK_MAX_LINES", scrollback_lines)?;
        self.set_u32("SCROLLBACK_MAX_BYTES", scrollback_lines.saturating_mul(512).max(512))?;
        // Grapheme clustering (mode 2027) on by default, as in the extension.
        let opt = self.module.c("GhosttyTerminalOption.MODE_DEFAULT")?;
        let p = self.malloc(4)?;
        self.put(p, &[0xeb, 0x07, 1, 0]); // mode 2027 (DEC), value true
        let r = self.func::<(i32, i32, i32), i32>("ghostty_terminal_set")?.call(&mut self.store, (self.term as i32, opt, p)).map_err(err)?;
        (self.free).call(&mut self.store, (p, 4)).map_err(err)?;
        self.check(r, "MODE_DEFAULT")
    }

    /// An empty terminal.
    pub fn new(module: &Arc<VtModule>, cols: u16, rows: u16, scrollback_lines: u32) -> Result<VtTerm, String> {
        let mut t = VtTerm::open(module)?;
        let new = t.func::<(i32, i32, i32, i32), i32>("ghostty_terminal_new")?;
        t.term = t.construct("terminal_new", |t, slot| new.call(&mut t.store, (0, slot, i32::from(cols.max(1)), i32::from(rows.max(1)))).map_err(err))?;
        t.configure(scrollback_lines)?;
        // Kitty images: the same storage limit as the extension's engines.
        let opt = module.c("GhosttyTerminalOption.KITTY_IMAGE_STORAGE_LIMIT")?;
        let p = t.malloc(8)?;
        t.put(p, &(320u64 * 1024 * 1024).to_le_bytes());
        let _ = t.func::<(i32, i32, i32), i32>("ghostty_terminal_set")?.call(&mut t.store, (t.term as i32, opt, p));
        (t.free).call(&mut t.store, (p, 8)).map_err(err)?;
        Ok(t)
    }

    /// A terminal restored from a snapshot taken by the extension.
    pub fn restore(module: &Arc<VtModule>, snapshot: &[u8], scrollback_lines: u32) -> Result<VtTerm, String> {
        let mut t = VtTerm::open(module)?;
        let buf = t.malloc(snapshot.len())?;
        t.put(buf, snapshot);
        let new_buf = t.func::<(i32, i32, i32, i32), i32>("ghostty_snapshot_decoder_new_buf")?;
        let decoder = t.construct("snapshot_decoder_new_buf", |t, slot| new_buf.call(&mut t.store, (0, slot, buf, snapshot.len() as i32)).map_err(err))?;
        let set = t.func::<(i32, i32, i32), i32>("ghostty_snapshot_decoder_set")?;
        let p = t.malloc(4)?;
        for (name, v) in [("MAX_CONTINUATION_BYTES", 64 * 1024u32), ("RETAIN_CONTINUATION", 1), ("COMPRESS_HISTORY", 1)] {
            let opt = module.c(&format!("GhosttySnapshotDecoderOption.{name}"))?;
            // Booleans are one byte; the u32 option reads all four.
            t.put(p, &v.to_le_bytes());
            set.call(&mut t.store, (decoder as i32, opt, p)).map_err(err)?;
        }
        (t.free).call(&mut t.store, (p, 4)).map_err(err)?;
        let decode = t.func::<(i32, i32), i32>("ghostty_snapshot_decoder_decode")?;
        let term = t.construct("snapshot_decoder_decode", |t, slot| decode.call(&mut t.store, (decoder as i32, slot)).map_err(err));
        t.func::<i32, ()>("ghostty_snapshot_decoder_free")?.call(&mut t.store, decoder as i32).map_err(err)?;
        (t.free).call(&mut t.store, (buf, snapshot.len().max(1) as i32)).map_err(err)?;
        t.term = term?;
        t.configure(scrollback_lines)?;
        Ok(t)
    }

    pub fn write(&mut self, data: &[u8]) -> Result<(), String> {
        if data.is_empty() {
            return Ok(());
        }
        let p = self.malloc(data.len())?;
        self.put(p, data);
        let r = self.write.call(&mut self.store, (self.term as i32, p, data.len() as i32)).map_err(err);
        (self.free).call(&mut self.store, (p, data.len() as i32)).map_err(err)?;
        r
    }

    pub fn snapshot(&mut self) -> Result<Vec<u8>, String> {
        let out = self.malloc(8)?;
        let enc = self.func::<(i32, i32, i32, i32), i32>("ghostty_snapshot_encode_alloc")?;
        let r = enc.call(&mut self.store, (self.term as i32, 0, out, out + 4)).map_err(err)?;
        let ptr = self.get_u32(out) as i32;
        let len = self.get_u32(out + 4) as i32;
        (self.free).call(&mut self.store, (out, 8)).map_err(err)?;
        self.check(r, "snapshot_encode")?;
        let bytes = self.memory.data(&self.store)[ptr as usize..(ptr + len) as usize].to_vec();
        (self.lib_free).call(&mut self.store, (0, ptr, len)).map_err(err)?;
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The module the extension ships; tests skip when it has not been built.
    fn module() -> Option<Arc<VtModule>> {
        let path = std::env::var("GTY_VT_WASM").unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../extension/media/ghostty-vt.wasm").into());
        let bytes = std::fs::read(path).ok()?;
        Some(VtModule::load(&bytes).expect("load module"))
    }

    #[test]
    fn write_snapshot_restore_round_trip() {
        let Some(m) = module() else { return };
        let mut a = VtTerm::new(&m, 40, 5, 1000).unwrap();
        for i in 0..30 {
            a.write(format!("line {i}\r\n").as_bytes()).unwrap();
        }
        a.write(b"\x1b[?2004h\x1b[31").unwrap(); // a mode, and an unfinished SGR
        let snap = a.snapshot().unwrap();
        let mut b = VtTerm::restore(&m, &snap, 1000).unwrap();
        a.write(b"mX").unwrap();
        b.write(b"mX").unwrap();
        assert_eq!(a.snapshot().unwrap(), b.snapshot().unwrap());
        assert!(!m.version.is_empty());
    }
}

#[cfg(test)]
mod bench {
    use super::*;

    /// cargo test --release bench_throughput -- --ignored --nocapture
    #[test]
    #[ignore]
    fn bench_throughput() {
        let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../extension/media/ghostty-vt.wasm")).unwrap();
        let m = VtModule::load(&bytes).unwrap();
        let mut t = VtTerm::new(&m, 200, 60, 10000).unwrap();
        let plain: Vec<u8> = (0..2000).flat_map(|i| format!("line {i} {}\r\n", "x".repeat(140)).into_bytes()).collect();
        let colored: Vec<u8> = (0..2000).flat_map(|i| (0..20).map(move |j| format!("\x1b[38;5;{}mword\x1b[0m ", (i + j) % 256)).chain(std::iter::once("\r\n".into())).collect::<String>().into_bytes()).collect();
        for (name, data) in [("plain", &plain), ("sgr", &colored)] {
            let start = std::time::Instant::now();
            let mut n = 0;
            while start.elapsed().as_secs_f64() < 2.0 {
                t.write(data).unwrap();
                n += data.len();
            }
            println!("{name}: {:.1} MB/s", n as f64 / 1e6 / start.elapsed().as_secs_f64());
        }
    }
}
