#!/usr/bin/env python3
import sys
E = "\x1b"
def p(s=""): sys.stdout.write(s + "\n")
L, R = "\ue0b6", "\ue0b4"

p("== cell ruler (arches should sit under digits) ==")
p("0123456789"); p(L * 10); p("A" + L + "B" + R + "C")

p("\n== pill ==")
p(f"{E}[38;2;90;140;220m{L}{E}[48;2;90;140;220;38;2;0;0;0m session {E}[0m{E}[38;2;90;140;220m{R}{E}[0m")

p("\n== truecolor gradient (should be smooth, no banding) ==")
p("".join(f"{E}[48;2;{int(255*i/79)};{int(255*(1-i/79))};128m {E}[0m" for i in range(80)))

p("\n== 256-colour cube ==")
p("".join(f"{E}[48;5;{n}m {E}[0m" for n in range(16, 232)))

p("\n== text styles ==")
p(f"{E}[1mbold{E}[0m {E}[2mdim{E}[0m {E}[3mitalic{E}[0m {E}[4munderline{E}[0m "
  f"{E}[4:3mcurly{E}[0m {E}[4:3;58;2;255;0;0mred curly{E}[0m {E}[9mstrike{E}[0m {E}[7mreverse{E}[0m")

p("\n== OSC 8 hyperlink ==")
p(f"{E}]8;;https://example.com{E}\\clickable link{E}]8;;{E}\\")

p("\n== width and shaping ==")
p("CJK: 日本語 | emoji: 👍 🚀 | flag: 🇬🇧 | combining: e\u0301 | ZWJ: 👨‍👩‍👧")
p("ligatures: -> => != === <= >= :: |> <|>")

p("\n== nerd font icons, each followed by a letter ==")
p(" ".join(chr(c) + "x" for c in (0xf1ae, 0xe795, 0xf496, 0xf274, 0xf2c9, 0xf0ce, 0xf2db)))