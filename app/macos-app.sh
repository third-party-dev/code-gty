#!/bin/sh
# Wraps the macOS binary in an app bundle, so that it has a name, a Dock icon
# and a menu bar entry, and opens from Finder.
#   app/macos-app.sh <gty binary> <out: gty.app> [version]
# Works on Linux (the Docker cross build) and on macOS (GitHub Actions, which
# then signs the bundle). The version defaults to app/Cargo.toml's.
set -eu
bin=$1 app=$2
here=$(dirname -- "$0")
version=${3:-$(sed -n 's/^version = "\(.*\)"/\1/p' "$here/Cargo.toml" | head -n 1)}

rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$bin" "$app/Contents/MacOS/gty"
chmod 755 "$app/Contents/MacOS/gty"
cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>gty</string>
  <key>CFBundleDisplayName</key><string>gty</string>
  <key>CFBundleExecutable</key><string>gty</string>
  <key>CFBundleIdentifier</key><string>code-gty.gty</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict>
</plist>
EOF
echo "$app: gty $version"
