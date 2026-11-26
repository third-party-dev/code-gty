#!/bin/sh
# The launcher on a system without WebKitGTK, or the wrong one for its build.
#   deps.sh <gty command> cache|memory <pattern>...
#       exits 127, its message matches each pattern (grep), and it ran the
#       app from ~/.cache/gty/bin (cache) or from memory (memory)
#   deps.sh <gty command> wrong <pattern>...
#       exits 1 with a message matching each pattern
set -u
cmd=$1 mode=$2
shift 2
out=$("$cmd" 2>&1); code=$?
printf '%s\nexit %s\n' "$out" "$code"
fail() { echo "FAIL ($cmd, $mode): $*"; exit 1; }
want=127
[ "$mode" = wrong ] && want=1
[ "$code" = "$want" ] || fail "exit $code, not $want"
for pattern in "$@"; do
    printf '%s\n' "$out" | grep -q -- "$pattern" || fail "no '$pattern' in the message"
done
case $mode in
    cache) ls "$HOME"/.cache/gty/bin/gty-* >/dev/null 2>&1 || fail "nothing unpacked into ~/.cache/gty/bin" ;;
    memory) [ ! -e "$HOME/.cache/gty/bin" ] || fail "unpacked into ~/.cache/gty/bin instead of running from memory" ;;
esac
echo "ok ($cmd, $mode)"
