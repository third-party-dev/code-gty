#!/bin/sh
# The launcher's viewer choice (PLAN-browser-support.md), with a stand-in
# browser (fake-browser) that the server must start and accept.
#   viewer.sh missing    WebKitGTK is not installed
#   viewer.sh present    WebKitGTK is installed
set -u
fail() { echo "FAIL: $*"; exit 1; }
install_fake() { # name
    rm -f /usr/local/bin/chromium /usr/local/bin/firefox /usr/local/bin/other-browser
    cp /test/fake-browser "/usr/local/bin/$1"
}
browser_run() { # what, then the command
    what=$1
    shift
    rm -f /tmp/fake-browser.args /tmp/fake-browser.status /tmp/fake-browser.page
    out=$("$@" 2>&1); code=$?
    printf '%s\nexit %s\n' "$out" "$code"
    [ "$code" = 0 ] || fail "$what: exit $code"
    [ -f /tmp/fake-browser.args ] || fail "$what: no browser was started"
    grep -q '101' /tmp/fake-browser.status || fail "$what: the server refused the page: $(cat /tmp/fake-browser.status)"
    # The page's files, from what the launcher carries: all there, in full.
    for f in / /app.js /ghostty-vt.wasm /fonts/IosevkaTermNerdFontMono-Regular.woff2; do
        grep -q "^$f 200 [1-9]" /tmp/fake-browser.page || fail "$what: $f not served: $(cat /tmp/fake-browser.page)"
    done
    [ "$(sed -n 's|^/ghostty-vt.wasm 200 ||p' /tmp/fake-browser.page)" -gt 100000 ] || fail "$what: the wasm is cut short"
}

case $1 in
    missing)
        # webview: only the message, with the hint.
        out=$(GTY_VIEWER=webview gty 2>&1); code=$?
        printf '%s\nexit %s\n' "$out" "$code"
        [ "$code" = 127 ] || fail "webview: exit $code, not 127"
        printf '%s\n' "$out" | grep -q 'gty --browser' || fail "webview: no --browser hint"

        # auto (the default): the message as a note, then the browser, in app mode.
        install_fake chromium
        browser_run auto gty
        printf '%s\n' "$out" | grep -q 'shows the terminal in a web browser' || fail "auto: no note"
        grep -q -- '--app=http://127.0.0.1:' /tmp/fake-browser.args || fail "auto: not in app mode"
        grep -q -- '--user-data-dir=' /tmp/fake-browser.args || fail "auto: no private profile"

        # Firefox: a new window with a private profile.
        install_fake firefox
        browser_run firefox gty --browser
        grep -q -- '-no-remote' /tmp/fake-browser.args || fail "firefox: no private instance"
        grep -q -- '--new-window' /tmp/fake-browser.args || fail "firefox: no new window"

        # A browser named in the settings: the address alone.
        install_fake other-browser
        mkdir -p "$HOME/.config/code-gty"
        printf '{ "gty.viewer": "browser", "gty.browser": "other-browser" }\n' > "$HOME/.config/code-gty/settings.json"
        browser_run settings gty
        grep -q '^http://127.0.0.1:' /tmp/fake-browser.args || fail "settings: not given the address"
        rm -f "$HOME/.config/code-gty/settings.json"

        # Browser mode from the cache (no memfd): it reads the page from the launcher too.
        install_fake chromium
        browser_run cache env GTY_NO_MEMFD=1 gty --browser

        # The page: a damaged launcher is caught, and the cached program
        # alone (without its launcher) says what to run.
        cp "$(command -v gty)" /tmp/gty-damaged
        size=$(wc -c < /tmp/gty-damaged)
        truncate -s $((size - 100)) /tmp/gty-damaged
        out=$(GTY_BROWSER_NO_LAUNCH=1 /tmp/gty-damaged --browser 2>&1); code=$?
        printf '%s\nexit %s\n' "$out" "$code"
        [ "$code" = 1 ] && printf '%s\n' "$out" | grep -q 'damaged' || fail "damaged: exit $code, not caught"
        rm -f /tmp/gty-damaged
        prog=$(ls "$HOME"/.cache/gty/bin/gty-browser-* | head -n 1)
        out=$(GTY_BROWSER_NO_LAUNCH=1 "$prog" 2>&1); code=$?
        printf '%s\nexit %s\n' "$out" "$code"
        [ "$code" = 1 ] && printf '%s\n' "$out" | grep -q "run that instead" || fail "without the launcher: exit $code"
        ;;
    present)
        # The app's window is the default; browser mode on request. (Runs
        # as an ordinary user: the Dockerfile installs the stand-in.)
        [ -x /usr/local/bin/chromium ] || fail "present: install fake-browser as /usr/local/bin/chromium first"
        browser_run "GTY_VIEWER=browser" env GTY_VIEWER=browser gty
        grep -q -- '--app=http://127.0.0.1:' /tmp/fake-browser.args || fail "browser: not in app mode"
        browser_run "--browser" gty --browser
        ;;
esac
[ "$1" = present ] || rm -f /usr/local/bin/chromium /usr/local/bin/firefox /usr/local/bin/other-browser
echo "ok (viewer, $1)"
