#!/usr/bin/env python3
import os, sys, select, termios, tty
E = "\x1b"; ST = E + "\\"

def ask(name, seq, wait=0.4):
    fd = sys.stdin.fileno(); old = termios.tcgetattr(fd)
    try:
        tty.setraw(fd); os.write(1, seq.encode())
        buf = b""
        while select.select([fd], [], [], wait)[0]:
            buf += os.read(fd, 4096)
            wait = 0.1
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)
    print(f"{name:28} {'YES ' + repr(buf.decode(errors='replace'))[:60] if buf else 'no reply'}")

print("== queries (reply expected) ==")
ask("OSC 10 fg colour",       f"{E}]10;?{ST}")
ask("OSC 11 bg colour",       f"{E}]11;?{ST}")
ask("OSC 4 palette entry 1",  f"{E}]4;1;?{ST}")
ask("XTVERSION",              f"{E}[>0q")
ask("DA1",                    f"{E}[c")
ask("kitty keyboard (CSI ? u)", f"{E}[?u")
ask("sync output (mode 2026)",f"{E}[?2026$p")
ask("kitty graphics",         f"{E}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA{ST}")

print("\n== visible effects (check by eye) ==")
sys.stdout.write(f"{E}]0;OSC 0 title test{ST}"); print("OSC 0/2: window/tab title should read 'OSC 0 title test'")
sys.stdout.write(f"{E}]8;;https://example.com{ST}OSC 8 link{E}]8;;{ST}\n")
sys.stdout.write(f"{E}]7;file://{os.uname().nodename}{os.getcwd()}{ST}"); print("OSC 7: cwd reported (new tab/split should open here)")
sys.stdout.write(f"{E}]9;OSC 9 notification{ST}"); print("OSC 9: desktop notification?")
sys.stdout.write(f"{E}]777;notify;Title;OSC 777 body{ST}"); print("OSC 777: desktop notification?")
sys.stdout.write(f"{E}]9;4;1;60{ST}"); print("OSC 9;4: progress bar at 60% (taskbar/tab)?")
sys.stdout.write(f"{E}]52;c;{__import__('base64').b64encode(b'osc52 works').decode()}{ST}"); print("OSC 52: clipboard should now contain 'osc52 works'")
sys.stdout.write(f"{E}]133;A{ST}"); print("OSC 133: prompt mark sent (shell integration jump-to-prompt)")
sys.stdout.write(f"{E}]9;4;0{ST}")