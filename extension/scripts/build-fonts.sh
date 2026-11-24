#!/bin/sh
# Rebuilds media/fonts/ from the pinned IosevkaTerm Nerd Font release. The
# output is committed; run this only to update or audit the fonts.
#
# The four IosevkaTermNerdFontMono styles are shipped complete: every glyph
# and table is kept, the Nerd Font icons included. The only change is lossless
# conversion from TTF to WOFF2.
#
# Needs curl, unzip, sha256sum and python3 (fonttools is installed into a
# throwaway virtualenv).
set -eu

NF_TAG=v3.4.0
IOSEVKA_SHA=d4010247459253898a160fc494c6671f523788f8562f23f599cf881b2e3ac241
NF_LICENSE_SHA=1f6ad4edae6479aaace3112ede5279a23284ae54b2a34db66357aef5f64df160

out=$(cd "$(dirname "$0")/../media/fonts" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

curl -fsSL -o "$work/IosevkaTerm.zip" "https://github.com/ryanoasis/nerd-fonts/releases/download/$NF_TAG/IosevkaTerm.zip"
echo "$IOSEVKA_SHA  $work/IosevkaTerm.zip" | sha256sum -c -
mkdir "$work/IosevkaTerm" && unzip -q "$work/IosevkaTerm.zip" -d "$work/IosevkaTerm"
curl -fsSL -o "$work/NerdFonts-LICENSE" "https://raw.githubusercontent.com/ryanoasis/nerd-fonts/$NF_TAG/LICENSE"
echo "$NF_LICENSE_SHA  $work/NerdFonts-LICENSE" | sha256sum -c -

python3 -m venv "$work/venv"
"$work/venv/bin/pip" install -q fonttools==4.68.0 brotli==1.2.1

for style in Regular Bold Italic BoldItalic; do
  "$work/venv/bin/python" -I -c '
import sys
from fontTools.ttLib import TTFont
src, dst = sys.argv[1:]
f = TTFont(src, recalcTimestamp=False)
f.flavor = "woff2"
f.save(dst)
a, b = TTFont(src), TTFont(dst)
assert a["maxp"].numGlyphs == b["maxp"].numGlyphs and a.getBestCmap() == b.getBestCmap() and sorted(a.keys()) == sorted(b.keys()), dst
' "$work/IosevkaTerm/IosevkaTermNerdFontMono-$style.ttf" "$out/IosevkaTermNerdFontMono-$style.woff2"
done

cp "$work/IosevkaTerm/LICENSE.md" "$out/IosevkaTerm-LICENSE.md"
cp "$work/NerdFonts-LICENSE" "$out/NerdFonts-LICENSE.md"

ls -l "$out"
