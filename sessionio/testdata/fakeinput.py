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

FAKEINPUT_QUEUE holds prompts Claude Code has queued mid-turn, separated by
"|", with a literal backslash-n standing for a line break inside one. They
behave as CLI 2.1.283 was measured to on 2026-09-27: Up on an empty box pops
them all into the box, joined by line breaks (the transcript's "popAll"), and
C-c interrupts and SUBMITS whatever is still queued as the next turn. The
interrupt is printed as INTERRUPTED, and each prompt still waiting as
QUEUED=<text>.

FAKEINPUT_LINE seeds the box with text already on it, backslash-n again
standing for a break: the interrupted prompt Claude Code puts back on its input
line after a Stop, which wraps over more than one line when it is long.

FAKEINPUT_RUNNING is the prompt of a turn Claude has written nothing for yet.
C-c puts it back on the input line FAKEINPUT_RESTORE_MS later (default 150),
as CLI 2.1.283 was measured to on 2026-09-28: 40 to 270 ms after the interrupt.

FAKEINPUT_HIDE_MS draws no input box for that long after a C-c: something
else is drawn in its place, as Claude Code's own feedback-draft panel was over
a scratch session in the round 7 check on 2026-09-28 ("1 to review · 2 to send
· 0 to dismiss" where the box had been).

FAKEINPUT_BOX_ROWS=N draws at most the last N rows of the box, as Claude
Code's box does for a prompt taller than it: measured on CLI 2.1.283 on
2026-09-28, a 954-character prompt with 4 line breaks showed only its last 10
rows, the first starting with the prompt mark, and nothing above them.

FAKEINPUT_DIALOG=paste or FAKEINPUT_DIALOG=clear draws a permission dialog in
the box's place the moment a bracketed paste starts, or the moment a C-e
arrives: Claude drawing a prompt while a send is on its way (deployed review
round 4, 2026-09-28). While it is up, Enter picks its highlighted row and a
digit picks that row, each printed as ANSWERED=<row>, and a paste is ignored.

It is a model of that contract, not of the CLI.
"""

import os
import select
import sys
import termios
import time
import tty

SWALLOW = int(os.environ.get("FAKEINPUT_SWALLOW", "0"))
QUEUE = [
    q.replace("\\n", "\n")
    for q in os.environ.get("FAKEINPUT_QUEUE", "").split("|")
    if q
]
RUNNING = os.environ.get("FAKEINPUT_RUNNING", "").replace("\\n", "\n")
RESTORE_S = int(os.environ.get("FAKEINPUT_RESTORE_MS", "150")) / 1000.0
HIDE_S = int(os.environ.get("FAKEINPUT_HIDE_MS", "0")) / 1000.0
BOX_ROWS = int(os.environ.get("FAKEINPUT_BOX_ROWS", "0"))
DIALOG = os.environ.get("FAKEINPUT_DIALOG", "")
# Printed once raw mode is on, so the test waits on it rather than sleeping.
READY = "INPUT-READY"
RULE = "─" * 60


def out(s):
    sys.stdout.write(s)
    sys.stdout.flush()


def draw(submitted, line, queue, interrupted, hidden=False, dialog=False, answered=()):
    out("\x1b[2J\x1b[H")
    out(READY + "\r\n")
    for s in submitted:
        out("SUBMITTED=%s\r\n" % s.replace("\n", "⏎"))
    for a in answered:
        out("ANSWERED=%s\r\n" % a)
    for q in queue:
        out("QUEUED=%s\r\n" % q.replace("\n", "⏎"))
    if interrupted:
        out("INTERRUPTED\r\n")
    if hidden:
        out("\r\n| A panel where the box was\r\n| 1 to review · 0 to dismiss\r\n")
        return
    if dialog:
        out("\r\n" + RULE + "\r\n Bash command\r\n\r\n   rm -rf build\r\n\r\n")
        out(" Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n")
        return
    out("\r\n" + RULE + " ↯ ─\r\n")
    rows = line.split("\n")
    if BOX_ROWS > 0:
        rows = rows[-BOX_ROWS:]
    out("❯ %s\r\n" % rows[0])
    for row in rows[1:]:
        out("  %s\r\n" % row)
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
    queue = list(QUEUE)
    interrupted = False
    dialog = False
    answered = []
    try:
        submitted = []
        line = os.environ.get("FAKEINPUT_LINE", "").replace("\\n", "\n")
        draw(submitted, line, queue, interrupted)
        running = RUNNING
        restore_at = None
        hide_until = None
        while True:
            timers = [t for t in (restore_at, hide_until) if t is not None]
            if timers:
                wait = max(0.0, min(timers) - time.monotonic())
                ready, _, _ = select.select([fd], [], [], wait)
                if not ready:
                    now = time.monotonic()
                    if restore_at is not None and now >= restore_at:
                        line = running + line
                        running = ""
                        restore_at = None
                    if hide_until is not None and now >= hide_until:
                        hide_until = None
                    draw(submitted, line, queue, interrupted, hide_until is not None, dialog, answered)
                    continue
            ch = read1()
            if ch == "":
                return
            if dialog and ch in ("\r", "\n"):
                answered.append("1")
                dialog = False
            elif dialog and ch in ("1", "2"):
                answered.append(ch)
                dialog = False
            elif ch in ("\r", "\n"):
                if line and swallow > 0:
                    swallow -= 1
                elif line:
                    submitted.append(line)
                    line = ""
            elif ch == "\x15":  # C-u kills the last line only, as Claude's does
                line = line[: line.rfind("\n") + 1]
            elif ch == "\x05":  # C-e: the cursor is always at the end here
                if DIALOG == "clear" and not answered:
                    dialog = True
            elif ch == "\x7f":  # Backspace
                line = line[:-1]
            elif ch == "\x03":  # C-c: interrupt, and run what is queued
                submitted.extend(queue)
                queue = []
                interrupted = True
                if running:
                    restore_at = time.monotonic() + RESTORE_S
                if HIDE_S > 0:
                    hide_until = time.monotonic() + HIDE_S
            elif ch == "\x1b":
                # A CSI sequence: ESC [ params final. Up is ESC [ A; the
                # bracketed-paste markers are ESC [ 2 0 0 ~ and ESC [ 2 0 1 ~.
                if read1() != "[":
                    continue
                seq = ""
                while True:
                    c = read1()
                    if c == "":
                        return
                    seq += c
                    if "\x40" <= c <= "\x7e":
                        break
                if seq == "200~" and DIALOG == "paste" and not answered:
                    dialog = True
                if seq == "A" and not line and queue:
                    line = "\n".join(queue)
                    queue = []
            elif not dialog:
                line += ch
            draw(submitted, line, queue, interrupted, hide_until is not None, dialog, answered)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)


if __name__ == "__main__":
    main()
