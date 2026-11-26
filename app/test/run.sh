#!/bin/sh
# End to end for the native app under Xvfb: the real binary, the real web
# view (WebKitGTK) and a real PTY. A test shell records what the page told
# the PTY (its size, from the window) and what was typed into the window.
set -eu
OUT=${OUT:-/tmp/out}
mkdir -p "$OUT"
export XDG_RUNTIME_DIR="$(mktemp -d)"
chmod 700 "$XDG_RUNTIME_DIR"
# Containers have no user namespaces for WebKit's sandbox, and no GPU.
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 WEBKIT_FORCE_SANDBOX=0
export LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_COMPOSITING_MODE=1
export NO_AT_BRIDGE=1

cat > /tmp/test-shell <<SH
#!/bin/sh
stty size > "$OUT/size"
echo "TERM_PROGRAM=\$TERM_PROGRAM TERM=\$TERM COLORTERM=\$COLORTERM CODE_GTY=\$CODE_GTY" > "$OUT/env"
printf '\033[1;31mhello\033[0m from \033[4mgty\033[0m: \033[38;2;80;200;120mtruecolor\033[0m \342\234\223 \356\202\240\n'
printf 'type here> '
read -r line
echo "\$line" > "$OUT/typed"
sleep 0.3
exit 0
SH
chmod +x /tmp/test-shell
export SHELL=/tmp/test-shell

wait_for() { # file, seconds
  i=0
  while [ ! -s "$1" ]; do
    i=$((i + 1))
    if [ "$i" -gt $(($2 * 10)) ]; then echo "timed out waiting for $1"; cat "$OUT/gty.log" || true; exit 1; fi
    sleep 0.1
  done
}

start=$(date +%s%N)
gty 2> "$OUT/gty.log" &
pid=$!
wait_for "$OUT/size" 60
echo "shell started after $(( ($(date +%s%N) - start) / 1000000 )) ms; PTY size: $(cat "$OUT/size")"
echo "environment: $(cat "$OUT/env")"
# Named gty in ps, though run from /proc/self/fd/N or /proc/self/exe.
echo "process names: app $(cat /proc/$pid/comm), daemon $(ps -o comm= -p "$(pgrep -f -- '--server' | head -1)")"
[ "$(cat /proc/$pid/comm)" = gty ]
[ "$(ps -o comm= -p "$(pgrep -f -- '--server' | head -1)")" = gty ]
sleep 1.5
import -window root "$OUT/screen.png"

wid=$(xdotool search --sync --name '^Ghostty' | head -1)
xdotool windowfocus --sync "$wid"
sleep 0.5
xdotool type --delay 30 'typed in the window'
xdotool key Return
wait_for "$OUT/typed" 20
echo "typed: $(cat "$OUT/typed")"
[ "$(cat "$OUT/typed")" = 'typed in the window' ]

# The shell exits 0, so the tab (and with it the app) closes.
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1)); [ "$i" -lt 100 ] || { echo "app did not quit after its shell exited"; cat "$OUT/gty.log"; exit 1; }
  sleep 0.1
done
wait "$pid"
rows=$(cut -d' ' -f1 "$OUT/size"); cols=$(cut -d' ' -f2 "$OUT/size")
[ "$rows" -gt 10 ] && [ "$cols" -gt 40 ]
grep -q 'TERM_PROGRAM=code-gty TERM=xterm-256color COLORTERM=truecolor CODE_GTY=1' "$OUT/env"
echo "--- app log"; cat "$OUT/gty.log"
# GLib and WebKit name things "gty", however the app was started.
[ -d "$HOME/.cache/gty" ] && ! ls -d "$HOME"/.cache/gty-* >/dev/null 2>&1 || { echo "WebKit cache not in ~/.cache/gty:"; ls -a "$HOME/.cache"; exit 1; }
echo "native app OK"
