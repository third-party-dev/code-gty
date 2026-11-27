# syntax=docker/dockerfile:1.7
#
# code-gty: every build, test and packaging step runs here.
#
#   docker build --target dist --output type=local,dest=dist .        # VSIXes + SHA256SUMS
#   docker build --target ci .                                         # all container tests
#   docker build --target dist --build-arg SIDECAR_TARGETS=all ...     # every platform
#   docker build --target app-out --output type=local,dest=dist/app .  # the native app, every platform
#
# Releases are built by GitHub Actions (.github/workflows/), from these same
# stages, except macOS, which they build on macOS.
#
# Base images are pinned by digest; bump them deliberately.

ARG NODE_IMAGE=node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94
ARG RUST_IMAGE=rust:1.91.1-bookworm@sha256:c1e5f19e773b7878c3f7a805dd00a495e747acbdc76fb2337a4ebf0418896b33
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.56.1-noble@sha256:f1e7e01021efd65dd1a2c56064be399f3e4de00fd021ac561325f2bfbb2b837a
ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:e67eeead736ff7bbe258ef088bff683635c561b1fcfefad0806c1df4ab49ce0e
# cargo-zigbuild's own image: Rust, Zig and Apple's macOS SDK (SDKROOT), for
# the macOS app (development builds; releases are built on macOS by GitHub
# Actions, .github/workflows/build.yml).
ARG ZIGBUILD_IMAGE=ghcr.io/rust-cross/cargo-zigbuild:0.24.1@sha256:3abe26afb5537ea225c223c6790c1bf056271ef51ea52d2c4e343c569c8f129a
ARG ALPINE_IMAGE=alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f

# ---------------------------------------------------------------------------
# libghostty-vt WebAssembly module (vt-wasm/build.sh)
#   VT_SOURCE=build    wasm32-wasi from source with Zig 0.17 (default; Kitty graphics)
#   VT_SOURCE=release  the official signed wasm32-freestanding module (no images)
# The build is reproducible; VT_WASM_SHA256 pins the result of the default.
# ---------------------------------------------------------------------------
FROM ${DEBIAN_IMAGE} AS vt-wasm
ARG VT_VERSION=1.0.2
ARG VT_SOURCE=build
ARG VT_WASM_SHA256=4715aa24a337667cdd2f915616c1877aca345ab6d7b8987fc868c8d3ade00575
ARG ZIG17_VERSION=0.17.0
ARG ZIG17_SHA256_X86_64=1cbe9df9f27e6b78d14ccbca43b6703a404ef79ef1c463de901d7f088d4e2026
ARG ZIG17_SHA256_AARCH64=9e8d11661d4ae3bd57702a3832781e23ad151dde5798e16a5ccd503f65234ff8
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl minisign patch xz-utils && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    if [ "$VT_SOURCE" = build ]; then \
      arch="$(uname -m)"; \
      case "$arch" in x86_64) sum="$ZIG17_SHA256_X86_64";; aarch64) sum="$ZIG17_SHA256_AARCH64";; *) echo "unsupported $arch"; exit 1;; esac; \
      curl -fsSLo /tmp/zig.tar.xz "https://ziglang.org/download/${ZIG17_VERSION}/zig-${arch}-linux-${ZIG17_VERSION}.tar.xz"; \
      echo "${sum}  /tmp/zig.tar.xz" | sha256sum -c -; \
      mkdir -p /opt/zig17 && tar -xJf /tmp/zig.tar.xz -C /opt/zig17 --strip-components=1 && rm /tmp/zig.tar.xz; \
    fi
COPY vt-wasm/ /vt-wasm/
RUN set -eux; \
    ZIG=/opt/zig17/zig VT_VERSION="$VT_VERSION" VT_SOURCE="$VT_SOURCE" WORK=/tmp/vt /vt-wasm/build.sh /out; \
    if [ "$VT_SOURCE" = build ] && [ "$VT_VERSION" = 1.0.2 ]; then echo "${VT_WASM_SHA256}  /out/ghostty-vt.wasm" | sha256sum -c -; fi; \
    rm -rf /tmp/vt

# docker build --target vt-wasm-out --output type=local,dest=extension/media .
FROM scratch AS vt-wasm-out
COPY --from=vt-wasm /out/ghostty-vt.wasm /

# ---------------------------------------------------------------------------
# Extension host + webview (TypeScript)
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS node-deps
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
WORKDIR /src/extension
COPY extension/package.json extension/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM node-deps AS webview
ARG SOURCE_DATE_EPOCH=0
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}
COPY extension/ ./
COPY --from=vt-wasm /out/ghostty-vt.wasm media/ghostty-vt.wasm
# The bindings' generated layout must describe exactly this module.
RUN node scripts/gen-vt-layout.mjs --check media/ghostty-vt.wasm \
 && npm run typecheck \
 && npm run lint \
 && npm run test:unit \
 && NODE_ENV=production node scripts/build.mjs \
 && rm -f media/*.map dist/*.map

# ---------------------------------------------------------------------------
# Sidecar (Rust), cross-compiled with Zig
# ---------------------------------------------------------------------------
FROM ${RUST_IMAGE} AS rust-base
ARG ZIG_VERSION=0.13.0
ARG ZIG_SHA256_X86_64=d45312e61ebcc48032b77bc4cf7fd6915c11fa16e4aad116b66c9468211230ea
ARG ZIG_SHA256_AARCH64=041ac42323837eb5624068acd8b00cd5777dac4cf91179e8dad7a7e90dd0c556
ARG CARGO_ZIGBUILD_VERSION=0.24.1
RUN set -eux; \
    arch="$(uname -m)"; \
    case "$arch" in x86_64) sum="$ZIG_SHA256_X86_64";; aarch64) sum="$ZIG_SHA256_AARCH64";; *) echo "unsupported $arch"; exit 1;; esac; \
    curl -fsSLo /tmp/zig.tar.xz "https://ziglang.org/download/${ZIG_VERSION}/zig-linux-${arch}-${ZIG_VERSION}.tar.xz"; \
    echo "${sum}  /tmp/zig.tar.xz" | sha256sum -c -; \
    mkdir -p /opt/zig && tar -xJf /tmp/zig.tar.xz -C /opt/zig --strip-components=1 && rm /tmp/zig.tar.xz; \
    ln -s /opt/zig/zig /usr/local/bin/zig; zig version
RUN --mount=type=cache,id=cargo-rust-base,sharing=locked,target=/usr/local/cargo/registry \
    cargo install --locked cargo-zigbuild --version ${CARGO_ZIGBUILD_VERSION} \
 && rustup component add clippy \
 && rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl \
      x86_64-apple-darwin aarch64-apple-darwin \
      x86_64-pc-windows-gnu aarch64-pc-windows-gnullvm

FROM rust-base AS sidecar-src
WORKDIR /src/sidecar
COPY sidecar/Cargo.toml sidecar/Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && touch src/lib.rs \
 && cargo fetch --locked && rm -rf src
COPY sidecar/ ./

FROM sidecar-src AS sidecar-check
RUN cargo clippy --locked --all-targets -- -D warnings \
 && cargo clippy --locked --all-targets --features native -- -D warnings \
 && cargo test --locked \
 && cargo test --locked --features native \
 && touch /sidecar-checked

# Supply-chain audit (licences, advisories, sources). Fetches the advisory
# database, so it is its own target: docker build --target sidecar-audit .
FROM sidecar-src AS sidecar-audit
ARG CARGO_DENY_VERSION=0.20.2
RUN cargo install --locked cargo-deny --version ${CARGO_DENY_VERSION} \
 && cargo deny --locked check \
 && touch /sidecar-audited

FROM sidecar-check AS sidecar-build
# "linux" (default) builds the two static musl binaries; "all" adds macOS and Windows.
ARG SIDECAR_TARGETS=linux
ARG SOURCE_DATE_EPOCH=0
ARG BUILD_ID=0.1.0
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH} GTY_BUILD_ID=${BUILD_ID} \
    CARGO_INCREMENTAL=0 \
    RUSTFLAGS="--remap-path-prefix=/src/sidecar=. --remap-path-prefix=/usr/local/cargo=cargo"
RUN set -eux; \
    linux="x86_64-unknown-linux-musl:linux-x64,alpine-x64 aarch64-unknown-linux-musl:linux-arm64,alpine-arm64"; \
    other="x86_64-apple-darwin:darwin-x64 aarch64-apple-darwin:darwin-arm64 x86_64-pc-windows-gnu:win32-x64 aarch64-pc-windows-gnullvm:win32-arm64"; \
    case "$SIDECAR_TARGETS" in linux) list="$linux";; all) list="$linux $other";; *) list="$SIDECAR_TARGETS";; esac; \
    for pair in $list; do \
      triple="${pair%%:*}"; vsce="${pair#*:}"; \
      cargo zigbuild --locked --release --target "$triple"; \
      exe=gty-sidecar; case "$triple" in *windows*) exe=gty-sidecar.exe;; esac; \
      for t in $(echo "$vsce" | tr ',' ' '); do \
        mkdir -p "/out/$t"; cp "target/$triple/release/$exe" "/out/$t/$exe"; \
        (cd "/out/$t" && sha256sum "$exe" | cut -d' ' -f1 > "$exe.sha256"); \
      done; \
    done; \
    find /out -type f | sort

# ---------------------------------------------------------------------------
# Native app (app/): the terminal page in the system web view, linked with
# the sidecar, for VS Code's platforms except macOS (which needs Apple's
# SDK). Linux and Alpine builds link WebKitGTK 4.1 (a system library at run
# time) and are each packed into one file, gty-<platform>: the launcher
# script (app/gty.sh) with the app appended, which runs it from memory after
# checking for the libraries. Windows builds are gty-win32-<arch>.exe
# (WebView2 is part of Windows).
#   docker build --target app-out --output type=local,dest=dist/app .
# ---------------------------------------------------------------------------
# Each Rust stage has its own Cargo registry cache (id=...): builds that run
# at once must not share one, because Cargo's lock is outside the mount, so
# two of them unpacking the same crate collide ("File exists").
FROM scratch AS app-src
COPY sidecar/ /src/sidecar/
COPY app/Cargo.toml app/Cargo.lock app/build.rs /src/app/
COPY app/src /src/app/src
COPY app/gty.sh app/pack.sh app/pe-imports.py app/macho-info.py app/macos-app.sh /src/app/
COPY app/browser/Cargo.toml app/browser/Cargo.lock /src/app/browser/
COPY app/browser/src /src/app/browser/src
COPY extension/shell-integration /src/extension/shell-integration
COPY --from=webview /src/extension/media /src/extension/media
COPY --from=webview /src/app/assets /src/app/assets

# Browser mode for Linux (app/browser/): the terminal page in a web browser,
# for systems without WebKitGTK. Static (musl, with Zig, as the sidecar), so
# it links nothing from the system; packed into each Linux file beside the
# app (app/pack.sh), which also carries the page once for both (the
# page-payload feature: neither binary has it built in).
FROM rust-base AS app-browser-static
RUN rustup target add armv7-unknown-linux-musleabihf
ARG BUILD_ID=0.1.0
ENV GTY_BUILD_ID=${BUILD_ID} CARGO_INCREMENTAL=0 \
    RUSTFLAGS="--remap-path-prefix=/src=. --remap-path-prefix=/usr/local/cargo=cargo"
COPY --from=app-src /src /src
WORKDIR /src/app/browser
RUN --mount=type=cache,id=cargo-app-browser,sharing=locked,target=/usr/local/cargo/registry \
    cargo clippy --locked --release -- -D warnings \
 && cargo clippy --locked --release --features page-payload -- -D warnings \
 && mkdir -p /out \
 && for pair in x86_64-unknown-linux-musl:x64 aarch64-unknown-linux-musl:arm64 armv7-unknown-linux-musleabihf:armhf; do \
      t=${pair%%:*}; a=${pair#*:}; \
      cargo zigbuild --locked --release --features page-payload --target "$t" && cp "target/$t/release/gty-browser" "/out/gty-browser-$a" || exit 1; \
      if readelf -l "/out/gty-browser-$a" | grep -q 'program interpreter'; then echo "gty-browser-$a is not static"; exit 1; fi; \
    done \
 && rm -rf target \
 && /out/gty-browser-x64 --version && /out/gty-browser-x64 --selftest && ls -l /out

# linux-x64: native, with clippy.
FROM ${RUST_IMAGE} AS app-build
RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev \
 && rm -rf /var/lib/apt/lists/* \
 && rustup component add clippy
ARG BUILD_ID=0.1.0
ENV GTY_BUILD_ID=${BUILD_ID} CARGO_INCREMENTAL=0 \
    RUSTFLAGS="--remap-path-prefix=/src=. --remap-path-prefix=/usr/local/cargo=cargo"
COPY --from=app-src /src /src
COPY --from=app-browser-static /out/gty-browser-x64 /browser/
WORKDIR /src/app
RUN --mount=type=cache,id=cargo-app-linux-x64,sharing=locked,target=/usr/local/cargo/registry \
    sh -n gty.sh \
 && cargo clippy --locked --release -- -D warnings \
 && cargo clippy --locked --release --features page-payload -- -D warnings \
 && cargo build --locked --release --features page-payload \
 && mkdir -p /out && cp target/release/gty /out/gty && rm -rf target \
 && ldd /out/gty | grep -E 'webkit|gtk|soup|javascriptcore' \
 && ./pack.sh /out/gty /out/gty-linux-x64 linux-x64 /browser/gty-browser-x64 && ls -l /out

# linux-arm64, linux-armhf: Debian multiarch WebKitGTK and a cross gcc.
FROM ${RUST_IMAGE} AS app-cross-debian
COPY app/cross.sh /usr/local/bin/
ARG BUILD_ID=0.1.0
ENV GTY_BUILD_ID=${BUILD_ID} CARGO_INCREMENTAL=0 \
    RUSTFLAGS="--remap-path-prefix=/src=. --remap-path-prefix=/usr/local/cargo=cargo"

FROM app-cross-debian AS app-linux-arm64
RUN cross.sh linux-arm64 setup
COPY --from=app-src /src /src
COPY --from=app-browser-static /out/gty-browser-arm64 /browser/
RUN --mount=type=cache,id=cargo-app-linux-arm64,sharing=locked,target=/usr/local/cargo/registry \
    cross.sh linux-arm64 build && qemu-aarch64 /browser/gty-browser-arm64 --selftest \
 && /src/app/pack.sh /out/gty /out/gty-linux-arm64 linux-arm64 /browser/gty-browser-arm64

FROM app-cross-debian AS app-linux-armhf
RUN cross.sh linux-armhf setup
COPY --from=app-src /src /src
COPY --from=app-browser-static /out/gty-browser-armhf /browser/
RUN --mount=type=cache,id=cargo-app-linux-armhf,sharing=locked,target=/usr/local/cargo/registry \
    cross.sh linux-armhf build && qemu-arm /browser/gty-browser-armhf --selftest \
 && /src/app/pack.sh /out/gty /out/gty-linux-armhf linux-armhf /browser/gty-browser-armhf

# alpine-x64 (native), alpine-arm64 (an aarch64 Alpine sysroot and clang).
FROM ${ALPINE_IMAGE} AS app-cross-alpine
ARG RUST_VERSION=1.91.1
RUN apk add --no-cache build-base binutils gzip pkgconf clang lld qemu-aarch64 rustup \
      webkit2gtk-4.1-dev gtk+3.0-dev libsoup3-dev \
 && rustup-init -y --profile minimal --default-toolchain ${RUST_VERSION}
ENV PATH=/root/.cargo/bin:$PATH
COPY app/cross.sh /usr/local/bin/
ARG BUILD_ID=0.1.0
ENV GTY_BUILD_ID=${BUILD_ID} CARGO_INCREMENTAL=0 \
    RUSTFLAGS="--remap-path-prefix=/src=. --remap-path-prefix=/root/.cargo=cargo"

FROM app-cross-alpine AS app-alpine-x64
RUN cross.sh alpine-x64 setup
COPY --from=app-src /src /src
COPY --from=app-browser-static /out/gty-browser-x64 /browser/
RUN --mount=type=cache,id=cargo-app-alpine-x64,sharing=locked,target=/root/.cargo/registry \
    cross.sh alpine-x64 build && /browser/gty-browser-x64 --selftest \
 && /src/app/pack.sh /out/gty /out/gty-alpine-x64 alpine-x64 /browser/gty-browser-x64

FROM app-cross-alpine AS app-alpine-arm64
RUN cross.sh alpine-arm64 setup
COPY --from=app-src /src /src
COPY --from=app-browser-static /out/gty-browser-arm64 /browser/
RUN --mount=type=cache,id=cargo-app-alpine-arm64,sharing=locked,target=/root/.cargo/registry \
    cross.sh alpine-arm64 build && qemu-aarch64 /browser/gty-browser-arm64 --selftest \
 && /src/app/pack.sh /out/gty /out/gty-alpine-arm64 alpine-arm64 /browser/gty-browser-arm64

# win32-x64, win32-arm64: Zig, as the sidecar.
FROM rust-base AS app-win32
COPY app/cross.sh /usr/local/bin/
ARG BUILD_ID=0.1.0
ENV GTY_BUILD_ID=${BUILD_ID} CARGO_INCREMENTAL=0 \
    RUSTFLAGS="--remap-path-prefix=/src=. --remap-path-prefix=/usr/local/cargo=cargo"
COPY --from=app-src /src /src
RUN --mount=type=cache,id=cargo-app-win32,sharing=locked,target=/usr/local/cargo/registry \
    cross.sh win32-x64 build && mv /out/gty.exe /out/gty-win32-x64.exe \
 && cross.sh win32-arm64 build && mv /out/gty.exe /out/gty-win32-arm64.exe

# darwin-x64, darwin-arm64: Zig and Apple's SDK from the cargo-zigbuild image,
# with the same Rust as the other builds. Each is the binary and a zipped
# gty.app, signed ad hoc (by Zig's linker); not notarized.
FROM ${ZIGBUILD_IMAGE} AS app-darwin
ARG RUST_VERSION=1.91.1
RUN rustup toolchain install ${RUST_VERSION} --profile minimal --component clippy \
      --target x86_64-apple-darwin --target aarch64-apple-darwin \
 && rustup default ${RUST_VERSION} \
 && (command -v python3 || (apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*))
COPY app/cross.sh /usr/local/bin/
ARG BUILD_ID=0.1.0
ENV GTY_BUILD_ID=${BUILD_ID} CARGO_INCREMENTAL=0 \
    RUSTFLAGS="--remap-path-prefix=/src=. --remap-path-prefix=/usr/local/cargo=cargo"
COPY --from=app-src /src /src
RUN --mount=type=cache,id=cargo-app-darwin,sharing=locked,target=/usr/local/cargo/registry \
    for a in x64 arm64; do \
      cross.sh darwin-$a build && mv /out/gty /out/gty-darwin-$a && mv /out/gty.app.zip /out/gty-darwin-$a.app.zip || exit 1; \
    done; ls -l /out

# Linux and Windows (GitHub Actions builds macOS on macOS).
FROM ${DEBIAN_IMAGE} AS app-pack-linux-windows
COPY --from=app-build /out/gty-linux-x64 /out/
COPY --from=app-linux-arm64 /out/gty-linux-arm64 /out/
COPY --from=app-linux-armhf /out/gty-linux-armhf /out/
COPY --from=app-alpine-x64 /out/gty-alpine-x64 /out/
COPY --from=app-alpine-arm64 /out/gty-alpine-arm64 /out/
COPY --from=app-win32 /out/gty-win32-x64.exe /out/gty-win32-arm64.exe /out/
RUN cd /out && sha256sum gty-* > SHA256SUMS && ls -l && cat SHA256SUMS

FROM scratch AS app-out-linux-windows
COPY --from=app-pack-linux-windows /out/ /

# Everything, macOS (cross-built with Apple's SDK) included: for development.
FROM app-pack-linux-windows AS app-pack
COPY --from=app-darwin /out/gty-darwin-x64 /out/gty-darwin-x64.app.zip /out/gty-darwin-arm64 /out/gty-darwin-arm64.app.zip /out/
RUN cd /out && sha256sum gty-* > SHA256SUMS && ls -l && cat SHA256SUMS

FROM scratch AS app-out
COPY --from=app-pack /out/ /

# The page the app embeds (extension/media and app/assets), for building the
# app outside Docker (the macOS job in .github/workflows/build.yml).
FROM scratch AS app-page-out
COPY --from=webview /src/extension/media /extension/media
COPY --from=webview /src/app/assets /app/assets

# The launcher where WebKitGTK is missing: it names the packages and exits
# 127, both from the cache (no Python) and from memory; and it says which
# build to use on the wrong C library or machine.
FROM ${DEBIAN_IMAGE} AS test-app-deps
COPY --from=app-build /out/gty-linux-x64 /usr/local/bin/gty
COPY --from=app-alpine-x64 /out/gty-alpine-x64 /usr/local/bin/
COPY --from=app-linux-arm64 /out/gty-linux-arm64 /usr/local/bin/
COPY app/test/deps.sh app/test/viewer.sh app/test/fake-browser /test/
RUN set -e; debian='libwebkit2gtk-4.1.so.0'; \
    /test/deps.sh gty cache "$debian" 'sudo apt install.* libwebkit2gtk-4.1-0' 'sudo dnf install.* webkit2gtk4.1' \
      'sudo pacman -S --needed.* webkit2gtk-4.1' 'sudo zypper install.* libwebkit2gtk-4_1-0'; \
    apt-get update && apt-get install -y --no-install-recommends python3-minimal && rm -rf /var/lib/apt/lists/*; \
    rm -rf "$HOME/.cache/gty"; \
    /test/deps.sh gty memory "$debian" 'sudo apt install.* libwebkit2gtk-4.1-0'; \
    /test/deps.sh gty-alpine-x64 wrong 'for Alpine and other musl systems.*needs gty-linux-x64'; \
    /test/deps.sh gty-linux-arm64 wrong 'for aarch64 machines, and this one is x86_64'; \
    /test/viewer.sh missing; \
    touch /tmp/app-deps-ok

FROM ${ALPINE_IMAGE} AS test-app-deps-alpine
COPY --from=app-alpine-x64 /out/gty-alpine-x64 /usr/local/bin/gty
COPY --from=app-build /out/gty-linux-x64 /usr/local/bin/
COPY app/test/deps.sh app/test/viewer.sh app/test/fake-browser /test/
RUN set -e; \
    /test/deps.sh gty cache 'libwebkit2gtk-4.1.so.0' 'apk add.* webkit2gtk-4.1'; \
    apk add --no-cache python3; rm -rf "$HOME/.cache/gty"; \
    /test/deps.sh gty memory 'libwebkit2gtk-4.1.so.0' 'apk add.* webkit2gtk-4.1'; \
    /test/deps.sh gty-linux-x64 wrong 'for glibc systems; this one uses musl (Alpine), so it needs gty-alpine-x64'; \
    /test/viewer.sh missing; \
    touch /tmp/app-deps-alpine-ok

# The real app under Xvfb: page, web view, bridge, daemon and a PTY. Run
# from memory, then from the cache.
FROM ${DEBIAN_IMAGE} AS test-app
RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-0 python3-minimal xvfb xauth xdotool xclip imagemagick fonts-dejavu-core procps \
 && rm -rf /var/lib/apt/lists/*
COPY --from=app-build /out/gty-linux-x64 /usr/local/bin/gty
COPY app/test/run.sh app/test/viewer.sh /test/
COPY app/test/fake-browser /usr/local/bin/chromium
RUN useradd -m tester
USER tester
RUN OUT=/tmp/out xvfb-run -a -s "-screen 0 1280x800x24" /test/run.sh \
 && test ! -e "$HOME/.cache/gty/bin" \
 && OUT=/tmp/out-cache GTY_NO_MEMFD=1 xvfb-run -a -s "-screen 0 1280x800x24" /test/run.sh \
 && ls "$HOME"/.cache/gty/bin/gty-* \
 && /test/viewer.sh present \
 && touch /tmp/app-ok

# The same on Alpine, with the musl build.
FROM ${ALPINE_IMAGE} AS test-app-alpine
RUN apk add --no-cache webkit2gtk-4.1 python3 xvfb-run xdotool xclip imagemagick font-dejavu procps-ng coreutils
COPY --from=app-alpine-x64 /out/gty-alpine-x64 /usr/local/bin/gty
COPY app/test/run.sh app/test/viewer.sh /test/
COPY app/test/fake-browser /usr/local/bin/chromium
RUN adduser -D tester
USER tester
RUN OUT=/tmp/out xvfb-run -a -s "-screen 0 1280x800x24" /test/run.sh \
 && test ! -e "$HOME/.cache/gty/bin" \
 && OUT=/tmp/out-cache GTY_NO_MEMFD=1 xvfb-run -a -s "-screen 0 1280x800x24" /test/run.sh \
 && ls "$HOME"/.cache/gty/bin/gty-* \
 && /test/viewer.sh present \
 && touch /tmp/app-alpine-ok

# Browser mode end to end: the Linux launcher (gty-linux-x64, browser mode:
# the static gty-browser, with the page the launcher carries) serves the
# real page to real Chromium and Firefox (extension/test/browser/), with a real daemon
# and PTY: typing, a reload that reattaches, the request checks against
# another origin, and ending with the page.
FROM ${PLAYWRIGHT_IMAGE} AS test-browser-mode
WORKDIR /src/extension
COPY --from=webview /src/extension ./
COPY --from=app-build /out/gty-linux-x64 /usr/local/bin/gty
ENV GTY_BROWSER_BIN=/usr/local/bin/gty GTY_VIEWER=browser
# Chromium with the launcher running browser mode from memory, Firefox from
# its cache (each reads the page from the launcher).
RUN GTY_BROWSER=chromium npm run test:browser-mode \
 && GTY_BROWSER=firefox GTY_NO_MEMFD=1 npm run test:browser-mode \
 && touch /browser-mode-ok

FROM scratch AS test-app-out
COPY --from=test-app /tmp/out /

# Dev container image (.devcontainer): the Rust/Zig builder plus Node.
FROM rust-base AS dev
COPY --from=node-deps /usr/local/bin/node /usr/local/bin/node
COPY --from=node-deps /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && apt-get update && apt-get install -y --no-install-recommends zsh fish && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Packaging: one VSIX per target platform, each with only its own binary.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS package
ARG SOURCE_DATE_EPOCH=0
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}
RUN apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/*
COPY --from=webview /src/extension /src/extension
COPY --from=sidecar-build /out /sidecars
WORKDIR /src/extension
RUN set -eux; \
    version="$(node -p 'require("./package.json").version')"; \
    mkdir -p /dist; \
    for dir in /sidecars/*; do \
      t="$(basename "$dir")"; \
      rm -rf bin && mkdir bin && cp "$dir"/* bin/ && chmod 755 bin/gty-sidecar* ; \
      find . -path ./node_modules -prune -o -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} + ; \
      npx vsce package --no-dependencies --target "$t" --out "/dist/code-gty-$t-$version.vsix"; \
      unzip -l "/dist/code-gty-$t-$version.vsix"; \
      n="$(unzip -Z1 "/dist/code-gty-$t-$version.vsix" | grep -c '^extension/bin/gty-sidecar\(\.exe\)\?$')"; \
      test "$n" = 1; \
      ! unzip -Z1 "/dist/code-gty-$t-$version.vsix" | grep -E '\.map$|^extension/(src|test|webview|node_modules)/'; \
    done; \
    cd /dist && sha256sum *.vsix > SHA256SUMS && cat SHA256SUMS

FROM scratch AS dist
COPY --from=package /dist/ /

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

# Protocol conformance and shell integration against the real Linux binary.
FROM node-deps AS test-conformance
RUN apt-get update && apt-get install -y --no-install-recommends bash zsh fish procps python3 && rm -rf /var/lib/apt/lists/*
COPY extension/ ./
COPY test.py /src/test.py
COPY --from=vt-wasm /out/ghostty-vt.wasm media/ghostty-vt.wasm
COPY --from=sidecar-build /out/linux-x64/gty-sidecar /usr/local/bin/gty-sidecar
ENV GTY_SIDECAR=/usr/local/bin/gty-sidecar
RUN useradd -m tester && chown -R tester /src
USER tester
RUN npm run test:conformance && touch /tmp/conformance-ok

# The static musl binary must run on glibc and musl distributions alike.
FROM ${DEBIAN_IMAGE} AS test-portability-debian
COPY --from=sidecar-build /out/linux-x64/gty-sidecar /usr/local/bin/
RUN gty-sidecar --version && gty-sidecar --selftest && touch /portability-debian-ok

FROM ${ALPINE_IMAGE} AS test-portability-alpine
COPY --from=sidecar-build /out/alpine-x64/gty-sidecar /usr/local/bin/
RUN gty-sidecar --version && gty-sidecar --selftest && touch /portability-alpine-ok

# Webview in headless Chromium against a mock host.
# Webview (gty-term) in Chromium, Firefox and WebKit against a mock host.
FROM ${PLAYWRIGHT_IMAGE} AS test-webview
WORKDIR /src/extension
COPY --from=webview /src/extension ./
RUN GTY_BROWSER=chromium npm run test:webview \
 && GTY_BROWSER=firefox npm run test:webview \
 && GTY_BROWSER=webkit npm run test:webview \
 && touch /webview-ok

# Desktop integration: real VS Code under Xvfb. Downloads the pinned VS Code
# build, so it needs network at build time.
FROM ${PLAYWRIGHT_IMAGE} AS test-integration
ARG VSCODE_TEST_VERSION=1.90.0
ENV VSCODE_TEST_VERSION=${VSCODE_TEST_VERSION}
RUN apt-get update && apt-get install -y --no-install-recommends bash xvfb xauth libsecret-1-0 && rm -rf /var/lib/apt/lists/*
WORKDIR /src/extension
COPY --from=webview /src/extension ./
COPY --from=sidecar-build /out/linux-x64/ ./bin/
RUN useradd -m tester && chown -R tester /src
USER tester
RUN xvfb-run -a npm run test:integration && touch /tmp/integration-ok

# Browser end to end against code-server; runs as a compose service because
# it needs the server alongside: docker compose run --rm e2e
FROM ${PLAYWRIGHT_IMAGE} AS test-e2e
WORKDIR /src/extension
COPY --from=webview /src/extension ./
CMD ["npm", "run", "test:e2e"]

FROM scratch AS ci
COPY --from=sidecar-check /sidecar-checked /ok/
COPY --from=test-conformance /tmp/conformance-ok /ok/
COPY --from=test-portability-debian /portability-debian-ok /ok/
COPY --from=test-portability-alpine /portability-alpine-ok /ok/
COPY --from=test-webview /webview-ok /ok/
COPY --from=test-integration /tmp/integration-ok /ok/
COPY --from=test-app /tmp/app-ok /ok/
COPY --from=test-app-deps /tmp/app-deps-ok /ok/
COPY --from=test-app-deps-alpine /tmp/app-deps-alpine-ok /ok/
COPY --from=test-app-alpine /tmp/app-alpine-ok /ok/
COPY --from=test-browser-mode /browser-mode-ok /ok/
COPY --from=app-pack-linux-windows /out/SHA256SUMS /ok/app-SHA256SUMS
COPY --from=package /dist/SHA256SUMS /ok/

# ---------------------------------------------------------------------------
# Release: publishes to the Marketplace and Open VSX. Tokens are BuildKit
# secrets, never layers, and no test stage can see them.
#   docker build --target release --secret id=vsce_pat,env=VSCE_PAT --secret id=ovsx_pat,env=OVSX_PAT .
# ---------------------------------------------------------------------------
FROM node-deps AS release
ARG OVSX_VERSION=1.3.0
RUN npm install -g ovsx@${OVSX_VERSION}
COPY --from=package /dist /dist
RUN --mount=type=secret,id=vsce_pat,required=true \
    --mount=type=secret,id=ovsx_pat,required=true \
    set -eu; cd /dist; sha256sum -c SHA256SUMS; \
    for f in *.vsix; do \
      VSCE_PAT="$(cat /run/secrets/vsce_pat)" npx vsce publish --packagePath "$f"; \
      OVSX_PAT="$(cat /run/secrets/ovsx_pat)" ovsx publish "$f"; \
    done
