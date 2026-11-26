#!/bin/sh
# gty: code-gty's terminal as a desktop app, in one file. This script is
# followed by the app itself, gzipped (the build appends it after the last
# line). The script runs the app from memory: Python's os.memfd_create gives
# an anonymous in-memory file, which can be executed, so nothing is written
# to disk. Without Python 3.8+, or where the kernel does not allow executing
# memfds (vm.memfd_noexec=2), it unpacks the app once into ~/.cache/gty/bin
# instead and runs it from there.
#
# Before starting it, the script checks that the system libraries the app
# links against (WebKitGTK 4.1 and its GTK 3 stack) are installed, and if not,
# says which packages provide them. It does not try to work out which package
# manager this system uses; it lists the commands for the common ones.
#
#   gty [args...]        the app (or gty --version, gty --server ...)
#   GTY_SKIP_CHECK=1     skip the library check
#   GTY_NO_MEMFD=1       always run from ~/.cache/gty/bin

GTY_ARCH=@ARCH@
GTY_ID=@ID@
GTY_LINE=@LINE@

set -u

die() {
    printf 'gty: %s\n' "$*" >&2
    exit 1
}

# The packages that provide a library the app links against (directly or
# through another library): "apt|dnf|pacman|zypper".
packages() {
    case $1 in
        libwebkit2gtk-4.1.so.*) echo "libwebkit2gtk-4.1-0|webkit2gtk4.1|webkit2gtk-4.1|libwebkit2gtk-4_1-0" ;;
        libjavascriptcoregtk-4.1.so.*) echo "libjavascriptcoregtk-4.1-0|javascriptcoregtk4.1|webkit2gtk-4.1|libjavascriptcoregtk-4_1-0" ;;
        libsoup-3.0.so.*) echo "libsoup-3.0-0|libsoup3|libsoup3|libsoup-3_0-0" ;;
        libgtk-3.so.* | libgdk-3.so.*) echo "libgtk-3-0|gtk3|gtk3|libgtk-3-0" ;;
        libcairo.so.*) echo "libcairo2|cairo|cairo|libcairo2" ;;
        libgdk_pixbuf-2.0.so.*) echo "libgdk-pixbuf-2.0-0|gdk-pixbuf2|gdk-pixbuf2|libgdk_pixbuf-2_0-0" ;;
        libglib-2.0.so.*) echo "libglib2.0-0|glib2|glib2|libglib-2_0-0" ;;
        libgobject-2.0.so.*) echo "libglib2.0-0|glib2|glib2|libgobject-2_0-0" ;;
        libgio-2.0.so.*) echo "libglib2.0-0|glib2|glib2|libgio-2_0-0" ;;
        libdbus-1.so.*) echo "libdbus-1-3|dbus-libs|dbus|libdbus-1-3" ;;
        libgcc_s.so.*) echo "libgcc-s1|libgcc|gcc-libs|libgcc_s1" ;;
        *) echo "" ;;
    esac
}

# Reads ldd's output for the app ($1). Returns if nothing is missing;
# otherwise says what is and how to install it, and exits 127.
report() {
    out=$1
    case $out in
        *"not a dynamic executable"*) return 0 ;;
    esac
    missing=$(printf '%s\n' "$out" | sed -n 's/^[[:space:]]*\([^[:space:]]*\) => not found.*/\1/p' | sort -u)
    # e.g. "version `GLIBC_2.34' not found": the C library is older than the
    # one the app was built against, which no package install fixes.
    glibc=$(printf '%s\n' "$out" | sed -n "s/.*version [\`']GLIBC_\([0-9.]*\)' not found.*/\1/p" | sort -t. -k1,1n -k2,2n | tail -n 1)

    [ -z "$missing" ] && [ -z "$glibc" ] && return 0

    {
        if [ -n "$missing" ]; then
            echo "gty needs these libraries, which are not installed:"
            printf '%s\n' "$missing" | sed 's/^/    /'
        fi
        if [ -n "$glibc" ]; then
            echo "gty needs glibc $glibc or later, and this system's C library is older."
            echo "Installing packages will not fix that: it needs a newer distribution release"
            echo "(musl systems, such as Alpine, are not supported)."
        fi

        apt='' dnf='' pacman='' zypper='' unknown=''
        for lib in $missing; do
            row=$(packages "$lib")
            if [ -z "$row" ]; then
                unknown="$unknown $lib"
                continue
            fi
            IFS='|' read -r a d p z <<EOF
$row
EOF
            case " $apt " in *" $a "*) ;; *) apt="$apt $a" ;; esac
            case " $dnf " in *" $d "*) ;; *) dnf="$dnf $d" ;; esac
            case " $pacman " in *" $p "*) ;; *) pacman="$pacman $p" ;; esac
            case " $zypper " in *" $z "*) ;; *) zypper="$zypper $z" ;; esac
        done

        if [ -n "$apt" ]; then
            echo
            echo "Install them with your distribution's package manager:"
            echo "    Debian, Ubuntu, Mint:      sudo apt install$apt"
            echo "    Fedora, RHEL, CentOS:      sudo dnf install$dnf"
            echo "    Arch, Manjaro:             sudo pacman -S --needed$pacman"
            echo "    openSUSE:                  sudo zypper install$zypper"
        fi
        if [ -n "$unknown" ]; then
            echo
            echo "To find the package for the others:"
            for lib in $unknown; do
                echo "    $lib:"
                echo "        apt-file search $lib"
                echo "        dnf provides '*/$lib'"
                echo "        pacman -F $lib"
                echo "        zypper search --provides $lib"
            done
        fi
        echo
        echo "(Set GTY_SKIP_CHECK=1 to start gty without this check.)"
    } >&2
    exit 127
}


# Python could not start the app because libraries are missing.
if [ -n "${__GTY_LDD:-}" ]; then
    report "$__GTY_LDD"
    die "cannot start the app"
fi

[ "$(uname -m)" = "$GTY_ARCH" ] || die "this gty is for $GTY_ARCH, and this machine is $(uname -m)"

memfd=yes
[ -z "${GTY_NO_MEMFD:-}" ] || memfd=no
[ "$(cat /proc/sys/vm/memfd_noexec 2>/dev/null)" != 2 ] || memfd=no
python=$(command -v python3 2>/dev/null) || memfd=no
if [ $memfd = yes ]; then
    # The Python section at the end of this script (sed stops there, before the app).
    py=$(sed -n '/^#=python$/,/^#=end$/{p;/^#=end$/q;}' "$0")
    exec "$python" -I -c "$py" "$0" "$GTY_LINE" "$@"
fi

# From the cache: unpacked once per build, checked, and old builds removed.
cache=${XDG_CACHE_HOME:-${HOME:?}/.cache}/gty/bin
app=$cache/gty-$GTY_ID
if [ ! -x "$app" ]; then
    mkdir -p "$cache" && chmod 700 "$cache" || die "cannot create $cache"
    tmp=$app.tmp.$$
    command -v gzip >/dev/null 2>&1 || die "unpacking the app needs gzip (or Python 3.8+ to run it from memory)"
    tail -n +"$GTY_LINE" "$0" | gzip -dc > "$tmp" 2>/dev/null || { rm -f "$tmp"; die "this file is damaged (the embedded app does not unpack)"; }
    if command -v sha256sum >/dev/null 2>&1; then
        [ "$(sha256sum < "$tmp" | cut -d' ' -f1)" = "$GTY_ID" ] || { rm -f "$tmp"; die "this file is damaged (the embedded app does not match its checksum)"; }
    fi
    chmod 755 "$tmp" && mv -f "$tmp" "$app" || { rm -f "$tmp"; die "cannot write $app"; }
    for old in "$cache"/gty-*; do
        [ "$old" = "$app" ] || rm -f "$old"
    done
fi
if [ -z "${GTY_SKIP_CHECK:-}" ] && command -v ldd >/dev/null 2>&1; then
    report "$(LC_ALL=C ldd "$app" 2>&1)"
fi
exec "$app" "$@"

# Run from memory (Python 3.8+). The shell never gets here; it reads this
# section and hands it to python3 -c. argv: this script, GTY_LINE, the
# app's arguments. Anything that goes wrong before the app starts comes
# back to this script (exec, so no process waits in between): with __GTY_LDD
# set to report missing libraries, or with GTY_NO_MEMFD=1 to use the cache.
: <<'#=end'
#=python
# Only os, sys and zlib: Debian's python3-minimal (what is there when
# nothing else needs Python) has no shutil or subprocess.
import os, sys

script, line, args = sys.argv[1], int(sys.argv[2]), sys.argv[3:]

def back(**env):
    os.execve("/bin/sh", ["sh", script] + args, dict(os.environ, **env))

def fallback(why):
    sys.stderr.write("gty: cannot run from memory (%s); using ~/.cache/gty/bin\n" % why)
    back(GTY_NO_MEMFD="1")

def ldd(target):
    """ldd's output for target, or "" without ldd."""
    for d in os.environ.get("PATH", "/usr/bin:/bin").split(":"):
        exe = os.path.join(d or ".", "ldd")
        if os.access(exe, os.X_OK):
            break
    else:
        return ""
    r, w = os.pipe()
    pid = os.fork()
    if pid == 0:
        try:
            os.dup2(w, 1)
            os.dup2(w, 2)
            os.execve(exe, ["ldd", target], dict(os.environ, LC_ALL="C"))
        finally:
            os._exit(127)
    os.close(w)
    out = []
    while True:
        chunk = os.read(r, 1 << 16)
        if not chunk:
            break
        out.append(chunk)
    os.close(r)
    os.waitpid(pid, 0)
    return b"".join(out).decode("utf-8", "replace")

try:
    import zlib
except ImportError as e:
    fallback(e)

# The gzip stream's CRC and length catch a damaged or truncated file.
damaged = False
try:
    MFD_EXEC = 0x10  # Linux 6.3+: ask for an executable memfd; older kernels reject the flag
    try:
        fd = os.memfd_create("gty", os.MFD_CLOEXEC | MFD_EXEC)
    except OSError:
        fd = os.memfd_create("gty", os.MFD_CLOEXEC)
    unzip = zlib.decompressobj(wbits=31)
    with open(script, "rb") as f:
        for _ in range(line - 1):
            f.readline()
        while not unzip.eof:
            chunk = f.read(1 << 20)
            if not chunk:
                break
            os.write(fd, unzip.decompress(chunk))
    os.write(fd, unzip.flush())
    damaged = not unzip.eof
except zlib.error:
    damaged = True
except (AttributeError, OSError) as e:
    fallback(e)
if damaged:
    sys.exit("gty: this file is damaged (the embedded app does not unpack)")

# The fd closes on exec, so ldd reaches it through this process.
if not os.environ.get("GTY_SKIP_CHECK"):
    out = ldd("/proc/%d/fd/%d" % (os.getpid(), fd))
    if "not found" in out:
        back(__GTY_LDD=out)

try:
    os.execv("/proc/self/fd/%d" % fd, ["gty"] + args)
except OSError as e:
    fallback(e)
#=end
# The app follows (gzip).
