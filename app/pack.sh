#!/bin/sh
# Makes a one-file gty: the launcher (gty.sh) with the app, browser mode and
# the terminal's page appended, each gzipped.
#   app/pack.sh <the gty binary> <output> <platform> <the gty-browser binary>
# platform: linux-x64, linux-arm64, linux-armhf, alpine-x64 or alpine-arm64
# (VS Code's names). Both binaries must be built for it, with the
# page-payload feature (they do not carry the page: this file has it once,
# for both); gty-browser must be static (it runs where the app's libraries
# are missing). The page is app/assets/* (npm run build in extension/) and
# extension/media's webview.css, ghostty-vt.wasm and fonts: what
# app/src/assets.rs serves.
set -eu
bin=$1 out=$2 platform=$3 browser=$4
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
for b in "$bin" "$browser"; do
    got=$(od -An -tu2 -j18 -N2 "$b" | tr -d ' ')
    [ "$got" = "$machine" ] || { echo "pack.sh: $b is ELF machine $got, not $machine ($platform)" >&2; exit 1; }
done
if command -v readelf >/dev/null 2>&1; then
    interp=$(readelf -l "$bin" | sed -n 's/.*Requesting program interpreter: \(.*\)]/\1/p')
    [ "$interp" = "$loader" ] || { echo "pack.sh: $bin uses the loader $interp, not $loader ($platform)" >&2; exit 1; }
    ! readelf -l "$browser" | grep -q 'program interpreter' || { echo "pack.sh: $browser is not static" >&2; exit 1; }
fi
id=$(sha256sum < "$bin" | cut -d' ' -f1)
browser_id=$(sha256sum < "$browser" | cut -d' ' -f1)
gzip -9n < "$bin" > "$out.app.gz"
app_bytes=$(wc -c < "$out.app.gz" | tr -d ' ')
gzip -9n < "$browser" > "$out.browser.gz"
browser_bytes=$(wc -c < "$out.browser.gz" | tr -d ' ')
# The page: entries of "<name>\n<length>\n<bytes>" (gty_sidecar::native::page).
media=$here/../extension/media
set -- "$here"/assets/* "$media/webview.css" "$media/ghostty-vt.wasm" "$media"/fonts/*.woff2
for f; do
    [ -f "$f" ] || { echo "pack.sh: $f is missing" >&2; exit 1; }
done
for f; do
    case $f in
        "$here"/assets/*) name=app/${f#"$here"/assets/} ;;
        *) name=media/${f#"$media"/} ;;
    esac
    printf '%s\n%s\n' "$name" "$(wc -c < "$f" | tr -d ' ')"
    cat "$f"
done | gzip -9n > "$out.page.gz"
line=$(( $(wc -l < "$here/gty.sh") + 1 ))
sed -e "s|@PLATFORM@|$platform|g" -e "s|@ARCHES@|$arches|g" -e "s|@LIBC@|$libc|g" -e "s|@LOADER@|$loader|g" \
    -e "s|@ID@|$id|g" -e "s|@BROWSER_ID@|$browser_id|g" -e "s|@APP_BYTES@|$app_bytes|g" -e "s|@BROWSER_BYTES@|$browser_bytes|g" -e "s|@LINE@|$line|g" \
    "$here/gty.sh" > "$out.tmp"
! grep -n '@[A-Z_]*@' "$out.tmp" | head -n 1 | grep . >&2 || { echo "pack.sh: placeholder left" >&2; exit 1; }
cat "$out.app.gz" "$out.browser.gz" "$out.page.gz" >> "$out.tmp"
rm -f "$out.app.gz" "$out.browser.gz" "$out.page.gz"
chmod 755 "$out.tmp"
mv -f "$out.tmp" "$out"
