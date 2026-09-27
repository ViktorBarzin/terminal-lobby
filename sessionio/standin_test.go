package sessionio

import (
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The tmux stand-in the plan-approval and mode-dial tests drive: a python
// script drawing Claude Code's dialogs in a real pane, so the driver's keys and
// captures are exercised against a terminal rather than an imitation of one.

// dialogSeq keeps two stand-ins in one test binary off each other's socket,
// which -count=2 and a parallel run both need.
var dialogSeq atomic.Int64

func dialogSession(t *testing.T) (*Injector, string) {
	t.Helper()
	return dialogSessionEnv(t, "")
}

// dialogSessionEnv starts the stand-in with an environment prefix, for the
// variant that ignores every key.
func dialogSessionEnv(t *testing.T, env string) (*Injector, string) {
	t.Helper()
	return standIn(t, env, "Pick fruits")
}

// standIn starts the stand-in with an environment prefix and waits until the
// pane shows `ready`: the first question, the plan approval's question, or the
// input box's status line.
func standIn(t *testing.T, env, ready string) (*Injector, string) {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available")
	}
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 not available")
	}
	u, err := user.Current()
	if err != nil {
		t.Skip("no current user")
	}
	script := filepath.Join(t.TempDir(), "fakedialog.py")
	if err := os.WriteFile(script, []byte(fakeDialogPy), 0o600); err != nil {
		t.Fatalf("writing the stand-in: %v", err)
	}
	// A socket name nothing else can be holding: -L names a socket in a shared
	// directory, and a run that was interrupted leaves the file behind with no
	// server on it, which tmux then refuses to start a new one on.
	sock := fmt.Sprintf("sio-dialog-%d-%d", os.Getpid(), dialogSeq.Add(1))
	t.Cleanup(func() { killSock(sock) })
	if err := exec.Command("tmux", "-L", sock, "new-session", "-d", "-s", "demo",
		"-x", "100", "-y", "40", env+"python3 "+script).Run(); err != nil {
		t.Fatalf("new-session: %v", err)
	}
	in := NewInjectorOnSocket(u.Username, sock)
	// Wait for the first question to be on screen rather than sleeping at it.
	// Under load python3 takes longer to reach raw mode than any fixed sleep
	// worth writing, and a key sent before then is eaten by the line
	// discipline.
	deadline := time.Now().Add(20 * time.Second)
	for {
		pane, err := in.CapturePane(u.Username, "demo")
		if err == nil && strings.Contains(pane, ready) {
			return in, u.Username
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("the stand-in never drew %q; pane:\n%s", ready, pane)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// A stand-in for Claude Code's AskUserQuestion dialog. It is not a model of the
// CLI; it is a model of the CONTRACT the driver relies on, drawn the way CLI
// 2.1.280 draws it and answering keys the way that build answers them, as
// measured by driving real dialogs on 2026-09-23:
//
//   - a single-select question is answered by its digit, or by Enter on a row;
//   - on a multi-select every numbered row is a toggle, by Space, by Enter or
//     by its digit, and a digit leaves the cursor where it was;
//   - an unnumbered commit row under the free-text row is what leaves a
//     multi-select, "Next" on every question but the last and "Submit" on the
//     last, so a one-question call says "Submit"; Enter there commits even
//     with nothing ticked, and the question is left unanswered;
//   - a multi-select's free-text row is an inline field: printable keys and a
//     paste go into it and tick it, Space types a space, Backspace to empty
//     clears the box, and Enter flips the box and keeps the text;
//   - that field has a text cursor, and a walk onto the row with ↑ or ↓ puts
//     it at the START of the text: a typed "X" lands before the words and a
//     Backspace takes nothing out. Typing and a paste insert at it, so it is
//     at the end straight after a paste, and C-e moves it to the end of the
//     whole text, a wrapped one included (the live check, 2026-09-23);
//   - the tab box fills on the first pick and empties when none is left;
//   - the review screen follows the last question, for a one-question call
//     too, and is drawn with no footer;
//   - ← to an answered question opens a single-select on its pick, drawn
//     "2. Coffee ✔", and a multi-select on row one with its boxes kept;
//   - a run of arrows that arrives with the cursor on a multi-select's chat
//     row moves it one row, onto the commit row, and the rest of the run is
//     lost. One send-keys run of ↑ ↑ ↑ from there reached the commit row and
//     no further, four times out of four in the live check of 2026-09-24,
//     while three runs of one ↑ each reached Plum. A run from any other row
//     goes the whole way.
//
// The one assumption: a digit typed with the cursor on the free-text field
// goes into the field. Space does, measured, and nothing here presses a digit
// on a multi-select.
//
// It lives here rather than in testdata/ because it is the other half of these
// tests: the assertions above are meaningless without the exact key handling
// below, and a reader should not have to open two files to check one claim.
//
// Since 2026-09-24 it also draws Claude Code's plan approval
// (FAKEDIALOG_CALL=plan, for plandrive_test.go) and the idle input box with its
// permission mode (FAKEDIALOG_CALL=composer, for setmode_test.go), each as CLI
// 2.1.281 drew it that day, and since 2026-09-27 the tool permission prompt
// (FAKEDIALOG_CALL=permission, for permdrive_test.go) as CLI 2.1.283 draws it.
// What each models is listed in the script, beside the code that models it.
const fakeDialogPy = `#!/usr/bin/env python3
"""A stand-in AskUserQuestion dialog for answerdrive_test.go.

Raw mode from the first byte, so a bracketed paste (which is how the driver
types free text) arrives as ordinary bytes rather than as line editing.

It draws and answers keys the way Claude Code 2.1.280 does, as measured by
driving real dialogs on 2026-09-23. On a multi-select every numbered row is a
toggle, whether by Space, Enter or its digit, and none of them leaves the
question; an unnumbered commit row under the free-text row does, saying
"Next" on every question but the last and "Submit" on the last. The free-text
row of a multi-select is an inline field. A run of arrows that arrives with
the cursor on a multi-select's chat row moves it one row and loses the rest.

Input is read a send-keys run at a time: tmux writes one run to the pty in one
go, so one read takes it whole, and that is what lets a run lose its tail.
"""

import os
import sys
import termios
import time
import tty

DEAF = os.environ.get("FAKEDIALOG_DEAF") == "1"
# A full-frame repaint: erase, then take a quarter of a second over the next
# frame. Measured transitions are 63-154 ms on an idle box, so this is what a
# loaded one looks like to capture-pane: a screen with nothing on it.
BLINK = os.environ.get("FAKEDIALOG_BLINK") == "1"
# The cursor moves as ever and is drawn nowhere, so no reading can say which
# row it is on.
BLIND = os.environ.get("FAKEDIALOG_BLIND") == "1"

QS = [
    {"header": "Fruit", "text": "Pick fruits", "multi": True,
     "opts": ["Apple", "Pear", "Plum"]},
    {"header": "Drink", "text": "Pick one drink", "multi": False,
     "opts": ["Tea", "Coffee"]},
]
# Which screen to draw: a two-question call by default, "one" for the
# multi-select alone, "plan" for the plan approval, "composer" for the idle
# input box with its permission mode and "permission" for the tool permission
# prompt.
CALL = os.environ.get("FAKEDIALOG_CALL", "")
# A one-question call: the multi-select alone. Its commit row says "Submit",
# and it still goes to the review screen.
if CALL == "one":
    QS = QS[:1]
# The multi-select's options, comma-separated, for a test whose labels carry
# something the parser has to read around.
if os.environ.get("FAKEDIALOG_FRUIT"):
    QS[0]["opts"] = os.environ["FAKEDIALOG_FRUIT"].split(",")

RULE = "─" * 60

# The conversation above the dialog. A real capture carries the prompt that
# asked for the questions and whatever the call before it left behind, so both
# questions' text and the review wording are already on the pane before
# anything is answered. A comparison scoped to the whole capture matches them.
PREAMBLE = [
    "❯ Ask two questions: Fruit (Pick fruits) and Drink (Pick one drink).",
    "● I will put the four picks in front of you at the end, so you can",
    "  Review your answers",
    "  before any of them is sent.",
]

picks = [set() for _ in QS]      # the option labels ticked, per question
field = ["" for _ in QS]         # a multi-select's inline free-text field
field_on = [False for _ in QS]   # and its box
fpos = 0                         # the text cursor in the field on screen
typed = []                       # lines single-select free text leaves behind
at = 0                           # the question on screen; len(QS) is the review
cursor = 0
typing = False                   # a single-select's free-text field is open
buf = ""
run = bytearray()                # what is left of the send-keys run being read
run_on_chat = False              # that run arrived with the cursor on the chat row


def out(s):
    sys.stdout.write(s)
    sys.stdout.flush()


def multi():
    return at < len(QS) and QS[at]["multi"]


def nopts():
    return len(QS[at]["opts"])


def free_row():
    return nopts()


def commit_row():
    # The commit row sits directly under a multi-select's free-text row. A
    # single-select commits with its digit and draws none.
    return nopts() + 1 if multi() else -1


def rows():
    # Where the cursor can stop: the options, the free-text row, the commit
    # row on a multi-select, and the chat row.
    if at >= len(QS):
        return 2
    return nopts() + (3 if multi() else 2)


def chat_row():
    return rows() - 1


def answered(i):
    # The tab box fills on the first tick and empties when every box is clear.
    # A ticked free-text row with nothing typed does not fill it: the CLI
    # drops that pick at commit.
    if QS[i]["multi"]:
        return bool(picks[i]) or (field_on[i] and field[i] != "")
    return bool(picks[i])


def tabbar():
    parts = ["←"]
    for i, q in enumerate(QS):
        parts.append(("☒" if answered(i) else "☐") + " " + q["header"])
    parts.append("✔ Submit")
    parts.append("→")
    return "  ".join(parts)


def footer():
    parts = ["Enter to select"]
    parts.append("↑/↓ to navigate" if len(QS) == 1 else "Tab/Arrow keys to navigate")
    # Shown while the cursor is on the free-text or commit row of a
    # multi-select, and gone again on the option rows.
    if multi() and cursor in (free_row(), commit_row()):
        parts.append("ctrl+g to edit in Vim")
    parts.append("Esc to cancel")
    return " · ".join(parts)


def answer_of(i):
    q = QS[i]
    if not q["multi"]:
        return sorted(picks[i])
    got = [o for o in q["opts"] if o in picks[i]]
    if field_on[i] and field[i].strip():
        got.append(field[i].strip())
    return got


def mark(row):
    return "❯" if (row == cursor and not typing and not BLIND) else " "


def draw():
    out("\x1b[2J\x1b[H")
    for line in PREAMBLE + typed:
        out(line + "\r\n")
    out("\r\n")
    out(tabbar() + "\r\n\r\n")
    if at >= len(QS):
        # The review screen, which the CLI draws with NO footer.
        out("Review your answers\r\n\r\n")
        if all(answered(i) for i in range(len(QS))):
            for i, q in enumerate(QS):
                out(" ● " + q["text"] + "\r\n")
                out("   → " + ", ".join(answer_of(i)) + "\r\n")
        else:
            out("⚠ You have not answered all questions\r\n")
        out("\r\nReady to submit your answers?\r\n\r\n")
        out(mark(0) + " 1. Submit answers\r\n")
        out(mark(1) + " 2. Cancel\r\n")
        return
    q = QS[at]
    out(q["text"] + "\r\n\r\n")
    n = nopts()
    for i, o in enumerate(q["opts"]):
        if q["multi"]:
            box = "[✔] " if o in picks[at] else "[ ] "
            out("%s %d. %s%s\r\n" % (mark(i), i + 1, box, o))
        else:
            # A single-select revisited with the left arrow draws its earlier
            # pick with a tick.
            tick = " ✔" if o in picks[at] else ""
            out("%s %d. %s%s\r\n" % (mark(i), i + 1, o, tick))
    if q["multi"]:
        box = "[✔]" if field_on[at] else "[ ]"
        label = field[at] if field[at] != "" else "Type something"
        # The terminal keeps no trailing spaces, so a field holding only a
        # space reads "4. [✔]".
        out(("%s %d. %s %s" % (mark(n), n + 1, box, label)).rstrip() + "\r\n")
        out("%s    %s\r\n" % (mark(n + 1), "Submit" if at == len(QS) - 1 else "Next"))
    else:
        out("%s %d. Type something.\r\n" % (mark(n), n + 1))
    out(RULE + "\r\n")
    out("%s %d. Chat about this\r\n" % (mark(rows() - 1), n + 2))
    if typing:
        out("\r\n  > " + buf + "\r\n")
    out("\r\n" + footer() + "\r\n")


def advance():
    global at, cursor
    at += 1
    cursor = 0
    if BLINK:
        out("\x1b[2J\x1b[H")
        time.sleep(0.25)
    open_on_pick()


def back():
    global at, cursor, typing, buf
    if at == 0:
        return
    at -= 1
    typing = False
    buf = ""
    cursor = 0
    open_on_pick()


def open_on_pick():
    # A single-select question drawn again opens on the pick it holds. A
    # multi-select one opens on row one, its picks drawn as boxes.
    global cursor
    if at < len(QS) and not QS[at]["multi"]:
        chosen = [i for i, o in enumerate(QS[at]["opts"]) if o in picks[at]]
        if chosen:
            cursor = chosen[0]


def toggle(i):
    o = QS[at]["opts"][i]
    if o in picks[at]:
        picks[at].discard(o)
    else:
        picks[at].add(o)


def type_into_field(s):
    # Inserted at the text cursor, which then moves past it. A paste arrives
    # as ordinary bytes, one call per character, so it inserts the same way.
    global fpos
    field[at] = field[at][:fpos] + s + field[at][fpos:]
    fpos += len(s)
    field_on[at] = True


def backspace_field():
    # Takes out the character BEFORE the text cursor, so a Backspace with the
    # cursor at the start of the text takes out nothing.
    global fpos
    if fpos > 0:
        field[at] = field[at][:fpos - 1] + field[at][fpos:]
        fpos -= 1
        if field[at] == "":
            field_on[at] = False


def submitted():
    out("\x1b[2J\x1b[H")
    for line in PREAMBLE + typed:
        out(line + "\r\n")
    out("\r\n● SUBMITTED " + " | ".join(", ".join(answer_of(i)) for i in range(len(QS))) + "\r\n")


def byte():
    """The next byte of input, or None once there is no more."""
    global run, run_on_chat
    if not run:
        data = os.read(sys.stdin.fileno(), 4096)
        if not data:
            return None
        run = bytearray(data)
        run_on_chat = CALL not in ("plan", "composer", "permission") and multi() and cursor == chat_row()
    b = run[0]
    del run[0]
    return b


def read1():
    b = byte()
    if b is None:
        return ""
    extra = 3 if b >= 0xF0 else 2 if b >= 0xE0 else 1 if b >= 0xC0 else 0
    raw = bytes([b])
    for _ in range(extra):
        nb = byte()
        if nb is None:
            break
        raw += bytes([nb])
    return raw.decode("utf-8", "replace")


def skip_paste():
    """Consume a bracketed-paste marker. Returns True for the one that opens a
    paste, ESC [ 200 ~, and False for the one that closes it."""
    code = ""
    while True:
        c = read1()
        if c in ("~", ""):
            return code == "00"
        code += c


def multi_key(ch):
    """One key on a multi-select question."""
    global cursor, fpos
    n = nopts()
    on_field = cursor == free_row()
    if ch in ("\x7f", "\x08"):
        if on_field:
            backspace_field()
        return
    if ch == "\x05":
        # C-e: the text cursor to the end of the field's text.
        if on_field:
            fpos = len(field[at])
        return
    if ch in ("\r", "\n"):
        if cursor < n:
            toggle(cursor)
        elif on_field:
            field_on[at] = not field_on[at]
        elif cursor == commit_row():
            # Commits even with nothing ticked: the question is left
            # unanswered, and the review screen says so.
            advance()
        return
    if on_field and ch.isprintable():
        # The inline field takes every printable key, Space and digits
        # included. Space typing a space is measured; a digit going into the
        # field rather than toggling its row is assumed from that.
        type_into_field(ch)
        return
    if ch == " ":
        if cursor < n:
            toggle(cursor)
        return
    if ch.isdigit() and ch != "0":
        # A digit toggles its row and leaves the cursor where it is.
        i = int(ch) - 1
        if i < n:
            toggle(i)
        elif i == n:
            field_on[at] = not field_on[at]
        return
    # Anything else with the cursor off the field goes nowhere, which is what
    # a paste with the cursor on an option row does.


def single_key(ch):
    """One key on a single-select question."""
    global cursor, typing, buf
    q = QS[at]
    n = nopts()
    if typing:
        if ch in ("\r", "\n"):
            if buf.strip():
                picks[at] = set([buf.strip()])
                typed.append("● TYPED " + buf.strip())
                typing = False
                buf = ""
                advance()
            else:
                typing = False
                buf = ""
        elif ch in ("\x7f", "\x08"):
            buf = buf[:-1]
        else:
            buf += ch
        return
    if ch in ("\r", "\n"):
        if cursor < n:
            picks[at] = set([q["opts"][cursor]])
            advance()
        return
    if ch.isdigit() and ch != "0":
        i = int(ch) - 1
        if i < n:
            picks[at] = set([q["opts"][i]])
            advance()
        elif i == n:
            cursor = i
            typing = True
            buf = ""


def review_key(ch):
    """One key on the review screen. True once the call is submitted."""
    if (ch in ("\r", "\n") and cursor == 0) or ch == "1":
        submitted()
        return True
    return False


# ---- The plan approval and the idle input box ------------------------------
#
# FAKEDIALOG_CALL=plan draws the dialog ExitPlanMode puts up, the way CLI
# 2.1.281 draws it in its fullscreen renderer (testdata/plan-first.txt), and
# answers keys the way that build answers them, measured on 2026-09-24:
#
#   - digits 1-3 approve with that option at once. The digit of the feedback
#     row focuses it while its field is empty, and while the field holds words
#     it SENDS them, as Enter on the row would: "abc words" typed, ↑ to row 2,
#     then 3, and the plan came back rejected with "the user said: abc words";
#   - the feedback row is an inline field: typing and a paste replace its
#     label, and while it has the cursor a digit goes INTO it ("4. 7");
#   - walking onto the field leaves its text cursor mid-text, not at the end
#     (a typed X landed as "byte couXnt"); C-e takes it to the end of the whole
#     text, and Backspace takes out the character before it;
#   - Enter on the field sends its words back as feedback, and on an EMPTY
#     field acts as Esc, a plain rejection; Shift+Tab on it approves with the
#     words;
#   - once answered, the dialog gives way to the input box, whose status line
#     says the mode the option picked.
#
# Shift+Tab on an empty field or on an approve row does nothing here. What the
# CLI does there is not measured, and nothing in the driver presses it.
#
# FAKEDIALOG_CALL=composer draws the idle input box alone, for the mode
# driver. Shift+Tab walks FAKEDIALOG_MODES one stop per press, starting from
# FAKEDIALOG_MODE; a start that is off the cycle, dontAsk, gives way to the
# cycle's first stop and never comes back, as measured. Every stop the box has
# shown is listed above it, so a test can say what a walk passed through.
# A "!" typed at the input box raises the plan approval, standing in for the
# dialog a PreToolUse announces about a second before the CLI draws it.

PLAN_OPTS = os.environ.get(
    "FAKEDIALOG_PLAN_OPTS",
    "Yes, clear context (6% used) and use auto mode|Yes, and use auto mode|Yes, manually approve edits",
).split("|")
# Keys inside a bracketed paste are dropped, for the test that proves no Enter
# follows words that never reached the field.
DROP_PASTE = os.environ.get("FAKEDIALOG_DROP_PASTE") == "1"
# An approve that does not take: the screen blanks for a moment and the same
# dialog comes back, which is what a repaint the key did not answer looks like
# to capture-pane.
STUBBORN = os.environ.get("FAKEDIALOG_PLAN_STUBBORN") == "1"
MODE_LINES = {
    "manual": "⏸ manual mode on · ← for agents",
    "acceptEdits": "⏵⏵ accept edits on (shift+tab to cycle) · ← for agents",
    "plan": "⏸ plan mode on (shift+tab to cycle) · ← for agents",
    "auto": "⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
    "bypassPermissions": "⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
    "dontAsk": "⏵⏵ don't ask on (shift+tab to cycle) · ← for agents",
}
MODES = os.environ.get("FAKEDIALOG_MODES", "manual,acceptEdits,plan,auto").split(",")
# How long the status line takes to repaint after Shift+Tab, for a loaded box.
MODE_LAG = float(os.environ.get("FAKEDIALOG_MODE_LAG", "0"))
WIDTH = 100
PLAN_PREAMBLE = [
    # The conversation above the dialog quotes it, so a check against the
    # whole capture finds its words before the dialog draws them.
    "❯ Plan hello.txt. The dialog will ask: Would you like to proceed?",
    "  1. Yes, and use auto mode",
    "  ⎿  /plan to preview",
]
PLAN_BODY = [
    # Numbered lines of its own, which are never the options.
    "   Create hello.txt",
    "",
    "   1. Write hello.txt containing hi.",
    "   2. Check it with cat hello.txt.",
]

mode = os.environ.get("FAKEDIALOG_MODE", MODES[0])
visited = [mode]        # every mode the input box has shown, in order
plan_up = CALL == "plan"
plan_cursor = 1         # the row the ❯ is on
plan_field = ""         # the feedback row's words
plan_caret = 0          # the text cursor in them
outcome = ""            # what answered the dialog, drawn above the input box
in_paste = False


def feedback_row():
    return len(PLAN_OPTS) + 1


def wrap_words(text, width):
    lines, cur = [], ""
    for w in text.split(" "):
        if cur and len(cur) + 1 + len(w) > width:
            lines.append(cur)
            cur = w
        else:
            cur = w if cur == "" else cur + " " + w
    lines.append(cur)
    return lines


def draw_plan():
    out("\x1b[2J\x1b[H")
    for line in PLAN_PREAMBLE:
        out(line + "\r\n")
    out("▔" * WIDTH + "\r\n\r\n")
    out("  " + "─" * (WIDTH - 4) + "\r\n")
    out("   Ready to code?\r\n\r\n")
    out("   Here is Claude's plan:\r\n")
    out("  " + "╌" * (WIDTH - 4) + "\r\n")
    for line in PLAN_BODY:
        out(line + "\r\n")
    out("  " + "╌" * (WIDTH - 4) + "\r\n\r\n")
    out("  " + "─" * (WIDTH - 4) + "\r\n")
    out("   Claude has written up a plan and is ready to execute. Would you like to proceed?\r\n\r\n")
    for i, label in enumerate(PLAN_OPTS, 1):
        out("   %s %d. %s\r\n" % ("❯" if plan_cursor == i else " ", i, label))
    n = feedback_row()
    text = plan_field if plan_field != "" else "Tell Claude what to change"
    parts = wrap_words(text, WIDTH - 12)
    # The terminal keeps no trailing spaces, so a field holding only spaces
    # reads "4.".
    out(("   %s %d. %s" % ("❯" if plan_cursor == n else " ", n, parts[0])).rstrip() + "\r\n")
    for p in parts[1:]:
        out("        " + p + "\r\n")
    out("        shift+tab to approve with this feedback\r\n\r\n")
    out("   ctrl+g to edit in Vim · ~/.claude/plans/fake-plan.md\r\n")


# ---- The tool permission prompt ---------------------------------------------
#
# FAKEDIALOG_CALL=permission draws "Do you want to proceed?" the way CLI
# 2.1.283 draws it (testdata/permission-bash.txt), and answers keys the way
# that build answers them, measured on 2026-09-27:
#
#   - a digit picks its row at once, the No row's declining with no words;
#   - Tab on the No row opens its field: the row reads "No, and tell Claude
#     what to do differently" and the footer drops "Tab to amend";
#   - the open field takes typing and a paste, and the row reads "No, <words>",
#     long words wrapping under the row at the words' column;
#   - walking onto the field puts its text cursor at the START of the words (a
#     typed X landed as "No, Xprint the date instead"); C-e takes it to the
#     end, Backspace takes out the character before it, and walking off keeps
#     the words;
#   - Enter on the No row declines, with the words when the field holds any;
#     Enter on another row picks it.
#
# Not measured, and nothing in the driver relies on them: ↑ and ↓ stop at the
# ends here; Tab on another row does nothing here; a digit with the cursor on
# the open field goes into it here, as it does on the plan's feedback row.

PERM_OPTS = os.environ.get(
    "FAKEDIALOG_PERM_OPTS",
    "Yes|Yes, and always allow access to /tmp/proj from this project|No",
).split("|")
perm_up = CALL == "permission"
perm_cursor = int(os.environ.get("FAKEDIALOG_PERM_CURSOR", "1"))
perm_open = os.environ.get("FAKEDIALOG_PERM_FIELD") is not None
perm_field = os.environ.get("FAKEDIALOG_PERM_FIELD", "")
perm_caret = 0
# FAKEDIALOG_PERM_NEXT draws a second prompt, for this command, the moment the
# first is answered: the second of two tool calls Claude sent together, each
# asking in turn.
perm_next = os.environ.get("FAKEDIALOG_PERM_NEXT", "")
perm_command = "ls -la"


def perm_no():
    return len(PERM_OPTS)


def draw_perm():
    out("\x1b[2J\x1b[H")
    # The conversation quotes the prompt's question, as a capture does.
    out("❯ Run ls. It will ask: Do you want to proceed?\r\n\r\n")
    out("─" * WIDTH + "\r\n")
    if outcome:
        out("● " + outcome + "\r\n\r\n")
    out(" Bash command\r\n\r\n")
    out("   " + perm_command + "\r\n")
    out("   List the files\r\n\r\n")
    out(" Do you want to proceed?\r\n")
    n = perm_no()
    for i, label in enumerate(PERM_OPTS, 1):
        mark_ = "❯" if perm_cursor == i else " "
        if i == n and perm_open:
            text = perm_field if perm_field != "" else "and tell Claude what to do differently"
            parts = wrap_words(text, WIDTH - 12)
            out((" %s %d. No, %s" % (mark_, i, parts[0])).rstrip() + "\r\n")
            for p in parts[1:]:
                out("          " + p + "\r\n")
            continue
        out(" %s %d. %s\r\n" % (mark_, i, label))
    out("\r\n")
    out(" Esc to cancel\r\n" if perm_open else " Esc to cancel · Tab to amend\r\n")


def perm_close(what):
    global perm_up, outcome, perm_next, perm_command, perm_cursor, perm_open, perm_field, perm_caret
    outcome = what
    if perm_next:
        perm_command, perm_next = perm_next, ""
        perm_cursor, perm_open, perm_field, perm_caret = 1, False, "", 0
        return
    perm_up = False


def perm_pick(i):
    if i == perm_no():
        words = perm_field.strip() if perm_open else ""
        perm_close("PERMISSION DECLINED WITH " + words if words else "PERMISSION DECLINED")
    else:
        perm_close("PERMISSION %d" % i)


def perm_arrow(code):
    global perm_cursor, perm_caret
    was = perm_cursor
    if code == "A":
        perm_cursor = max(1, perm_cursor - 1)
    elif code == "B":
        perm_cursor = min(perm_no(), perm_cursor + 1)
    if perm_cursor == perm_no() and perm_cursor != was:
        perm_caret = 0


def perm_key(ch):
    global perm_open, perm_field, perm_caret
    on_field = perm_open and perm_cursor == perm_no()
    if in_paste and DROP_PASTE:
        return
    if ch == "\t":
        if perm_cursor == perm_no() and not perm_open:
            perm_open = True
            perm_caret = 0
        return
    if ch == "\x05":
        if on_field:
            perm_caret = len(perm_field)
        return
    if ch in ("\x7f", "\x08"):
        if on_field and perm_caret > 0:
            perm_field = perm_field[:perm_caret - 1] + perm_field[perm_caret:]
            perm_caret -= 1
        return
    if ch in ("\r", "\n"):
        perm_pick(perm_cursor)
        return
    if on_field and ch.isprintable():
        perm_field = perm_field[:perm_caret] + ch + perm_field[perm_caret:]
        perm_caret += 1
        return
    if ch.isdigit() and ch != "0" and int(ch) <= perm_no():
        perm_pick(int(ch))


def draw_composer():
    out("\x1b[2J\x1b[H")
    out("❯ Plan hello.txt.\r\n")
    if outcome:
        out("● " + outcome + "\r\n")
    out("  visited: " + " ".join(visited) + "\r\n\r\n")
    out("─" * WIDTH + "\r\n")
    out("❯ \r\n")
    out("─" * WIDTH + "\r\n")
    out("  ~/fake | statusline\r\n")
    out("  " + MODE_LINES[mode] + "\r\n")


def redraw():
    if plan_up:
        draw_plan()
    elif perm_up:
        draw_perm()
    else:
        draw_composer()


def set_mode(m):
    global mode
    mode = m
    visited.append(m)


def next_mode():
    if mode in MODES:
        set_mode(MODES[(MODES.index(mode) + 1) % len(MODES)])
    else:
        set_mode(MODES[0])


def close_plan(what, m):
    global plan_up, outcome
    plan_up = False
    outcome = what
    if m:
        set_mode(m)


def approve(n):
    if STUBBORN:
        out("\x1b[2J\x1b[H")
        time.sleep(0.15)
        return
    label = PLAN_OPTS[n - 1]
    m = "manual"
    if "auto mode" in label:
        m = "auto"
    elif "auto-accept" in label:
        m = "acceptEdits"
    close_plan("PLAN APPROVED %d" % n, m)


def focus_field():
    global plan_cursor, plan_caret
    plan_cursor = feedback_row()
    # Not at the end of the words: after ↑ out and ↓ back in, a typed X
    # landed mid-text (measured). Halfway is where a driver that forgets C-e
    # goes wrong.
    plan_caret = len(plan_field) // 2


def plan_arrow(code):
    global plan_cursor
    if code == "A":
        plan_cursor = max(1, plan_cursor - 1)
    elif code == "B":
        if plan_cursor + 1 == feedback_row():
            focus_field()
        else:
            plan_cursor = min(feedback_row(), plan_cursor + 1)
    elif code == "Z":
        if plan_cursor == feedback_row() and plan_field.strip():
            close_plan("PLAN APPROVED WITH FEEDBACK " + plan_field.strip(), "auto")


def plan_key(ch):
    global plan_field, plan_caret
    n = feedback_row()
    on_field = plan_cursor == n
    if in_paste and DROP_PASTE:
        return
    if ch == "\x05":
        if on_field:
            plan_caret = len(plan_field)
        return
    if ch in ("\x7f", "\x08"):
        if on_field and plan_caret > 0:
            plan_field = plan_field[:plan_caret - 1] + plan_field[plan_caret:]
            plan_caret -= 1
        return
    if ch in ("\r", "\n"):
        if not on_field:
            approve(plan_cursor)
        elif plan_field.strip():
            close_plan("PLAN FEEDBACK " + plan_field.strip(), "")
        else:
            close_plan("PLAN REJECTED", "")
        return
    if on_field and ch.isprintable():
        plan_field = plan_field[:plan_caret] + ch + plan_field[plan_caret:]
        plan_caret += 1
        return
    if ch.isdigit() and ch != "0":
        d = int(ch)
        if d < n:
            approve(d)
        elif d == n and plan_field.strip():
            close_plan("PLAN FEEDBACK " + plan_field.strip(), "")
        elif d == n:
            focus_field()


def plan_main():
    """The plan approval, then the input box; or the input box alone."""
    global in_paste, plan_up
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)
    tty.setraw(fd)
    # Ask for bracketed paste, as the CLI does, so a paste is marked.
    out("\x1b[?2004h")
    try:
        redraw()
        while True:
            ch = read1()
            if ch == "":
                return
            if DEAF:
                continue
            if ch == "\x1b":
                nxt = read1()
                if nxt != "[":
                    continue
                code = read1()
                if code.isdigit():
                    in_paste = skip_paste()
                    continue
                if plan_up:
                    plan_arrow(code)
                elif perm_up:
                    perm_arrow(code)
                elif code == "Z":
                    next_mode()
                    if MODE_LAG:
                        time.sleep(MODE_LAG)
                redraw()
                continue
            if plan_up:
                plan_key(ch)
            elif perm_up:
                perm_key(ch)
            elif ch == "!":
                plan_up = True
            redraw()
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)


def main():
    global cursor, fpos
    if CALL in ("plan", "composer", "permission"):
        plan_main()
        return
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)
    tty.setraw(fd)
    try:
        draw()
        done = False
        while True:
            ch = read1()
            if ch == "":
                return
            if DEAF or done:
                continue
            if ch == "\x1b":
                nxt = read1()
                if nxt != "[":
                    continue
                code = read1()
                if code.isdigit():
                    skip_paste()  # a bracketed-paste marker
                elif typing:
                    pass
                elif code in ("A", "B"):
                    was = cursor
                    if code == "A":
                        cursor = max(0, cursor - 1)
                    else:
                        cursor = min(rows() - 1, cursor + 1)
                    if multi() and cursor == free_row() and cursor != was:
                        # Arriving on the inline field puts its text cursor
                        # at the start of the text, not the end.
                        fpos = 0
                    if run_on_chat:
                        # A run that arrived on the chat row moves the
                        # cursor this one row and loses the rest.
                        run.clear()
                elif code == "D":
                    back()
                draw()
                continue
            if at >= len(QS):
                done = review_key(ch)
                if not done:
                    draw()
                continue
            if multi():
                multi_key(ch)
            else:
                single_key(ch)
            draw()
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)


main()
`
