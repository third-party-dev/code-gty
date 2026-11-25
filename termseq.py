#!/usr/bin/env python3
"""
termseq - document and test terminal escape sequences.

For every sequence it can:
  * summarise where it came from (origin)
  * show how it is sent, byte by byte
  * describe the behaviour a terminal should have
  * run a test:
      automated    request/response sequences; we send, read the reply, judge it
      observed     the sequence is performed and YOU confirm what you saw
      interactive  you do something (paste, click, press a key) and we detect it

Modes
  --mode info   (default) print descriptions only, nothing is sent to the terminal
  --mode exec   print descriptions AND run the tests

Selecting tests
  termseq.py                      all tests, registry order
  termseq.py osc11 da1 osc8       only these, in exactly this order
  termseq.py width graphics       a group name expands to its tests
  termseq.py --list               list test ids and groups
  termseq.py -m exec -u           unattended: run only automated tests, skip ones needing a person

Notes
  * Automated queries are followed by a DA1 request ("ESC [ c"). Every terminal
    answers DA1, so it works as an end-of-reply marker: a terminal that ignores
    the real query is detected immediately instead of after a long timeout.
  * For payload tests (images) the "sends" line shows a placeholder for the
    base64 payload; the real bytes are generated when the test runs.
  * Under tmux/screen many sequences are intercepted or dropped, so results
    describe the multiplexer plus the terminal. Test outside tmux first.
  * Tested with Python 3.8+ on Linux/macOS. Standard library only.
"""
import argparse
import base64
import os
import re
import select
import struct
import sys
import termios
import textwrap
import time
import tty
import zlib
from dataclasses import dataclass
from typing import Callable, List, Optional, Tuple

ESC, BEL = "\x1b", "\x07"
ST = ESC + "\\"
CSI, OSC, DCS, APC = ESC + "[", ESC + "]", ESC + "P", ESC + "_"

PASS, FAIL, UNSUPPORTED, SKIP, ERROR = "PASS", "FAIL", "UNSUPPORTED", "SKIP", "ERROR"
Result = Tuple[str, str]
RETRY = "RETRY"   # internal: user asked to repeat the test

QUERY_TIMEOUT = 1.5
DA1_RE = re.compile(r"\x1b\[\?[\d;]*c")


# --------------------------------------------------------------------------- #
# terminal I/O helpers
# --------------------------------------------------------------------------- #
class Cbreak:
    """No echo, no line buffering; output processing (newlines) untouched."""

    def __enter__(self):
        self.fd = sys.stdin.fileno()
        self.old = termios.tcgetattr(self.fd)
        tty.setcbreak(self.fd)
        return self

    def __exit__(self, *exc):
        termios.tcsetattr(self.fd, termios.TCSADRAIN, self.old)


def out(s: str) -> None:
    sys.stdout.write(s)
    sys.stdout.flush()


def read_some(timeout: float) -> str:
    fd = sys.stdin.fileno()
    if timeout <= 0 or not select.select([fd], [], [], timeout)[0]:
        return ""
    return os.read(fd, 65536).decode("utf-8", "replace")


def flush_input() -> None:
    try:
        termios.tcflush(sys.stdin.fileno(), termios.TCIFLUSH)
    except termios.error:
        pass


def query(seq: str, timeout: float = QUERY_TIMEOUT, sentinel: bool = True) -> Tuple[str, bool]:
    """Send seq (plus a DA1 sentinel) and return (reply_without_sentinel, sentinel_seen)."""
    with Cbreak():
        flush_input()
        out(seq + (CSI + "c" if sentinel else ""))
        buf, deadline = "", time.time() + timeout
        while time.time() < deadline:
            buf += read_some(deadline - time.time())
            if sentinel and DA1_RE.search(buf):
                break
        seen = bool(DA1_RE.search(buf))
        if sentinel:
            buf = DA1_RE.sub("", buf, count=1)
        return buf, seen


def wait_for(pattern: str, timeout: float, settle: float = 0.3) -> str:
    """Collect raw input until `pattern` matches or timeout; keep reading briefly after a match."""
    with Cbreak():
        flush_input()
        buf, deadline = "", time.time() + timeout
        while time.time() < deadline:
            buf += read_some(min(0.25, deadline - time.time()))
            if re.search(pattern, buf, re.S):
                buf += read_some(settle)
                break
        return buf


def ask(expect: str) -> Result:
    flush_input()
    print(f"\n  EXPECTED: {expect}")
    while True:
        try:
            a = input("  Did you observe this?  [y]es / [n]o / [r]etry / [s]kip > ").strip().lower()
        except EOFError:
            return SKIP, "no input"
        if a in ("y", "yes"):
            return PASS, "confirmed by user"
        if a in ("n", "no"):
            return FAIL, "user did not observe expected behaviour"
        if a in ("r", "retry"):
            return RETRY, ""
        if a in ("s", "skip", ""):
            return SKIP, "skipped by user"


def offer_retry(why: str) -> bool:
    flush_input()
    try:
        return input(f"  {why}  [r]etry / [Enter] continue > ").strip().lower() in ("r", "retry")
    except EOFError:
        return False


def countdown(msg: str, secs: int) -> None:
    for i in range(secs, 0, -1):
        out(f"\r  {msg} {i}s ")
        time.sleep(1)
    out("\r" + CSI + "2K")


# --------------------------------------------------------------------------- #
# test model
# --------------------------------------------------------------------------- #
@dataclass
class T:
    id: str
    group: str
    title: str
    origin: str
    seq: str            # the bytes we send (placeholder for payloads)
    behavior: str
    kind: str           # automated | observed | interactive
    run: Callable[[], Result]
    reply: str = ""     # description of the expected reply, for queries


REGISTRY: List[T] = []


def reg(*a, **k):
    REGISTRY.append(T(*a, **k))


# --- automated helpers ------------------------------------------------------ #
def q_test(seq: str, pattern: str, judge: Optional[Callable] = None,
           sentinel: bool = True, timeout: float = QUERY_TIMEOUT) -> Callable[[], Result]:
    def run() -> Result:
        buf, seen = query(seq, timeout=timeout, sentinel=sentinel)
        if sentinel and not seen:
            return ERROR, "terminal never answered the DA1 end-marker; replies are unreliable (tmux? not a tty?)"
        if not buf:
            return UNSUPPORTED, "no reply (unsupported, disabled, or filtered)"
        m = re.search(pattern, buf, re.S)
        if not m:
            return FAIL, f"unexpected reply {buf!r}"
        if judge:
            return judge(m, buf)
        return PASS, f"reply {buf!r}"
    return run


def decrqm(mode: int) -> Callable[[], Result]:
    names = {0: "not recognised", 1: "set (on)", 2: "reset (off)", 3: "permanently set", 4: "permanently reset"}

    def judge(m, buf):
        ps = int(m.group(1))
        if ps == 0:
            return UNSUPPORTED, "terminal does not recognise this mode"
        return PASS, f"mode {mode} is {names.get(ps, ps)}"
    return q_test(f"{CSI}?{mode}$p", rf"\x1b\[\?{mode};(\d)\$y", judge)


def rgb_judge(m, buf):
    return PASS, f"colour reported as rgb:{m.group(1)}"


def measure(text: str, expect_col: int, what: str) -> Callable[[], Result]:
    """Print `text` at column 1, ask the cursor position, compare with expected column."""
    def run() -> Result:
        out("\n")
        buf, seen = query(f"\r{CSI}2K{text}{CSI}6n")
        out(f"\r{CSI}2K")
        m = re.search(r"\x1b\[(\d+);(\d+)R", buf)
        if not seen:
            return ERROR, "no DA1 end-marker"
        if not m:
            return UNSUPPORTED, "no cursor position report"
        col = int(m.group(2))
        cells = col - 1
        if col == expect_col:
            return PASS, f"{what}: {cells} cell(s), as expected"
        return FAIL, f"{what}: terminal advanced {cells} cell(s), expected {expect_col - 1}"
    return run


# --- observed helpers ------------------------------------------------------- #
def visual(act: Callable[[], None], expect: str, cleanup: Optional[Callable[[], None]] = None):
    """Perform the sequence, ask the user, and repeat as often as they choose 'retry'."""
    def run() -> Result:
        while True:
            act()
            res = ask(expect)
            if cleanup:
                cleanup()
            if res[0] != RETRY:
                return res
            out("\n  --- retrying ---\n")
    return run


def png(w: int = 24, h: int = 24) -> bytes:
    """Small RGB gradient PNG, generated in-process (no files, no third-party libs)."""
    def chunk(tag: bytes, data: bytes) -> bytes:
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    raw = b""
    for y in range(h):
        raw += b"\x00" + bytes(v for x in range(w)
                               for v in (int(255 * x / (w - 1)), int(255 * y / (h - 1)), 160))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


# --------------------------------------------------------------------------- #
# the sequences
# --------------------------------------------------------------------------- #
# ---- identify -------------------------------------------------------------- #
def _da1_judge(m, buf):
    params = [p for p in m.group(1).split(";") if p]
    extra = []
    if "4" in params:
        extra.append("sixel graphics advertised")
    if "22" in params:
        extra.append("ANSI colour advertised")
    return PASS, f"attributes {params}" + (f" ({', '.join(extra)})" if extra else "")


reg("da1", "identify", "Primary Device Attributes",
    "DEC VT100 (DA); the '?' list-of-attributes reply is from the VT220 and later. Every terminal copies it.",
    f"{CSI}c",
    "Terminal replies with its class and feature list. Used by programs to detect the terminal family, "
    "and as the end-marker for all other automated queries in this script.",
    "automated", q_test(f"{CSI}c", r"\x1b\[\?([\d;]*)c", _da1_judge, sentinel=False),
    reply="CSI ? Ps ; Ps ... c")

reg("da2", "identify", "Secondary Device Attributes",
    "DEC VT220. xterm reports terminal type and version here; many terminals imitate it.",
    f"{CSI}>c",
    "Terminal replies with a terminal-type id, a firmware/version number and a ROM-cartridge field.",
    "automated", q_test(f"{CSI}>c", r"\x1b\[>([\d;]*)c",
                        lambda m, b: (PASS, f"type;version;cartridge = {m.group(1)}")),
    reply="CSI > Pp ; Pv ; Pc c")

reg("xtversion", "identify", "XTVERSION (terminal name and version)",
    "xterm patch #354 (Thomas Dickey). Adopted by kitty, WezTerm, Ghostty, foot, iTerm2 and others.",
    f"{CSI}>0q",
    "Terminal replies with a DCS string holding its name and version, e.g. 'ghostty 1.x'.",
    "automated", q_test(f"{CSI}>0q", r"\x1bP>\|(.*?)\x1b\\",
                        lambda m, b: (PASS, f"terminal identifies as {m.group(1)!r}")),
    reply="DCS > | text ST")

reg("dsr", "identify", "Device Status Report: terminal OK",
    "ECMA-48 DSR, as used by DEC terminals.",
    f"{CSI}5n",
    "Terminal replies 'CSI 0 n' meaning ready, no malfunction. The simplest possible liveness check.",
    "automated", q_test(f"{CSI}5n", r"\x1b\[0n"), reply="CSI 0 n")

reg("cpr", "identify", "Cursor Position Report",
    "ECMA-48 CPR; heavily used since the VT100.",
    f"{CSI}6n",
    "Terminal replies with the cursor row and column, 1-based.",
    "automated", q_test(f"{CSI}6n", r"\x1b\[(\d+);(\d+)R",
                        lambda m, b: (PASS, f"cursor at row {m.group(1)}, col {m.group(2)}")),
    reply="CSI row ; col R")


def _size_judge(m, buf):
    rows, cols = int(m.group(1)), int(m.group(2))
    try:
        sz = os.get_terminal_size(sys.stdout.fileno())
    except OSError:
        return PASS, f"terminal reports {cols}x{rows}"
    if (sz.columns, sz.lines) == (cols, rows):
        return PASS, f"{cols}x{rows}, matches the tty's own size"
    return FAIL, f"terminal says {cols}x{rows}, tty says {sz.columns}x{sz.lines}"


reg("winsize", "identify", "Report text area size in characters (XTWINOPS 18)",
    "xterm XTWINOPS, descended from dtterm window operations.",
    f"{CSI}18t",
    "Terminal replies with the size of the text area in rows and columns. The script cross-checks it "
    "against the kernel's idea of the tty size.",
    "automated", q_test(f"{CSI}18t", r"\x1b\[8;(\d+);(\d+)t", _size_judge),
    reply="CSI 8 ; rows ; cols t")

reg("cellsize", "identify", "Report cell size in pixels (XTWINOPS 16)",
    "xterm XTWINOPS. Image-capable terminals rely on this to size pictures.",
    f"{CSI}16t",
    "Terminal replies with the height and width of one character cell in pixels. "
    "Matters for image placement and for diagnosing wide-glyph problems.",
    "automated", q_test(f"{CSI}16t", r"\x1b\[6;(\d+);(\d+)t",
                        lambda m, b: (PASS, f"cell is {m.group(2)}x{m.group(1)} px")),
    reply="CSI 6 ; height ; width t")

reg("decrqss", "identify", "DECRQSS: request setting (SGR)",
    "DEC VT420. xterm and a few others implement it.",
    f"{DCS}$qm{ST}",
    "Terminal replies with a DCS string that is the current SGR state, as a sequence you could send back. "
    "'DCS 1 $ r ... m' means valid, 'DCS 0 $ r' means the request was invalid.",
    "automated", q_test(f"{DCS}$qm{ST}", r"\x1bP1\$r([\d;:]*)m\x1b\\",
                        lambda m, b: (PASS, f"current SGR is {m.group(1) or '0'!r}")),
    reply="DCS 1 $ r Pm m ST")

reg("theme_query", "identify", "Colour-scheme (dark/light) query",
    "Contour's colour palette update notification spec; also in kitty and Ghostty.",
    f"{CSI}?996n",
    "Terminal replies whether the OS/theme is dark (1) or light (2). Lets TUIs pick a matching palette.",
    "automated", q_test(f"{CSI}?996n", r"\x1b\[\?997;([12])n",
                        lambda m, b: (PASS, "dark" if m.group(1) == "1" else "light")),
    reply="CSI ? 997 ; 1|2 n")

# ---- modes (DECRQM) -------------------------------------------------------- #
for _mode, _name, _origin, _beh in (
    (2026, "Synchronized output",
     "Spec by Contour (Christian Parpart); adopted by kitty, iTerm2, WezTerm, foot, Ghostty and others.",
     "Between '?2026h' and '?2026l' the terminal batches screen updates and draws them as one frame, "
     "which removes tearing and flicker in full-screen programs."),
    (2004, "Bracketed paste",
     "xterm (Thomas Dickey). Now close to universal.",
     "With the mode on, pasted text is wrapped in CSI 200~ ... CSI 201~ so programs can tell a paste "
     "from typing."),
    (1004, "Focus reporting",
     "xterm.",
     "With the mode on, the terminal sends CSI I when it gains focus and CSI O when it loses it."),
    (2027, "Grapheme clustering",
     "Contour spec; supported by kitty, WezTerm, Ghostty, foot and others.",
     "With the mode on, combined sequences such as emoji ZWJ families are treated as one wide "
     "character instead of several. Directly affects glyph width."),
    (2031, "Colour-scheme change notifications",
     "Contour spec; kitty and Ghostty support it.",
     "With the mode on, the terminal sends CSI ? 997 ; 1|2 n whenever the dark/light theme changes."),
    (1049, "Alternate screen with cursor save",
     "xterm. Used by vim, less and every full-screen TUI.",
     "Switches to a second screen buffer, clearing it, and restores the main screen and cursor on exit."),
):
    reg(f"mode{_mode}", "modes", f"DECRQM: is mode {_mode} supported ({_name})",
        "DECRQM comes from the DEC VT320. " + _origin, f"{CSI}?{_mode}$p",
        f"Asks the terminal whether private mode {_mode} exists and its state. {_beh}",
        "automated", decrqm(_mode), reply=f"CSI ? {_mode} ; Ps $ y   (0 unknown, 1 on, 2 off, 3/4 fixed)")

# ---- colours --------------------------------------------------------------- #
_RGB = r"rgb:([0-9a-fA-F/]+)(?:\x07|\x1b\\)"
reg("osc10", "colors", "Query default foreground colour",
    "xterm OSC 10 (dynamic colours).",
    f"{OSC}10;?{ST}",
    "Terminal replies with its current default text colour as rgb:rrrr/gggg/bbbb.",
    "automated", q_test(f"{OSC}10;?{ST}", rf"\x1b\]10;{_RGB}", rgb_judge),
    reply="OSC 10 ; rgb:rrrr/gggg/bbbb ST")
reg("osc11", "colors", "Query default background colour",
    "xterm OSC 11. Used by tools (bat, delta, vim) to guess dark vs light themes.",
    f"{OSC}11;?{ST}",
    "Terminal replies with its current default background colour.",
    "automated", q_test(f"{OSC}11;?{ST}", rf"\x1b\]11;{_RGB}", rgb_judge),
    reply="OSC 11 ; rgb:rrrr/gggg/bbbb ST")
reg("osc12", "colors", "Query cursor colour",
    "xterm OSC 12.",
    f"{OSC}12;?{ST}",
    "Terminal replies with the cursor colour. Some terminals do not implement this one.",
    "automated", q_test(f"{OSC}12;?{ST}", rf"\x1b\]12;{_RGB}", rgb_judge),
    reply="OSC 12 ; rgb:rrrr/gggg/bbbb ST")
reg("osc4", "colors", "Query palette entry 1 (red)",
    "xterm OSC 4.",
    f"{OSC}4;1;?{ST}",
    "Terminal replies with the colour currently assigned to ANSI palette index 1.",
    "automated", q_test(f"{OSC}4;1;?{ST}", rf"\x1b\]4;1;{_RGB}", rgb_judge),
    reply="OSC 4 ; 1 ; rgb:rrrr/gggg/bbbb ST")

# ---- width (cursor position tests) ----------------------------------------- #
for _id, _text, _col, _what, _beh, _origin in (
    ("width_cjk", "日", 3, "CJK ideograph",
     "A wide (East Asian Wide) character occupies 2 cells.",
     "Unicode East Asian Width property; wcwidth tradition."),
    ("width_emoji", "👍", 3, "emoji",
     "Emoji with default emoji presentation occupy 2 cells.",
     "Unicode emoji presentation; terminals disagree on older Unicode versions."),
    ("width_combining", "é", 2, "e + combining acute",
     "A combining mark adds no width; base plus mark is 1 cell.",
     "Unicode general category Mn (zero width)."),
    ("width_vs16", "❤️", 3, "heart + VS16",
     "U+2764 is narrow by default; VS16 requests emoji presentation, making it 2 cells in modern terminals.",
     "Unicode variation selectors; support is uneven."),
    ("width_flag", "\U0001F1EC\U0001F1E7", 3, "regional-indicator flag",
     "Two regional indicators form one flag, 2 cells wide.",
     "Unicode emoji flag sequences; needs grapheme clustering."),
    ("width_zwj", "\U0001F468‍\U0001F469‍\U0001F467", 3, "ZWJ family emoji",
     "A zero-width-joiner sequence should render as one 2-cell glyph. Terminals without grapheme "
     "clustering advance 6 cells or more.",
     "Unicode ZWJ sequences; mode 2027 was invented to make this predictable."),
    ("width_pua", "", 2, "Nerd Font / Powerline glyph U+E0B6",
     "Private-use glyphs are 1 cell by convention. The terminal's advance must be 1; if the glyph "
     "still looks shifted or overlaps, the font's glyph metrics are the cause, not the terminal.",
     "Powerline symbols (vim-powerline), carried into the Nerd Fonts private-use range."),
):
    reg(_id, "width", f"Cell width of {_what}", _origin,
        f"\r{CSI}2K{_text}{CSI}6n",
        _beh + " Test prints the character at column 1 and asks the cursor position.",
        "automated", measure(_text, _col, _what), reply="CSI row ; col R")

# ---- SGR ------------------------------------------------------------------- #
def _sgr_basic():
    out("\n  " + "  ".join(f"{CSI}{c}m{n}{CSI}0m" for c, n in (
        (1, "bold"), (2, "dim"), (3, "italic"), (4, "underline"), (7, "reverse"),
        (9, "strike"), (53, "overline"))) + "\n")


reg("sgr_basic", "sgr", "Basic text attributes",
    "ECMA-48 SGR (bold/underline/reverse from DEC); italic/strike by ISO 6429; overline (53) by ITU T.416/xterm.",
    f"{CSI}1m {CSI}2m {CSI}3m {CSI}4m {CSI}7m {CSI}9m {CSI}53m",
    "Each word below should be drawn with its own attribute and reset cleanly afterwards.",
    "observed", visual(_sgr_basic, "bold, dim, italic, underline, reverse, strikethrough and overline "
                                   "each look right, with no attribute bleeding into the next word."))


def _sgr256():
    out("\n  " + "".join(f"{CSI}48;5;{n}m {CSI}0m" for n in range(16, 232)) + "\n")


reg("sgr_256", "sgr", "256-colour palette",
    "xterm (Thomas Dickey), 1999.",
    f"{CSI}48;5;N m",
    "Selects background colour N from the 256-colour palette (16 system, 6x6x6 cube, 24 greys).",
    "observed", visual(_sgr256, "a smooth strip of the 6x6x6 colour cube with no black or missing cells."))


def _sgr_true():
    out("\n  " + "".join(
        f"{CSI}48;2;{int(255 * i / 71)};{int(255 * (1 - i / 71))};128m {CSI}0m" for i in range(72)) + "\n")


reg("sgr_truecolor", "sgr", "24-bit colour (semicolon form)",
    "xterm/Konsole/iTerm2 de facto since ~2012; the form 'CSI 38;2;r;g;b m' is widely accepted.",
    f"{CSI}48;2;R;G;B m",
    "Selects an exact RGB background. A gradient should look continuous.",
    "observed", visual(_sgr_true, "a smooth red-to-green gradient with no visible banding or steps "
                                  "(banding means colours are being rounded to 256)."))


def _sgr_true_colon():
    out(f"\n  {CSI}48:2::220:40:40m   {CSI}0m  <- should be red\n")


reg("sgr_truecolor_colon", "sgr", "24-bit colour (colon form, ITU T.416)",
    "ITU T.416 / ISO 8613-6; the standards-correct colon form, supported by kitty, xterm, VTE, Ghostty.",
    f"{CSI}48:2::R:G:B m",
    "Same as the semicolon form but with colon sub-parameters. Terminals that do not understand colons "
    "may misparse it and show the wrong colour or other attributes.",
    "observed", visual(_sgr_true_colon, "a solid red block. Anything else (no colour, odd attributes) means "
                                        "colon sub-parameters are not handled."))


def _sgr_ul():
    out("\n")
    for n, name in ((1, "single"), (2, "double"), (3, "curly"), (4, "dotted"), (5, "dashed")):
        out(f"  {CSI}4:{n}m{name}{CSI}0m")
    out(f"\n  {CSI}4:3;58;2;255;60;60mcoloured curly underline{CSI}0m\n")


reg("sgr_underline_styles", "sgr", "Underline styles and colours",
    "kitty 'extended underlines' (undercurl), now in VTE, WezTerm, iTerm2, Ghostty; colour via SGR 58 from xterm.",
    f"{CSI}4:3m {CSI}58;2;R;G;B m",
    "4:N selects underline style (1 single, 2 double, 3 curly, 4 dotted, 5 dashed). SGR 58 sets an "
    "independent underline colour. Editors use this for spell-check and diagnostics squiggles.",
    "observed", visual(_sgr_ul, "five different underline styles (single, double, curly, dotted, dashed) and the "
                                "last line having a red curly underline."))

# ---- OSC (visible) --------------------------------------------------------- #
reg("osc2_title", "osc", "Set window title",
    "xterm OSC 0/1/2. OSC 2 sets the window title, OSC 0 sets title and icon name.",
    f"{CSI}22;0t {OSC}2;termseq title test{ST} ... {CSI}23;0t",
    "Terminal changes the window or tab title. The script pushes the old title first (CSI 22;0 t) "
    "and pops it afterwards (CSI 23;0 t) so your title is restored.",
    "observed", visual(lambda: out(f"{CSI}22;0t{OSC}2;termseq title test{ST}\n  (title set)\n"),
                       "the window or tab title now reads 'termseq title test'.",
                       cleanup=lambda: out(f"{CSI}23;0t")))

reg("osc8", "osc", "Hyperlinks",
    "Proposed by Egmont Koblinger (VTE) in 2017; now supported by most modern terminals.",
    f"{OSC}8;;URL{ST} text {OSC}8;;{ST}",
    "Text between the opening and closing OSC 8 becomes a link. Terminals underline it on hover or "
    "always, and open it on Ctrl/Cmd+click.",
    "observed", visual(lambda: out(f"\n  {OSC}8;;https://example.com{ST}example.com link{OSC}8;;{ST}  "
                                   f"(hover, then Ctrl/Cmd+click)\n"),
                       "the words 'example.com link' are marked as a link on hover, and Ctrl/Cmd+click "
                       "opens https://example.com."))

reg("osc7", "osc", "Report working directory",
    "Apple Terminal.app originally; adopted by VTE, iTerm2, kitty, WezTerm, Ghostty.",
    f"{OSC}7;file://HOST/PATH{ST}",
    "The shell reports its current directory. New tabs and splits can then start in that directory.",
    "observed", visual(lambda: out(f"{OSC}7;file://{os.uname().nodename}{os.getcwd()}{ST}\n"
                                   f"  (reported cwd: {os.getcwd()})\n"),
                       "opening a NEW tab or split from this terminal starts in the directory shown above "
                       "(skip if your terminal does not offer 'new tab in same directory')."))

reg("osc133", "osc", "Semantic prompt marks",
    "FinalTerm (2012); adopted by iTerm2, kitty, WezTerm, VTE, Ghostty.",
    f"{OSC}133;A{ST} prompt {OSC}133;B{ST} input {OSC}133;C{ST} output {OSC}133;D;0{ST}",
    "The shell marks where prompts, input and command output begin and end. Terminals use this for "
    "jump-to-prompt, select-last-output and click-to-move-cursor.",
    "observed", visual(lambda: out(f"\n{OSC}133;A{ST}$ {OSC}133;B{ST}fake-command{OSC}133;C{ST}\n"
                                   f"fake output line\n{OSC}133;D;0{ST}\n"),
                       "using your terminal's 'jump to previous prompt' binding lands on the '$ fake-command' "
                       "line above (skip if you do not know the binding or the terminal has none)."))


def _progress():
    out(f"\n  {OSC}9;4;1;60{ST}  progress set to 60% for 4 seconds...\n")
    time.sleep(4)


reg("osc9_4", "osc", "Progress indicator",
    "ConEmu; adopted by Windows Terminal, Ghostty and others.",
    f"{OSC}9;4;1;60{ST}  (clear: {OSC}9;4;0{ST})",
    "State 1 with a percentage draws a progress bar in the tab, taskbar or title area; state 0 clears it.",
    "observed", visual(_progress, "a 60% progress indicator appeared in the tab or taskbar while waiting "
                                  "(skip if your terminal has no progress UI).",
                       cleanup=lambda: out(f"{OSC}9;4;0{ST}")))

reg("osc52", "osc", "Clipboard write",
    "xterm OSC 52. Often disabled by default for security.",
    f"{OSC}52;c;<base64>{ST}",
    "Terminal copies the decoded text into the system clipboard. Lets remote programs (over ssh) "
    "set your local clipboard.",
    "observed", visual(lambda: out(f"\n  {OSC}52;c;{base64.b64encode(b'osc52-works').decode()}{ST}"
                                   "  sent clipboard text 'osc52-works'\n"),
                       "pasting somewhere (Cmd/Ctrl+V in another app) inserts 'osc52-works'."))


def _osc52_read_judge(m, buf):
    return PASS, f"terminal returned clipboard data ({len(m.group(1))} base64 chars; content not shown)"


reg("osc52_query", "osc", "Clipboard read",
    "xterm OSC 52 with '?' payload. Almost always disabled because it leaks clipboard contents.",
    f"{OSC}52;c;?{ST}",
    "Terminal replies with the clipboard contents base64-encoded. Being UNSUPPORTED here is the "
    "secure, expected default. The script only reports the length, never the content.",
    "automated", q_test(f"{OSC}52;c;?{ST}", r"\x1b\]52;[a-z]*;([A-Za-z0-9+/=]*)(?:\x07|\x1b\\)", _osc52_read_judge),
    reply="OSC 52 ; c ; base64 ST")

# ---- notifications --------------------------------------------------------- #
def _notify(seq: str):
    def act():
        countdown("Switch to another window so the notification isn't suppressed:", 4)
        out(seq + "\n  notification sequence sent\n")
    return act


reg("osc9_notify", "notify", "Desktop notification (OSC 9)",
    "iTerm2 (Growl-style message only). Conflicts with ConEmu's OSC 9;N sub-commands.",
    f"{OSC}9;termseq OSC 9 test{ST}",
    "Terminal raises a desktop notification with the given text and no separate title. Many terminals "
    "suppress it while their window is focused.",
    "observed", visual(_notify(f"{OSC}9;termseq OSC 9 test{ST}"),
                       "a desktop notification saying 'termseq OSC 9 test'."))

reg("osc777_notify", "notify", "Desktop notification (OSC 777)",
    "rxvt-unicode 'notify' extension; supported by Ghostty, foot, WezTerm and others.",
    f"{OSC}777;notify;Title;Body{ST}",
    "Terminal raises a desktop notification with a separate title and body.",
    "observed", visual(_notify(f"{OSC}777;notify;termseq;OSC 777 test{ST}"),
                       "a desktop notification titled 'termseq' with body 'OSC 777 test'."))

reg("osc99_notify", "notify", "Desktop notification (OSC 99, kitty)",
    "kitty desktop notification protocol; narrow support.",
    f"{OSC}99;i=1;termseq OSC 99 test{ST}",
    "Metadata key=value pairs, then the payload. A richer protocol than 9/777: ids, urgency, "
    "icons, buttons, close events.",
    "observed", visual(_notify(f"{OSC}99;i=1;termseq OSC 99 test{ST}"),
                       "a desktop notification saying 'termseq OSC 99 test' (only kitty-family terminals)."))

# ---- graphics -------------------------------------------------------------- #
reg("kitty_gfx_query", "graphics", "Kitty graphics protocol: support query",
    "kitty (Kovid Goyal). Also in WezTerm, Ghostty, Konsole and others.",
    f"{APC}Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA{ST}",
    "Sends a 1x1 pixel test image with action 'query'. A supporting terminal replies 'OK' and "
    "displays nothing.",
    "automated", q_test(f"{APC}Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA{ST}", r"\x1b_Gi=31;OK\x1b\\",
                        lambda m, b: (PASS, "kitty graphics protocol supported")),
    reply="APC G i=31 ; OK ST")


def _kitty_img():
    b64 = base64.b64encode(png()).decode()
    out("\n" + f"{APC}Ga=T,f=100,q=2,c=12,r=6;{b64}{ST}" + "\n" * 7)


reg("kitty_gfx_show", "graphics", "Kitty graphics protocol: display an image",
    "kitty.",
    f"{APC}Ga=T,f=100,q=2,c=12,r=6;<base64 PNG>{ST}",
    "Transmits a PNG and displays it scaled to 12x6 cells at the cursor.",
    "observed", visual(_kitty_img, "a small blue-green-red gradient image about 12 cells wide."))


def _iterm_img():
    b64 = base64.b64encode(png()).decode()
    out("\n" + f"{OSC}1337;File=inline=1;width=12;height=6;preserveAspectRatio=0:{b64}{BEL}" + "\n" * 7)


reg("iterm_image", "graphics", "iTerm2 inline images (OSC 1337)",
    "iTerm2 proprietary escape codes; also in WezTerm, Konsole, VS Code (with images enabled), mintty.",
    f"{OSC}1337;File=inline=1;width=12;height=6:<base64 PNG>{BEL}",
    "Transmits an image file inline and displays it in the given number of cells.",
    "observed", visual(_iterm_img, "a small gradient image about 12 cells wide."))


def _sixel():
    out(f"\n{DCS}0;0;0q\"1;1;40;18#1;2;100;0;0#1!40~-!40~-!40~{ST}\n\n\n\n")


reg("sixel", "graphics", "Sixel graphics",
    "DEC VT240/VT340 (1980s). Revived by xterm, mlterm, foot, WezTerm, iTerm2; VS Code with images on.",
    f"{DCS}0;0;0q\"1;1;40;18#1;2;100;0;0#1!40~-!40~-!40~{ST}",
    "Draws a bitmap described as columns of six vertical pixels. This test draws a 40x18 red rectangle. "
    "DA1 parameter 4 advertises support.",
    "observed", visual(_sixel, "a solid red rectangle (about 40x18 pixels) under the cursor."))

# ---- screen / legacy ------------------------------------------------------- #
def _altscreen():
    out("\n  MAIN-SCREEN MARKER (should still be here afterwards)\n")
    time.sleep(0.5)
    out(f"{CSI}?1049h{CSI}2J{CSI}H  ALTERNATE SCREEN - returning in 2 seconds")
    time.sleep(2)
    out(f"{CSI}?1049l")


reg("altscreen", "screen", "Alternate screen buffer",
    "xterm 1049 (combines older 47 and 1047 with cursor save).",
    f"{CSI}?1049h ... {CSI}?1049l",
    "Switches to a blank second screen and back, restoring the main screen and cursor untouched.",
    "observed", visual(_altscreen, "a blank screen with the ALTERNATE SCREEN message for 2s, then your previous "
                                   "output returns intact including the MAIN-SCREEN MARKER line."))


def _cursor():
    out("\n")
    for n, name in ((2, "steady block"), (4, "steady underline"), (6, "steady bar")):
        out(f"{CSI}{n} q\r{CSI}2K  cursor shape: {name}")
        time.sleep(1.2)
    out(f"\r{CSI}2K")


reg("decscusr", "screen", "Cursor shape",
    "DEC VT520 DECSCUSR, extended by xterm (bar shapes).",
    f"{CSI}Ps SP q   (2 block, 4 underline, 6 bar)",
    "Changes the cursor shape. Ps 0 restores the user's default, which the script does afterwards.",
    "observed", visual(_cursor, "the cursor visibly changed from a block to an underline to a vertical bar.",
                       cleanup=lambda: out(f"{CSI}0 q")))

reg("dec_graphics", "screen", "DEC special graphics (line drawing)",
    "DEC VT100 alternate character set; basis of curses box drawing.",
    f"{ESC}(0 lqqqk {ESC}(B",
    "Designating G0 as DEC Special Graphics turns letters like l q k x m j into box-drawing characters. "
    "ESC ( B returns to ASCII.",
    "observed", visual(lambda: out(f"\n  {ESC}(0lqqqqqk\n  x     x\n  mqqqqqj{ESC}(B\n"),
                       "a clean rectangle drawn with continuous lines (not the letters lqqqk / x / mqqqj)."))

reg("dec_double", "screen", "Double-height and double-width lines",
    "DEC VT100 (DECDHL / DECDWL). Few modern terminals implement it.",
    f"{ESC}#3 {ESC}#4 {ESC}#6",
    "ESC # 3 and ESC # 4 draw the top and bottom halves of a double-height line; ESC # 6 draws a "
    "double-width line. xterm, mlterm and VTE-less terminals vary; many ignore it.",
    "observed", visual(lambda: out(f"\n{ESC}#3 Double height\n{ESC}#4 Double height\n{ESC}#6 Double width\n"),
                       "'Double height' drawn once at twice normal height across two lines, and "
                       "'Double width' wider than normal (UNSUPPORTED terminals show normal text)."))

reg("bell", "screen", "Bell",
    "ASCII BEL (0x07), ECMA-48.",
    BEL,
    "Terminal rings or flashes, bounces the dock icon, or marks the tab. Behaviour is configurable.",
    "observed", visual(lambda: out("\n  ringing bell\n" + BEL),
                       "some bell feedback (sound, visual flash, tab or dock indicator)."))

reg("osc66", "screen", "Text sizing protocol",
    "kitty (very recent). Little support elsewhere yet.",
    f"{OSC}66;s=2;Big text{ST}",
    "Renders the payload text scaled to a multiple of the cell size (s=2 is double scale).",
    "observed", visual(lambda: out(f"\n{OSC}66;s=2;Big text{ST}\n\n"),
                       "'Big text' rendered at double size (UNSUPPORTED terminals print it normally or not at all)."))

# ---- interactive input ----------------------------------------------------- #
def _bracketed():
    out(f"\n  Paste any text now (Cmd/Ctrl+V or Ctrl+Shift+V), you have 20s...\n")
    out(f"{CSI}?2004h")
    try:
        buf = wait_for(r"\x1b\[201~", 20)
    finally:
        out(f"{CSI}?2004l")
    if "\x1b[200~" in buf and "\x1b[201~" in buf:
        return PASS, "paste arrived wrapped in 200~ ... 201~ markers"
    if buf:
        return FAIL, f"paste arrived WITHOUT markers: {buf[:40]!r}"
    return SKIP, "nothing pasted in time"


reg("bracketed_paste", "input", "Bracketed paste in action",
    "xterm.",
    f"{CSI}?2004h  ... paste ...  {CSI}?2004l",
    "With the mode on, a paste is delivered wrapped in ESC [ 200 ~ and ESC [ 201 ~.",
    "interactive", _bracketed, reply="CSI 200 ~ text CSI 201 ~")


def _focus():
    out(f"\n  Click another window, then click back here. You have 20s...\n")
    out(f"{CSI}?1004h")
    try:
        buf = wait_for(r"\x1b\[O.*\x1b\[I|\x1b\[I.*\x1b\[O", 20)
    finally:
        out(f"{CSI}?1004l")
    got = [n for s, n in (("\x1b[O", "focus-out"), ("\x1b[I", "focus-in")) if s in buf]
    if len(got) == 2:
        return PASS, "received focus-out and focus-in"
    if got:
        return FAIL, f"only received {got[0]}"
    return SKIP, "no focus change detected in time"


reg("focus_events", "input", "Focus reporting in action",
    "xterm.",
    f"{CSI}?1004h",
    "While on, the terminal sends CSI O when it loses focus and CSI I when it regains it.",
    "interactive", _focus, reply="CSI O  /  CSI I")


def _mouse():
    out(f"\n  Click once inside this terminal. You have 15s...\n")
    out(f"{CSI}?1000h{CSI}?1006h")
    try:
        buf = wait_for(r"\x1b\[<\d+;\d+;\d+[Mm]", 15)
    finally:
        out(f"{CSI}?1006l{CSI}?1000l")
    m = re.search(r"\x1b\[<(\d+);(\d+);(\d+)([Mm])", buf)
    if m:
        return PASS, f"SGR mouse report: button {m.group(1)} at col {m.group(2)}, row {m.group(3)}"
    return SKIP, "no click detected in time"


reg("mouse_sgr", "input", "SGR mouse reporting",
    "xterm 1000 (click tracking) with 1006 (SGR encoding, no coordinate limit).",
    f"{CSI}?1000h {CSI}?1006h",
    "Clicks are reported as CSI < button ; col ; row M (press) or m (release).",
    "interactive", _mouse, reply="CSI < b ; x ; y M|m")


def _kitty_kbd():
    out(f"\n  Press Ctrl+I (NOT the Tab key). You have 15s...\n")
    out(f"{CSI}>1u")
    try:
        buf = wait_for(r"\x1b\[105;5u|\t", 15)
    finally:
        out(f"{CSI}<u")
    if "\x1b[105;5u" in buf:
        return PASS, "Ctrl+I arrived as CSI 105;5 u, distinct from Tab"
    if "\t" in buf:
        return FAIL, "Ctrl+I arrived as a plain Tab byte: kitty keyboard protocol not active"
    return SKIP, "no key detected in time"


reg("kitty_keyboard", "input", "Kitty keyboard protocol in action",
    "kitty (Kovid Goyal); adopted by Ghostty, WezTerm, foot, iTerm2 and others.",
    f"{CSI}>1u ... {CSI}<u",
    "Pushes the 'disambiguate' flag. Keys that legacy terminals confuse (Ctrl+I vs Tab, Ctrl+[ vs Esc) "
    "then arrive as distinct CSI ... u sequences. Pop restores the old mode.",
    "interactive", _kitty_kbd, reply="CSI 105 ; 5 u")

reg("kitty_keyboard_query", "input", "Kitty keyboard protocol: support query",
    "kitty.",
    f"{CSI}?u",
    "Terminal replies with the currently active keyboard-protocol flags. No reply means unsupported.",
    "automated", q_test(f"{CSI}?u", r"\x1b\[\?(\d+)u",
                        lambda m, b: (PASS, f"supported, active flags = {m.group(1)}")),
    reply="CSI ? flags u")

# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
USE_COLOR = False
_COL = {PASS: "32", FAIL: "31", UNSUPPORTED: "33", SKIP: "90", ERROR: "35"}


def paint(text: str, code: str) -> str:
    return f"\x1b[{code}m{text}\x1b[0m" if USE_COLOR else text


PLACEHOLDER_RE = re.compile(r"<|\.\.\.|\bPs\b|\bN\b|R;G;B|URL|HOST/PATH|Title;Body|\bprompt\b|\(clear")


def show(seq: str, limit: int = 60) -> Tuple[str, str]:
    """Readable form (control characters named) and an exact hex dump (omitted for placeholder strings)."""
    names = {"\x1b": "ESC", "\x07": "BEL", "\r": "CR", "\n": "LF"}
    parts, run = [], ""
    for ch in seq:
        if ch in names or ord(ch) < 0x20:
            if run.strip():
                parts.append(run.strip())
            run = ""
            parts.append(names.get(ch, f"\\x{ord(ch):02x}"))
        else:
            run += ch
    if run.strip():
        parts.append(run.strip())
    raw = seq.encode("utf-8")
    text = " ".join(parts)
    if PLACEHOLDER_RE.search(seq):
        return text, ""
    return text, " ".join(f"{b:02x}" for b in raw[:limit]) + (f" ... ({len(raw)} bytes)" if len(raw) > limit else "")


def wrap(label: str, text: str) -> None:
    pre = f"  {label:<9} "
    print(textwrap.fill(text, width=100, initial_indent=pre, subsequent_indent=" " * len(pre)))


def describe(t: T, i: int, n: int) -> None:
    kinds = {"automated": "automated (request/response, judged by the script)",
             "observed": "observed (the sequence is performed, you confirm what you saw)",
             "interactive": "interactive (you act, the script detects the result)"}
    text, hexs = show(t.seq)
    print(paint(f"[{i}/{n}] {t.id}", "1") + f"  -  {t.title}   [{t.group}]")
    wrap("origin:", t.origin)
    wrap("sends:", text)
    if hexs:
        wrap("bytes:", hexs)
    if t.reply:
        wrap("reply:", t.reply)
    wrap("behavior:", t.behavior)
    wrap("test:", kinds[t.kind])


def select_tests(names: List[str]) -> List[T]:
    by_id = {t.id: t for t in REGISTRY}
    groups = {}
    for t in REGISTRY:
        groups.setdefault(t.group, []).append(t)
    chosen: List[T] = []
    for name in names:
        if name == "all":
            chosen += REGISTRY
        elif name in by_id:
            chosen.append(by_id[name])
        elif name in groups:
            chosen += groups[name]
        else:
            sys.exit(f"unknown test or group: {name!r} (try --list)")
    return chosen


def main() -> int:
    global USE_COLOR
    ap = argparse.ArgumentParser(description="Document and test terminal escape sequences.",
                                 formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog="examples:\n  termseq.py --list\n  termseq.py --mode info osc8 osc133\n"
                                        "  termseq.py --mode exec identify width\n  termseq.py -m exec osc11 da1")
    ap.add_argument("tests", nargs="*", help="test ids or group names, run in the order given (default: all)")
    ap.add_argument("-m", "--mode", choices=("info", "exec"), default="info",
                    help="info: describe only; exec: describe and run (default: info)")
    ap.add_argument("-l", "--list", action="store_true", help="list test ids and groups, then exit")
    ap.add_argument("-u", "--unattended", action="store_true",
                    help="exec mode without prompts: run automated tests only; observed and interactive "
                         "tests are reported as SKIP (needs a person)")
    ap.add_argument("--no-color", action="store_true")
    args = ap.parse_args()

    USE_COLOR = sys.stdout.isatty() and not args.no_color and "NO_COLOR" not in os.environ

    if args.list:
        cur = None
        for t in REGISTRY:
            if t.group != cur:
                cur = t.group
                print(paint(f"\n{cur}", "1"))
            print(f"  {t.id:<22} {t.kind:<12} {t.title}")
        return 0

    tests = select_tests(args.tests) if args.tests else list(REGISTRY)
    execute = args.mode == "exec"

    if execute:
        if not (sys.stdin.isatty() and sys.stdout.isatty()):
            sys.exit("exec mode needs an interactive terminal (stdin and stdout must be a tty)")
        if os.environ.get("TMUX") or os.environ.get("STY"):
            print(paint("warning: running inside tmux/screen; results describe the multiplexer plus the "
                        "terminal, and some sequences will be intercepted.\n", "33"))

    results: List[Tuple[str, str, str]] = []
    for i, t in enumerate(tests, 1):
        describe(t, i, len(tests))
        if execute and args.unattended and t.kind != "automated":
            status, detail = SKIP, f"needs a person ({t.kind}); skipped in unattended mode"
            print("  " + paint(f"{'result:':<9} {status}", _COL[status]) + f" - {detail}")
            results.append((t.id, status, detail))
        elif execute:
            print(f"  {'running:':<9} ...")
            try:
                status, detail = t.run()
                while t.kind == "interactive" and status in (SKIP, FAIL) and \
                        offer_retry(f"Nothing usable detected ({status.lower()})."):
                    print(f"  {'running:':<9} ... (retry)")
                    status, detail = t.run()
            except Exception as e:  # keep going; one broken test shouldn't end the session
                status, detail = ERROR, f"{type(e).__name__}: {e}"
            finally:
                flush_input()
            print("  " + paint(f"{'result:':<9} {status}", _COL[status]) + f" - {detail}")
            results.append((t.id, status, detail))
        print()

    if execute:
        print(paint("summary", "1"))
        for tid, status, detail in results:
            print(f"  {paint(f'{status:<12}', _COL[status])} {tid:<22} {detail}")
        counts = {s: sum(1 for _, x, _ in results if x == s) for s in _COL}
        print("\n  " + ", ".join(f"{n} {s.lower()}" for s, n in counts.items() if n))
        return 1 if counts[FAIL] or counts[ERROR] else 0
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        out(f"{CSI}?1004l{CSI}?1006l{CSI}?1000l{CSI}?2004l{CSI}<u{CSI}0 q{CSI}?25h\n")
        sys.exit(130)



'''
  VSCode Terminal:

  summary
    PASS         da1                    attributes ['1', '2']
    PASS         da2                    type;version;cartridge = 0;276;0
    PASS         xtversion              terminal identifies as 'xterm.js(6.1.0-beta.304)'
    PASS         dsr                    reply '\x1b[0n'
    PASS         cpr                    cursor at row 61, col 1
    PASS         winsize                103x61, matches the tty's own size
    PASS         cellsize               cell is 8x17 px
    PASS         decrqss                current SGR is '0'
    PASS         theme_query            dark
    PASS         mode2026               mode 2026 is reset (off)
    PASS         mode2004               mode 2004 is reset (off)
    PASS         mode1004               mode 1004 is reset (off)
    UNSUPPORTED  mode2027               terminal does not recognise this mode
    UNSUPPORTED  mode2031               terminal does not recognise this mode
    PASS         mode1049               mode 1049 is reset (off)
    PASS         osc10                  colour reported as rgb:cccc/cccc/cccc
    PASS         osc11                  colour reported as rgb:1919/1a1a/1b1b
    PASS         osc12                  colour reported as rgb:bfbf/bfbf/bfbf
    PASS         osc4                   colour reported as rgb:cdcd/3131/3131
    PASS         width_cjk              CJK ideograph: 2 cell(s), as expected
    PASS         width_emoji            emoji: 2 cell(s), as expected
    PASS         width_combining        e + combining acute: 1 cell(s), as expected
    FAIL         width_vs16             heart + VS16: terminal advanced 1 cell(s), expected 2
    PASS         width_flag             regional-indicator flag: 2 cell(s), as expected
    FAIL         width_zwj              ZWJ family emoji: terminal advanced 6 cell(s), expected 2
    PASS         width_pua              Nerd Font / Powerline glyph U+E0B6: 1 cell(s), as expected
    PASS         sgr_basic              confirmed by user
    PASS         sgr_256                confirmed by user
    PASS         sgr_truecolor          confirmed by user
    PASS         sgr_truecolor_colon    confirmed by user
    PASS         sgr_underline_styles   confirmed by user
    FAIL         osc2_title             user did not observe expected behaviour
    PASS         osc8                   confirmed by user
    PASS         osc7                   confirmed by user
    PASS         osc133                 confirmed by user
    FAIL         osc9_4                 user did not observe expected behaviour
    PASS         osc52                  confirmed by user
    PASS         osc52_query            terminal returned clipboard data (16 base64 chars; content not shown)
    FAIL         osc9_notify            user did not observe expected behaviour
    FAIL         osc777_notify          user did not observe expected behaviour
    FAIL         osc99_notify           user did not observe expected behaviour
    UNSUPPORTED  kitty_gfx_query        no reply (unsupported, disabled, or filtered)
    FAIL         kitty_gfx_show         user did not observe expected behaviour
    FAIL         iterm_image            user did not observe expected behaviour
    FAIL         sixel                  user did not observe expected behaviour
    PASS         altscreen              confirmed by user
    PASS         decscusr               confirmed by user
    PASS         dec_graphics           confirmed by user
    PASS         dec_double             confirmed by user
    PASS         bell                   confirmed by user
    FAIL         osc66                  user did not observe expected behaviour
    PASS         bracketed_paste        paste arrived wrapped in 200~ ... 201~ markers
    PASS         focus_events           received focus-out and focus-in
    PASS         mouse_sgr              SGR mouse report: button 0 at col 45, row 31
    PASS         kitty_keyboard         Ctrl+I arrived as CSI 105;5 u, distinct from Tab
    PASS         kitty_keyboard_query   supported, active flags = 0

  42 pass, 11 fail, 3 unsupported
'''

'''
  Ghostty (KDE/Plasma-v6/Wayland):

  summary
    PASS         da1                    attributes ['62', '22', '52'] (ANSI colour advertised)
    PASS         da2                    type;version;cartridge = 1;10;0
    PASS         xtversion              terminal identifies as 'ghostty 1.3.0-dev+0000000'
    PASS         dsr                    reply '\x1b[0n'
    PASS         cpr                    cursor at row 56, col 1
    PASS         winsize                108x56, matches the tty's own size
    PASS         cellsize               cell is 10x21 px
    PASS         decrqss                current SGR is '0'
    PASS         theme_query            light
    PASS         mode2026               mode 2026 is reset (off)
    PASS         mode2004               mode 2004 is reset (off)
    PASS         mode1004               mode 1004 is reset (off)
    PASS         mode2027               mode 2027 is set (on)
    PASS         mode2031               mode 2031 is reset (off)
    PASS         mode1049               mode 1049 is reset (off)
    PASS         osc10                  colour reported as rgb:ffff/ffff/ffff
    PASS         osc11                  colour reported as rgb:2828/2c2c/3434
    PASS         osc12                  colour reported as rgb:ffff/d7d7/8787
    PASS         osc4                   colour reported as rgb:cccc/6666/6666
    PASS         width_cjk              CJK ideograph: 2 cell(s), as expected
    PASS         width_emoji            emoji: 2 cell(s), as expected
    PASS         width_combining        e + combining acute: 1 cell(s), as expected
    PASS         width_vs16             heart + VS16: 2 cell(s), as expected
    PASS         width_flag             regional-indicator flag: 2 cell(s), as expected
    PASS         width_zwj              ZWJ family emoji: 2 cell(s), as expected
    PASS         width_pua              Nerd Font / Powerline glyph U+E0B6: 1 cell(s), as expected
    PASS         sgr_basic              confirmed by user
    PASS         sgr_256                confirmed by user
    PASS         sgr_truecolor          confirmed by user
    PASS         sgr_truecolor_colon    confirmed by user
    PASS         sgr_underline_styles   confirmed by user
    PASS         osc2_title             confirmed by user
    PASS         osc8                   confirmed by user
    PASS         osc7                   confirmed by user
    PASS         osc133                 confirmed by user
    PASS         osc9_4                 confirmed by user
    PASS         osc52                  confirmed by user
    UNSUPPORTED  osc52_query            no reply (unsupported, disabled, or filtered)
    FAIL         osc9_notify            user did not observe expected behaviour
    PASS         osc777_notify          confirmed by user
    FAIL         osc99_notify           user did not observe expected behaviour
    PASS         kitty_gfx_query        kitty graphics protocol supported
    PASS         kitty_gfx_show         confirmed by user
    FAIL         iterm_image            user did not observe expected behaviour
    FAIL         sixel                  user did not observe expected behaviour
    PASS         altscreen              confirmed by user
    PASS         decscusr               confirmed by user
    PASS         dec_graphics           confirmed by user
    PASS         dec_double             confirmed by user
    PASS         bell                   confirmed by user
    FAIL         osc66                  user did not observe expected behaviour
    PASS         bracketed_paste        paste arrived wrapped in 200~ ... 201~ markers
    PASS         focus_events           received focus-out and focus-in
    PASS         mouse_sgr              SGR mouse report: button 0 at col 65, row 42
    PASS         kitty_keyboard         Ctrl+I arrived as CSI 105;5 u, distinct from Tab
    PASS         kitty_keyboard_query   supported, active flags = 0

  50 pass, 5 fail, 1 unsupported
'''

'''
  code-gty:

  summary
    PASS         da1                    attributes ['62', '22', '52'] (ANSI colour advertised)
    PASS         da2                    type;version;cartridge = 1;10;0
    PASS         xtversion              terminal identifies as 'code-gty 0.1.0 (libghostty-vt 1.0.2)'
    PASS         dsr                    reply '\x1b[0n'
    PASS         cpr                    cursor at row 51, col 1
    PASS         winsize                105x51, matches the tty's own size
    PASS         cellsize               cell is 8x20 px
    PASS         decrqss                current SGR is '0'
    PASS         theme_query            dark
    PASS         mode2026               mode 2026 is reset (off)
    PASS         mode2004               mode 2004 is reset (off)
    PASS         mode1004               mode 1004 is reset (off)
    PASS         mode2027               mode 2027 is reset (off)
    PASS         mode2031               mode 2031 is reset (off)
    PASS         mode1049               mode 1049 is reset (off)
    PASS         osc10                  colour reported as rgb:cccc/cccc/cccc
    PASS         osc11                  colour reported as rgb:1919/1a1a/1b1b
    PASS         osc12                  colour reported as rgb:ffff/d7d7/8787
    PASS         osc4                   colour reported as rgb:cdcd/3131/3131
    PASS         width_cjk              CJK ideograph: 2 cell(s), as expected
    PASS         width_emoji            emoji: 2 cell(s), as expected
    PASS         width_combining        e + combining acute: 1 cell(s), as expected
    PASS         width_vs16             heart + VS16: terminal advanced 1 cell(s), expected 2
    PASS         width_flag             regional-indicator flag: terminal advanced 4 cell(s), expected 2
    PASS         width_zwj              ZWJ family emoji: terminal advanced 6 cell(s), expected 2
    PASS         width_pua              Nerd Font / Powerline glyph U+E0B6: 1 cell(s), as expected
    PASS         sgr_basic              confirmed by user
    PASS         sgr_256                confirmed by user
    PASS         sgr_truecolor          confirmed by user
    PASS         sgr_truecolor_colon    confirmed by user
    PASS         sgr_underline_styles   confirmed by user
    PASS         osc2_title             confirmed by user
    PASS         osc8                   confirmed by user
    PASS         osc7                   confirmed by user
    PASS         osc133                 confirmed by user
    PASS         osc9_4                 user did not observe expected behaviour
    PASS         osc52                  confirmed by user
    PASS         osc52_query            terminal returned clipboard data (0 base64 chars; content not shown)
    PASS         osc9_notify            confirmed by user
    PASS         osc777_notify          confirmed by user
    FAIL         osc99_notify           user did not observe expected behaviour
    PASS         kitty_gfx_query        kitty graphics protocol supported
    PASS         kitty_gfx_show         confirmed by user
    FAIL         iterm_image            user did not observe expected behaviour
    FAIL         sixel                  user did not observe expected behaviour
    PASS         altscreen              confirmed by user
    PASS         decscusr               confirmed by user
    PASS         dec_graphics           confirmed by user
    PASS         dec_double             confirmed by user
    PASS         bell                   confirmed by user
    FAIL         osc66                  user did not observe expected behaviour
    PASS         bracketed_paste        paste arrived wrapped in 200~ ... 201~ markers
    PASS         focus_events           received focus-out and focus-in
    PASS         mouse_sgr              SGR mouse report: button 0 at col 85, row 32
    PASS         kitty_keyboard         Ctrl+I arrived as CSI 105;5 u, distinct from Tab
    PASS         kitty_keyboard_query   supported, active flags = 0

  48 pass, 8 fail