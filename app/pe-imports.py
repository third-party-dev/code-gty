"""Prints the DLLs a Windows executable imports (its PE import table), one per line.
   python3 app/pe-imports.py gty.exe"""
import struct, sys

data = open(sys.argv[1], "rb").read()
pe = struct.unpack_from("<I", data, 0x3C)[0]
assert data[pe:pe + 4] == b"PE\0\0", "not a PE file"
nsect, = struct.unpack_from("<H", data, pe + 6)
optsize, = struct.unpack_from("<H", data, pe + 20)
opt = pe + 24
magic, = struct.unpack_from("<H", data, opt)
dirs = opt + (96 if magic == 0x10B else 112)        # PE32 or PE32+
import_rva, = struct.unpack_from("<I", data, dirs + 8)  # data directory 1: imports
sections = [struct.unpack_from("<8sIIII", data, opt + optsize + 40 * i) for i in range(nsect)]

def offset(rva):
    for _, vsize, vaddr, rawsize, rawptr in sections:
        if vaddr <= rva < vaddr + max(vsize, rawsize):
            return rawptr + rva - vaddr
    raise ValueError("rva %#x outside the sections" % rva)

entry = offset(import_rva)
while True:
    name_rva = struct.unpack_from("<5I", data, entry)[3]
    if name_rva == 0:
        break
    start = offset(name_rva)
    print(data[start:data.index(b"\0", start)].decode("ascii"))
    entry += 20
