#!/bin/sh
# Makes a one-file gty: the launcher (gty.sh) with the app appended, gzipped.
#   app/pack.sh <the gty binary> <output> <platform>
# platform: linux-x64, linux-arm64, linux-armhf, alpine-x64 or alpine-arm64
# (VS Code's names). The binary must be built for it.
set -eu
bin=$1 out=$2 platform=$3
here=$(dirname -- "$0")
# machine: ELF e_machine; arches: what uname -m says on machines that run it
# (32-bit ARM systems often run a 64-bit kernel); loader: the ELF interpreter.
case $platform in
    linux-x64) machine=62 arches=x86_64 libc=glibc loader=/lib64/ld-linux-x86-64.so.2 ;;
    linux-arm64) machine=183 arches=aarch64 libc=glibc loader=/lib/ld-linux-aarch64.so.1 ;;
    linux-armhf) machine=40 arches="armv7l armv8l aarch64" libc=glibc loader=/lib/ld-linux-armhf.so.3 ;;
    alpine-x64) machine=62 arches=x86_64 libc=musl loader=/lib/ld-musl-x86_64.so.1 ;;
    alpine-arm64) machine=183 arches=aarch64 libc=musl loader=/lib/ld-musl-aarch64.so.1 ;;
    *) echo "pack.sh: unknown platform $platform" >&2; exit 2 ;;
esac
got=$(od -An -tu2 -j18 -N2 "$bin" | tr -d ' ')
[ "$got" = "$machine" ] || { echo "pack.sh: $bin is ELF machine $got, not $machine ($platform)" >&2; exit 1; }
if command -v readelf >/dev/null 2>&1; then
    interp=$(readelf -l "$bin" | sed -n 's/.*Requesting program interpreter: \(.*\)]/\1/p')
    [ "$interp" = "$loader" ] || { echo "pack.sh: $bin uses the loader $interp, not $loader ($platform)" >&2; exit 1; }
fi
id=$(sha256sum < "$bin" | cut -d' ' -f1)
line=$(( $(wc -l < "$here/gty.sh") + 1 ))
sed -e "s|@PLATFORM@|$platform|g" -e "s|@ARCHES@|$arches|g" -e "s|@LIBC@|$libc|g" -e "s|@LOADER@|$loader|g" \
    -e "s|@ID@|$id|g" -e "s|@LINE@|$line|g" "$here/gty.sh" > "$out.tmp"
! grep -n '@[A-Z]*@' "$out.tmp" | head -n 1 | grep . >&2 || { echo "pack.sh: placeholder left" >&2; exit 1; }
gzip -9n < "$bin" >> "$out.tmp"
chmod 755 "$out.tmp"
mv -f "$out.tmp" "$out"
