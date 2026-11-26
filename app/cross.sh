#!/bin/sh
# Cross-builds the app for one of VS Code's platforms (run by the Dockerfile).
#   app/cross.sh <platform> setup    install the toolchain and the target's libraries
#   app/cross.sh <platform> build    build /out/gty (gty.exe), then smoke-test it
#
#   linux-arm64, linux-armhf     on Debian (the Rust image): multiarch WebKitGTK
#                                and a cross gcc; tested under qemu-user
#   alpine-x64                   on Alpine, natively
#   alpine-arm64                 on Alpine: an aarch64 Alpine sysroot and clang;
#                                tested under qemu-user
#   darwin-x64, darwin-arm64     with Zig and Apple's macOS SDK (the cargo-zigbuild
#                                image, SDKROOT); for development: releases are
#                                built on macOS by GitHub Actions
#   win32-x64, win32-arm64       with Zig (cargo-zigbuild, as the sidecar);
#                                WebView2 is part of Windows, so no libraries
# linux-x64 is the Dockerfile's app-build stage (native, with clippy).
set -eu

platform=$1 step=$2
case $platform in
    linux-arm64) os=debian deb=arm64 gnu=aarch64-linux-gnu triple=aarch64-unknown-linux-gnu qemu=qemu-aarch64 ;;
    linux-armhf) os=debian deb=armhf gnu=arm-linux-gnueabihf triple=armv7-unknown-linux-gnueabihf qemu=qemu-arm ;;
    alpine-x64) os=alpine triple=x86_64-unknown-linux-musl qemu= ;;
    alpine-arm64) os=alpine apkarch=aarch64 triple=aarch64-unknown-linux-musl qemu=qemu-aarch64 ;;
    darwin-x64) os=darwin triple=x86_64-apple-darwin ;;
    darwin-arm64) os=darwin triple=aarch64-apple-darwin ;;
    win32-x64) os=windows triple=x86_64-pc-windows-gnu ;;
    win32-arm64) os=windows triple=aarch64-pc-windows-gnullvm ;;
    *) echo "cross.sh: unknown platform $platform" >&2; exit 2 ;;
esac
TRIPLE_ENV=$(echo "$triple" | tr 'a-z-' 'A-Z_')   # for CARGO_TARGET_<TRIPLE>_LINKER
triple_env=$(echo "$triple" | tr '-' '_')          # for CC_<triple>

setup() {
    case $os in
        debian)
            dpkg --add-architecture "$deb"
            apt-get update
            # WebKitGTK's -dev packages reach libgirepository1.0-dev (through
            # libgraphene-1.0-dev), which needs gobject-introspection for the
            # target architecture, and with it that architecture's Python,
            # which cannot be installed beside the host's. Linking gty needs
            # no introspection, so an empty package stands in for it.
            ver=$(apt-cache show --no-all-versions "libgirepository1.0-dev:$deb" | sed -n 's/^Version: //p')
            mkdir -p /tmp/stub/DEBIAN
            cat > /tmp/stub/DEBIAN/control <<EOF
Package: libgirepository1.0-dev
Version: $ver
Architecture: $deb
Multi-Arch: same
Maintainer: code-gty build <nobody@invalid>
Description: empty stand-in: building gty needs no GObject introspection
EOF
            dpkg-deb --build /tmp/stub /tmp/stub.deb
            dpkg -i /tmp/stub.deb
            rm -rf /tmp/stub /tmp/stub.deb
            apt-get install -y --no-install-recommends "gcc-$gnu" "libc6-dev-$deb-cross" qemu-user \
                "libwebkit2gtk-4.1-dev:$deb" "libgtk-3-dev:$deb" "libsoup-3.0-dev:$deb" "libjavascriptcoregtk-4.1-dev:$deb"
            rm -rf /var/lib/apt/lists/*
            rustup target add "$triple"
            ;;
        alpine)
            if [ -n "${apkarch:-}" ]; then
                # The target's libraries (and gcc's crt files and libgcc_s),
                # as an Alpine tree of that architecture. Nothing in it runs
                # here except under qemu.
                mkdir -p /sysroot/etc/apk
                cp /etc/apk/repositories /sysroot/etc/apk/
                apk add --root /sysroot --arch "$apkarch" --initdb --no-scripts --no-cache \
                    --keys-dir "/usr/share/apk/keys/$apkarch" \
                    musl-dev gcc webkit2gtk-4.1-dev gtk+3.0-dev libsoup3-dev
                cat > "/usr/local/bin/$apkarch-alpine-linux-musl-cc" <<EOF
#!/bin/sh
exec clang --target=$apkarch-alpine-linux-musl --sysroot=/sysroot -fuse-ld=lld "\$@"
EOF
                chmod +x "/usr/local/bin/$apkarch-alpine-linux-musl-cc"
            fi
            rustup target add "$triple"
            ;;
        windows | darwin)
            ;; # the image has Zig, cargo-zigbuild and the targets
    esac
}

build() {
    cd /src/app
    exe=gty
    case $os in
        debian)
            export "CARGO_TARGET_${TRIPLE_ENV}_LINKER=$gnu-gcc" "CC_$triple_env=$gnu-gcc"
            export PKG_CONFIG_ALLOW_CROSS=1 PKG_CONFIG_SYSROOT_DIR=/ \
                PKG_CONFIG_LIBDIR="/usr/lib/$gnu/pkgconfig:/usr/share/pkgconfig"
            cargo build --locked --release --target "$triple"
            ;;
        alpine)
            # Linked against the system's musl and libraries (Rust's musl
            # targets are static by default).
            flags="-C target-feature=-crt-static"
            if [ -n "${apkarch:-}" ]; then
                cc=$apkarch-alpine-linux-musl-cc
                export "CARGO_TARGET_${TRIPLE_ENV}_LINKER=$cc" "CC_$triple_env=$cc"
                export PKG_CONFIG_ALLOW_CROSS=1 PKG_CONFIG_SYSROOT_DIR=/sysroot \
                    PKG_CONFIG_LIBDIR=/sysroot/usr/lib/pkgconfig:/sysroot/usr/share/pkgconfig
                flags="$flags -C link-self-contained=no"
            fi
            # (RUSTFLAGS, as Cargo ignores per-target flags when it is set;
            # with --target it does not reach build scripts.)
            export RUSTFLAGS="$flags ${RUSTFLAGS:-}"
            cargo build --locked --release --target "$triple"
            ;;
        windows)
            exe=gty.exe
            # The WebView2 loader to embed (src/webview2_loader.rs).
            case $triple in x86_64-*) wv=x64 ;; aarch64-*) wv=arm64 ;; esac
            manifest=$(cargo metadata --locked --format-version 1 --filter-platform "$triple" | python3 -c '
import json, sys
print(next(p["manifest_path"] for p in json.load(sys.stdin)["packages"] if p["name"] == "webview2-com-sys"))')
            export GTY_WEBVIEW2_LOADER="${manifest%/Cargo.toml}/$wv/WebView2Loader.dll"
            ls -l "$GTY_WEBVIEW2_LOADER"
            # The Windows code paths (TCP daemon, ConPTY) are not built
            # anywhere else, so lint them here.
            cargo clippy --locked --release --target "$triple" -- -D warnings
            cargo zigbuild --locked --release --target "$triple"
            ;;
        darwin)
            # The frameworks (AppKit, WebKit, ...) are linked from $SDKROOT.
            # No clippy here: a plain `cargo clippy` would compile objc2's
            # Objective-C helper with the host's cc, not Zig. The macOS job in
            # GitHub Actions lints with Apple's toolchain.
            export MACOSX_DEPLOYMENT_TARGET=11.0
            cargo zigbuild --locked --release --target "$triple"
            ;;
    esac
    mkdir -p /out
    cp "target/$triple/release/$exe" "/out/$exe"
    # The build tree is large and is not needed once the binary is out.
    rm -rf target
    ls -l "/out/$exe"

    # Smoke test: the binary loads its libraries and runs a shell in a PTY.
    case $os in
        debian) run="$qemu -L /" ;;
        alpine) run=${qemu:+$qemu -L /sysroot} ;;
        darwin)
            # No Mac here: check what it links, and that it is signed (Zig's
            # linker signs ad hoc; Apple Silicon runs nothing unsigned).
            python3 /src/app/macho-info.py "/out/$exe" --require-signature
            /src/app/macos-app.sh "/out/$exe" "/out/gty.app"
            # Zipped with the files' modes (the binary must stay executable).
            python3 -c '
import os, sys, zipfile
src, dst = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(dst, "w") as z:
    for root, _, files in sorted(os.walk(src)):
        for name in sorted(files):
            path = os.path.join(root, name)
            info = zipfile.ZipInfo(os.path.relpath(path, os.path.dirname(src)), (1980, 1, 1, 0, 0, 0))
            info.external_attr = (os.stat(path).st_mode & 0xFFFF) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            with open(path, "rb") as f:
                z.writestr(info, f.read())
' /out/gty.app /out/gty.app.zip
            rm -rf /out/gty.app
            return ;;
        windows)
            # No emulator here. It must be one file: only Windows' own DLLs
            # (no WebView2Loader.dll to ship beside it; WebView2 itself is
            # found at run time).
            echo "$exe imports:"; python3 /src/app/pe-imports.py "/out/$exe" | sed 's/^/    /'
            if python3 /src/app/pe-imports.py "/out/$exe" | grep -qi '^webview2loader'; then
                echo "cross.sh: $exe needs WebView2Loader.dll beside it" >&2
                exit 1
            fi
            return ;;
    esac
    $run "/out/$exe" --version
    $run "/out/$exe" --selftest
}

"$step"
