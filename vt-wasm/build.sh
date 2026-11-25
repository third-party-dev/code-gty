#!/bin/sh
# Builds media/ghostty-vt.wasm: libghostty-vt compiled to WebAssembly.
#
#   vt-wasm/build.sh <out-dir>
#
# VT_SOURCE=build (default) builds wasm32-wasi from the release source
# tarball with Zig 0.17, offline from the release's deps tarball, with the
# patches in vt-wasm/patches applied. This is the build code-gty ships: the
# official wasm32-freestanding module has no Kitty graphics, because the
# library disables them on freestanding targets (no clock).
#
# VT_SOURCE=release uses the official signed wasm32-freestanding module
# instead (no Kitty graphics, no Zig needed).
#
# Every download is checked against the minisign signature of the release's
# SHA256SUMS and against hashes pinned here. Needs: curl, sha256sum, tar,
# patch, minisign, and for VT_SOURCE=build a Zig 0.17 binary as $ZIG (or zig
# on PATH).
set -eu

VT_VERSION="${VT_VERSION:-1.0.2}"
VT_SOURCE="${VT_SOURCE:-build}"
# minisign key from https://ghostty.org (libghostty-vt "Installing" guide).
VT_PUBKEY="RWQlAjJC23149WL2sEpT/l0QKy7hMIFhYdQOFy0Z7z7PbneUgvlsnYcV"
# sha256 of SHA256SUMS for VT_VERSION; bump together with VT_VERSION.
VT_SUMS_SHA256="${VT_SUMS_SHA256:-1d898a3addba3e69014768eddbb3450eed242c87c563e2f43eaf573acc449f62}"
ZIG="${ZIG:-zig}"

out="${1:?usage: build.sh <out-dir>}"
here="$(cd "$(dirname "$0")" && pwd)"
work="${WORK:-$(mktemp -d)}"
base="https://release.files.ghostty.org/libghostty-vt/$VT_VERSION"
mkdir -p "$out" "$work/dl"
cd "$work/dl"

fetch() { [ -f "$1" ] || curl -fsSLo "$1" "$base/$1"; }

fetch SHA256SUMS
fetch SHA256SUMS.minisig
minisign -Vm SHA256SUMS -P "$VT_PUBKEY"
echo "$VT_SUMS_SHA256  SHA256SUMS" | sha256sum -c -

if [ "$VT_SOURCE" = release ]; then
  fetch "ghostty-vt-$VT_VERSION-small.wasm"
  grep " ghostty-vt-$VT_VERSION-small.wasm\$" SHA256SUMS | sha256sum -c -
  cp "ghostty-vt-$VT_VERSION-small.wasm" "$out/ghostty-vt.wasm"
  exit 0
fi

fetch "libghostty-vt-$VT_VERSION.tar.gz"
fetch "libghostty-vt-$VT_VERSION-deps.tar.gz"
grep -E " libghostty-vt-$VT_VERSION(-deps)?\.tar\.gz\$" SHA256SUMS | sha256sum -c -

cd "$work"
rm -rf src deps
mkdir src deps
tar -xzf "dl/libghostty-vt-$VT_VERSION.tar.gz" -C src --strip-components=1
tar -xzf "dl/libghostty-vt-$VT_VERSION-deps.tar.gz" -C deps --strip-components=1
cd src
for p in "$here"/patches/*.patch; do
  echo "applying $(basename "$p")"
  patch -p1 --forward < "$p"
done

case "$("$ZIG" version)" in 0.17.*) ;; *) echo "Zig 0.17 is required, found $("$ZIG" version)" >&2; exit 1;; esac
export ZIG_GLOBAL_CACHE_DIR="$work/zig-global" ZIG_LOCAL_CACHE_DIR="$work/zig-local"
"$ZIG" build -Demit-lib-vt -Dtarget=wasm32-wasi -Doptimize=ReleaseSmall \
  --system "$work/deps" --prefix "$work/zig-out"
cp "$work/zig-out/bin/ghostty-vt.wasm" "$out/ghostty-vt.wasm"
ls -l "$out/ghostty-vt.wasm"
