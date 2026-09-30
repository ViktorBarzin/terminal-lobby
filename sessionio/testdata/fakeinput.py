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

FAKEINPUT_HISTORY is the last prompt submitted, backslash-n standing for a
break. Up on an empty box with nothing queued recalls it into the box and
titles the rule above the box "History 1/1", and Down goes back to the empty
box, as CLI 2.1.284 was measured to on 2026-09-29. That is what Up does once
Claude has taken the queued prompt a Stop meant to hand back: the box shows
the same words, recalled rather than popped. Submitted prompts join it.

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
round 4, 2026-09-28). FAKEINPUT_DIALOG=enter draws it as the Enter arrives
and takes that Enter as nothing, keeping the text out of sight: the live
check of the fix found a prompt lost that way, with no row picked.
FAKEINPUT_DIALOG=start has it up from the start. The paste mode turns bracketed paste on, which tmux
needs to mark a paste's start. While it is up, Enter picks its highlighted row and a
digit picks that row, each printed as ANSWERED=<row>, and a paste is ignored.

FAKEINPUT_IMAGE_MS holds a delay in ms for each picture, separated by ",": a
bracketed paste that ends with an absolute path to a picture is held back and
drawn that much later as "[Image #N]" followed by the rest of the paste,
appended to whatever the box holds by then. That is how CLI 2.1.283 was
measured to attach a pasted picture on 2026-09-29: nothing shows while it
reads the file, a 12 MB JPEG took 240 ms where a small PNG took 25 ms, and the
placeholder lands at the end of the box, after words pasted in the meantime.
A picture past the end of the list takes the last delay.

FAKEINPUT_TURN_MS models Claude's turn, for the Stop replay
(session-events/stopreplay_test.go). A prompt submitted with no turn running
opens one, and Claude has written something for it FAKEINPUT_TURN_MS later,
printed as REPLIED=<prompt>. A prompt submitted while a turn runs is queued
instead (QUEUED=), as Claude Code queues typed input mid-turn. C-c before the
reply takes the turn's prompts out of the conversation (their SUBMITTED= lines
go, and each is printed as REWOUND=) and puts them back on the input line
FAKEINPUT_RESTORE_MS later, joined by line breaks, as CLI 2.1.283 was measured
to on 2026-09-28; C-c after the reply leaves them where they are. Either way
what is still queued runs as the next turn. A line break inside a bracketed
paste is a line break in the box rather than a submit. The SUBMITTED= lines
are then the conversation.

FAKEINPUT_TEAR_MS draws the frame an Enter submits in two writes that far
apart, so a read in between sees it half drawn: the rows above the cut are
the new frame and the rows below are the last one, with no whole input box
anywhere. That is what the Stop replay caught in CI on 2026-09-30: a capture
taken while tmux had read only part of a long prompt's frame showed the rule
above the box half overwritten and the old box's rows under it, and a
re-read a moment later showed the empty box. A pty hands a big frame over in
pieces, and tmux draws each piece as it reads it.

It is a model of that contract, not of the CLI.
"""

import os
import re
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
HISTORY = [h for h in [os.environ.get("FAKEINPUT_HISTORY", "").replace("\\n", "\n")] if h]
IMAGE_S = [
    int(ms) / 1000.0 for ms in os.environ.get("FAKEINPUT_IMAGE_MS", "").split(",") if ms
]
TEAR_S = int(os.environ.get("FAKEINPUT_TEAR_MS", "0")) / 1000.0
TURN_S = (
    int(os.environ["FAKEINPUT_TURN_MS"]) / 1000.0 if os.environ.get("FAKEINPUT_TURN_MS") else None
)
PICTURE_END = re.compile(r"(?i)(?:^|\s)/\S+\.(?:png|jpe?g|gif|webp)$")
# How wide the box's rows are when the turn is modelled, inside a 120-column
# pane.
BOX_WIDTH = 100
# Printed once raw mode is on, so the test waits on it rather than sleeping.
READY = "INPUT-READY"
RULE = "─" * 60


# A frame being drawn, written out in one go by flush_frame: a screen
# redrawn in many small writes can be captured half drawn.
FRAME = []
# The next frame is written in two halves, TEAR_S apart (FAKEINPUT_TEAR_MS).
TEAR = {"next": False}


def out(s):
    FRAME.append(s)


def flush_frame():
    if FRAME:
        # Drawn over the last frame rather than onto a cleared screen, each
        # row erased to its end and the rest of the screen after the last,
        # the way Claude Code repaints: a pty can hand a big frame over in
        # pieces, and a cleared screen caught between two of them has no box.
        frame = "".join(FRAME).replace("\x1b[2J\x1b[H", "\x1b[H")
        frame = frame.replace("\r\n", "\x1b[K\r\n") + "\x1b[K\x1b[J"
        FRAME.clear()
        if TEAR["next"] and TEAR_S > 0:
            TEAR["next"] = False
            # Cut on a row's end, halfway down, so the rows above are the new
            # frame's and every row below is still the last frame's.
            rows = frame.split("\r\n")
            half = len(rows) // 2
            os.write(sys.stdout.fileno(), ("\r\n".join(rows[:half]) + "\r\n").encode("utf-8"))
            time.sleep(TEAR_S)
            frame = "\r\n".join(rows[half:])
        os.write(sys.stdout.fileno(), frame.encode("utf-8"))


def draw(*args, **kwargs):
    render(*args, **kwargs)
    flush_frame()


def render(submitted, line, queue, interrupted, hidden=False, dialog=False, answered=(), recalled=False, turn=None, rewound=()):
    out("\x1b[2J\x1b[H")
    out(READY + "\r\n")
    for s in submitted:
        out("SUBMITTED=%s\r\n" % s.replace("\n", "⏎"))
    for s in rewound:
        out("REWOUND=%s\r\n" % s.replace("\n", "⏎"))
    if turn is not None and turn["replied"]:
        out("REPLIED=%s\r\n" % "⏎".join(turn["prompts"]).replace("\n", "⏎"))
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
    if recalled:
        out("\r\n─── History %d/%d " % (len(HISTORY), len(HISTORY)) + RULE + "\r\n")
    else:
        out("\r\n" + RULE + " ↯ ─\r\n")
    rows = line.split("\n")
    if TURN_S is not None:
        # Claude Code wraps a long row itself, under the text rather than
        # under the prompt mark, where tmux would wrap it at the pane's edge.
        rows = [r[i : i + BOX_WIDTH] for r in rows for i in range(0, max(len(r), 1), BOX_WIDTH)]
    if BOX_ROWS > 0:
        rows = rows[-BOX_ROWS:]
    out("❯ %s\r\n" % rows[0])
    for row in rows[1:]:
        out("  %s\r\n" % row)
    out(RULE + "\r\n")
    out("  ⏸ manual mode on\r\n")


def read1():
    # Straight off the descriptor: a buffered read takes everything waiting
    # and hands back one byte, and the select() that waits on a timer then
    # sees nothing left to read, so the rest of a paste sat unseen until the
    # timer fired.
    b = os.read(sys.stdin.fileno(), 1)
    return b.decode("utf-8", "replace") if b else ""


def main():
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)
    tty.setraw(fd)
    if DIALOG == "paste" or IMAGE_S or TURN_S is not None:
        # Bracketed paste mode, so tmux marks where a paste starts.
        out("\x1b[?2004h")
        flush_frame()
    swallow = SWALLOW
    queue = list(QUEUE)
    interrupted = False
    dialog = DIALOG == "start"
    pasting = False
    answered = []
    # The box holds a prompt recalled from history (FAKEINPUT_HISTORY).
    recalled = False
    # Pictures being read: (when it attaches, what it draws), and the text of
    # the paste under way, kept only when pictures are modelled.
    attaching = []
    pictures = 0
    pasted = None
    # Claude's turn (FAKEINPUT_TURN_MS): the prompts it opened with, when
    # Claude writes something for them, and whether it has. None at idle.
    turn = None
    rewound = []
    try:
        submitted = []
        line = os.environ.get("FAKEINPUT_LINE", "").replace("\\n", "\n")
        draw(submitted, line, queue, interrupted)
        running = RUNNING
        restore_at = None
        hide_until = None
        while True:
            timers = [t for t in (restore_at, hide_until) if t is not None]
            timers += [t for t, _ in attaching]
            if turn is not None and not turn["replied"]:
                timers.append(turn["reply_at"])
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
                    for t, text in [a for a in attaching if a[0] <= now]:
                        line += text
                        attaching.remove((t, text))
                    if turn is not None and not turn["replied"] and now >= turn["reply_at"]:
                        turn["replied"] = True
                    draw(submitted, line, queue, interrupted, hide_until is not None, dialog, answered, recalled, turn, rewound)
                    continue
            ch = read1()
            if ch == "":
                return
            if DIALOG == "enter" and not dialog and not answered and line and ch in ("\r", "\n"):
                dialog = True
            elif dialog and pasting and ch != "\x1b":
                pass
            elif dialog and ch in ("\r", "\n"):
                answered.append("1")
                dialog = False
            elif dialog and ch in ("1", "2"):
                answered.append(ch)
                dialog = False
            elif pasting and TURN_S is not None and ch in ("\r", "\n"):
                line += "\n"
                if pasted is not None:
                    pasted += "\n"
            elif ch in ("\r", "\n"):
                if line and swallow > 0:
                    swallow -= 1
                elif line and TURN_S is not None and turn is not None:
                    queue.append(line)
                    HISTORY.append(line)
                    line = ""
                    recalled = False
                elif line:
                    submitted.append(line)
                    HISTORY.append(line)
                    TEAR["next"] = True
                    if TURN_S is not None:
                        turn = {"prompts": [line], "reply_at": time.monotonic() + TURN_S, "replied": False}
                    line = ""
                    recalled = False
            elif ch == "\x15":  # C-u kills the last line only, as Claude's does
                line = line[: line.rfind("\n") + 1]
            elif ch == "\x05":  # C-e: the cursor is always at the end here
                if DIALOG == "clear" and not answered:
                    dialog = True
            elif ch == "\x7f":  # Backspace
                line = line[:-1]
            elif ch == "\x03" and TURN_S is not None:
                # C-c on a modelled turn: an unanswered one goes back to the
                # input line, and what is queued runs as the next turn.
                if turn is not None and not turn["replied"]:
                    for p in turn["prompts"]:
                        if p in submitted:
                            del submitted[len(submitted) - 1 - submitted[::-1].index(p)]
                        rewound.append(p)
                    running = "\n".join(turn["prompts"]) + running
                    restore_at = time.monotonic() + RESTORE_S
                turn = None
                if queue:
                    submitted.extend(queue)
                    turn = {"prompts": list(queue), "reply_at": time.monotonic() + TURN_S, "replied": False}
                    queue = []
                interrupted = True
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
                if seq == "200~":
                    pasting = True
                    if IMAGE_S:
                        pasted = ""
                    if DIALOG == "paste" and not answered:
                        dialog = True
                if seq == "201~":
                    pasting = False
                    m = PICTURE_END.search(pasted or "")
                    if m:
                        delay = IMAGE_S[min(pictures, len(IMAGE_S) - 1)]
                        pictures += 1
                        line = line[: len(line) - len(pasted)]
                        rest = pasted[: m.start()]
                        attaching.append(
                            (time.monotonic() + delay, "[Image #%d]%s" % (pictures, rest))
                        )
                    pasted = None
                if seq == "A" and not line and queue:
                    line = "\n".join(queue)
                    queue = []
                elif seq == "A" and not line and HISTORY:
                    line = HISTORY[-1]
                    recalled = True
                if seq == "B" and recalled:
                    line = ""
                    recalled = False
            elif not dialog:
                line += ch
                if pasted is not None:
                    pasted += ch
            draw(submitted, line, queue, interrupted, hide_until is not None, dialog, answered, recalled, turn, rewound)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)


if __name__ == "__main__":
    main()
