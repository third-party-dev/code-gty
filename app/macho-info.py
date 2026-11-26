"""Describes a macOS executable (Mach-O, thin or universal): its architecture,
minimum macOS version, the libraries and frameworks it links, and whether it
has a code signature (Apple Silicon runs only signed code; ad hoc will do).
   python3 app/macho-info.py gty [--require-signature]
--require-signature fails when an arm64 slice is unsigned (Intel Macs run
unsigned code)."""
import struct, sys

LC_LOAD_DYLIB, LC_LOAD_WEAK_DYLIB, LC_REEXPORT_DYLIB = 0xC, 0x80000018, 0x8000001F
LC_CODE_SIGNATURE, LC_BUILD_VERSION, LC_VERSION_MIN_MACOSX = 0x1D, 0x32, 0x24
CPU = {0x01000007: "x86_64", 0x0100000C: "arm64"}


def version(v):
    return f"{v >> 16}.{(v >> 8) & 0xFF}.{v & 0xFF}"


def thin(data, off):
    magic, = struct.unpack_from("<I", data, off)
    assert magic == 0xFEEDFACF, "not a 64-bit little-endian Mach-O"
    cpu, _, _, ncmds, _, _, _ = struct.unpack_from("<iiIIIII", data, off + 4)
    info = {"arch": CPU.get(cpu & 0xFFFFFFFF, hex(cpu)), "libs": [], "signed": False, "minos": "?"}
    p = off + 32
    for _ in range(ncmds):
        cmd, size = struct.unpack_from("<II", data, p)
        if cmd in (LC_LOAD_DYLIB, LC_LOAD_WEAK_DYLIB, LC_REEXPORT_DYLIB):
            name_off, = struct.unpack_from("<I", data, p + 8)
            name = data[p + name_off:p + size].split(b"\0")[0].decode()
            info["libs"].append(name + (" (weak)" if cmd == LC_LOAD_WEAK_DYLIB else ""))
        elif cmd == LC_CODE_SIGNATURE:
            info["signed"] = True
        elif cmd == LC_BUILD_VERSION:
            info["minos"] = version(struct.unpack_from("<I", data, p + 12)[0])
        elif cmd == LC_VERSION_MIN_MACOSX:
            info["minos"] = version(struct.unpack_from("<I", data, p + 8)[0])
        p += size
    return info


def main():
    data = open(sys.argv[1], "rb").read()
    magic, = struct.unpack_from(">I", data, 0)
    if magic == 0xCAFEBABE:   # universal: big-endian header, then one thin binary per arch
        n, = struct.unpack_from(">I", data, 4)
        slices = [thin(data, struct.unpack_from(">iiIII", data, 8 + 20 * i)[2]) for i in range(n)]
    else:
        slices = [thin(data, 0)]
    ok = True
    for s in slices:
        print(f"{s['arch']}: macOS {s['minos']} or later, {'signed' if s['signed'] else 'NOT signed'}")
        for lib in s["libs"]:
            print(f"    {lib}")
        ok = ok and (s["signed"] or s["arch"] != "arm64")
    if "--require-signature" in sys.argv and not ok:
        sys.exit("macho-info.py: the arm64 code has no signature (Apple Silicon will refuse to run it)")


main()
