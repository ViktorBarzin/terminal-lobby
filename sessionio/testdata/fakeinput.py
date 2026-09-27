#!/usr/bin/env python3
"""A stand-in for Claude Code's input box, for submit_test.go.

It draws the box the way Claude Code 2.1.283 does (a rule, the line under the
prompt mark, a rule, a status line) and takes the keys Injector.Prompt sends:
C-e, C-u, a bracketed paste and Enter. A submitted line is printed above the
box as SUBMITTED=<text>.

FAKEINPUT_SWALLOW=N makes it ignore the first N Enters that arrive while the
box holds text. That is the defect being guarded against: measured 2026-09-27,
a prompt pasted into a live session stayed on its input line with the Enter
gone, and the send reported success.

It is a model of that contract, not of the CLI.
"""

import os
import sys
import termios
import tty

SWALLOW = int(os.environ.get("FAKEINPUT_SWALLOW", "0"))
# Printed once raw mode is on, so the test waits on it rather than sleeping.
READY = "INPUT-READY"
RULE = "─" * 60


def out(s):
    sys.stdout.write(s)
    sys.stdout.flush()


def draw(submitted, line):
    out("\x1b[2J\x1b[H")
    out(READY + "\r\n")
    for s in submitted:
        out("SUBMITTED=%s\r\n" % s)
    out("\r\n" + RULE + " ↯ ─\r\n")
    out("❯ %s\r\n" % line)
    out(RULE + "\r\n")
    out("  ⏸ manual mode on\r\n")


def read1():
    b = sys.stdin.buffer.read(1)
    return b.decode("utf-8", "replace") if b else ""


def main():
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)
    tty.setraw(fd)
    swallow = SWALLOW
    try:
        submitted = []
        line = ""
        draw(submitted, line)
        while True:
            ch = read1()
            if ch == "":
                return
            if ch in ("\r", "\n"):
                if line and swallow > 0:
                    swallow -= 1
                elif line:
                    submitted.append(line)
                    line = ""
            elif ch == "\x15":  # C-u
                line = ""
            elif ch == "\x05":  # C-e: the cursor is always at the end here
                pass
            elif ch == "\x1b":
                # A bracketed-paste marker, ESC [ 2 0 0 ~ or ESC [ 2 0 1 ~.
                while read1() not in ("~", ""):
                    pass
            else:
                line += ch
            draw(submitted, line)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)


if __name__ == "__main__":
    main()
