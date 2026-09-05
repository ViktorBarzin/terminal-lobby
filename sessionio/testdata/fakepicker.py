#!/usr/bin/env python3
"""A stand-in for a CLI's model picker, for setmodel_test.go.

It draws the same shape Claude Code 2.1.261 draws — the fixture next door is a
capture of the real one — and answers the same keys: ↑/↓ move, `s` commits for
the session, Esc backs out. Nothing here is a model of the CLI; it is a model of
the CONTRACT the driver relies on, which is that a list can be pinned at its
top, walked one row at a time, and read back between steps.

It runs in raw mode from the first byte so that a bracketed paste (which is how
the driver types the command) arrives as ordinary bytes rather than as line
editing.
"""

import sys
import termios
import tty

MODELS = [
    ("Default (recommended)", "Sonnet 5 · Efficient for routine tasks"),
    ("Sonnet", "Sonnet 5 · Efficient for routine tasks"),
    ("Opus ✔", "Opus 5 · Best for everyday, complex tasks"),
    ("Haiku", "Haiku 4.5 · Fastest for quick answers"),
]
FOOTER = "Enter to set as default · s to use this session only · Esc to cancel"


def out(s):
    sys.stdout.write(s)
    sys.stdout.flush()


def draw(at):
    out("\x1b[2J\x1b[H")
    out("   Select model\r\n\r\n")
    for i, (label, desc) in enumerate(MODELS):
        cursor = "❯" if i == at else " "
        out("   %s %d. %-24s %s\r\n" % (cursor, i + 1, label, desc))
    out("\r\n   %s\r\n" % FOOTER)


def chose(label):
    out("\x1b[2J\x1b[H")
    out("MODEL=%s\r\n" % label.replace(" ✔", ""))


def read1():
    b = sys.stdin.buffer.read(1)
    return b.decode("utf-8", "replace") if b else ""


def main():
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)
    tty.setraw(fd)
    try:
        line = ""
        at = 2  # the picker opens on the model in force, as the real one does
        picking = False
        while True:
            ch = read1()
            if ch == "":
                return
            if not picking:
                if ch in ("\r", "\n"):
                    if "/model" in line:
                        picking = True
                        draw(at)
                    line = ""
                elif ch == "\x15":  # C-u clears the line, as a shell would
                    line = ""
                elif ch == "\x1b":
                    # A bracketed-paste marker; swallow it up to the ~.
                    while read1() not in ("~", ""):
                        pass
                else:
                    line += ch
                continue
            if ch == "\x1b":
                nxt = read1()
                if nxt != "[":
                    out("\x1b[2J\x1b[H")
                    picking = False
                    continue
                key = read1()
                if key == "A":
                    at = max(0, at - 1)
                elif key == "B":
                    at = min(len(MODELS) - 1, at + 1)
                draw(at)
            elif ch == "s":
                chose(MODELS[at][0])
                picking = False
            elif ch in ("\r", "\n"):
                # Enter is the CLI's "set as default", which the driver must
                # never press. Recorded so a test can prove it did not.
                out("\x1b[2J\x1b[H")
                out("DEFAULT=%s\r\n" % MODELS[at][0].replace(" ✔", ""))
                picking = False
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)


main()
