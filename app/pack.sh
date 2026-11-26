#!/bin/sh
# Makes the one-file gty: the launcher (gty.sh) with the app appended, gzipped.
#   app/pack.sh <the gty binary> <output>
set -eu
bin=$1 out=$2
here=$(dirname -- "$0")
arch=$(od -An -tu2 -j18 -N2 "$bin" | tr -d ' ')     # ELF e_machine
case $arch in
    62) arch=x86_64 ;;
    183) arch=aarch64 ;;
    *) echo "pack.sh: unknown ELF machine $arch" >&2; exit 1 ;;
esac
id=$(sha256sum < "$bin" | cut -d' ' -f1)
line=$(( $(wc -l < "$here/gty.sh") + 1 ))
sed -e "s/@ARCH@/$arch/" -e "s/@ID@/$id/" -e "s/@LINE@/$line/" "$here/gty.sh" > "$out.tmp"
gzip -9n < "$bin" >> "$out.tmp"
chmod 755 "$out.tmp"
mv -f "$out.tmp" "$out"
