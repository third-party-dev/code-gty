#!/bin/sh
# The launcher on a system without WebKitGTK: it lists the missing libraries
# and the install commands, and exits 127. $1: "cache" or "memory", the way
# it is expected to run the app.
set -u
out=$(gty 2>&1); code=$?
printf '%s\nexit %s\n' "$out" "$code"
fail() { echo "FAIL: $*"; exit 1; }
[ "$code" = 127 ] || fail "exit $code, not 127"
for want in 'libwebkit2gtk-4.1.so.0' 'sudo apt install.* libwebkit2gtk-4.1-0' 'sudo dnf install.* webkit2gtk4.1' \
            'sudo pacman -S --needed.* webkit2gtk-4.1' 'sudo zypper install.* libwebkit2gtk-4_1-0'; do
    printf '%s\n' "$out" | grep -q -- "$want" || fail "no '$want' in the message"
done
case $1 in
    cache) ls "$HOME"/.cache/gty/bin/gty-* >/dev/null 2>&1 || fail "nothing unpacked into ~/.cache/gty/bin" ;;
    memory) [ ! -e "$HOME/.cache/gty/bin" ] || fail "unpacked into ~/.cache/gty/bin instead of running from memory" ;;
esac
echo "ok ($1)"
