# Third-party notices

code-gty bundles the following software.

## libghostty-vt 1.0.2 (media/ghostty-vt.wasm)

https://ghostty.org — Ghostty's terminal emulation library, built from the release source tarball for wasm32-wasi by `vt-wasm/build.sh`, with the two patches in `vt-wasm/patches` (MIT, like the library).

```
MIT License

Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Linked into the module, per the release's `deps/libghostty-vt-third-party.json`:

| Component | Version | Licence |
| --- | --- | --- |
| uucode (Unicode data) | 0.2.0 | MIT AND Unicode-3.0 |
| wuffs | 0.4.0-alpha.10 | Apache-2.0 OR MIT |
| simdutf | 9.0.0 | Apache-2.0 OR MIT |
| highway | 1.2.0 | Apache-2.0 OR BSD-3-Clause |
| translate_c | 2.0.0 | MIT |

Zig's standard library and compiler-rt (MIT) are also compiled in.

## Rust crates in bin/gty-sidecar

portable-pty, serde, serde_json, libc, image (with its png, zune-jpeg, gif, image-webp, tiff and qoi decoders) and flate2, and their dependencies, under MIT, Apache-2.0, Zlib and BSD licences. `cargo deny check licenses` (Docker target `sidecar-audit`) enforces the allowed list in sidecar/deny.toml.

## IosevkaTerm Nerd Font Mono 3.4.0 (media/fonts/IosevkaTermNerdFontMono-*.woff2)

Iosevka by Renzhi Li (https://github.com/be5invis/iosevka), patched with the Nerd Fonts icons by Nerd Fonts (https://github.com/ryanoasis/nerd-fonts). `IosevkaTermNerdFontMono-{Regular,Bold,Italic,BoldItalic}.ttf` from the v3.4.0 `IosevkaTerm.zip`, complete and unmodified apart from lossless conversion to WOFF2 by `scripts/build-fonts.sh`.

- Iosevka: Copyright (c) 2015-2023, Renzhi Li. SIL Open Font License, Version 1.1, with no Reserved Font Name. Full licence in `media/fonts/IosevkaTerm-LICENSE.md`.
- Nerd Fonts: patched fonts are licensed under the SIL Open Font License, Version 1.1; the Nerd Fonts `LICENSE` at v3.4.0 is in `media/fonts/NerdFonts-LICENSE.md`, and the licences of the individual icon sets are listed in https://github.com/ryanoasis/nerd-fonts/blob/v3.4.0/license-audit.md.
