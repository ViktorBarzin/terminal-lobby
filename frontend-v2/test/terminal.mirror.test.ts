import { describe, it, expect, afterEach } from "vitest";
import {
  EMPTY_MIRROR,
  HELD_ENTER_MESSAGE,
  MIRROR_FIELD_ATTRIBUTES,
  commonPrefix,
  reduce,
  type MirrorAction,
  type MirrorReduction,
  type MirrorState,
  type MirrorWorld,
} from "../src/terminal/mirror";

/**
 * The compose mirror's rules, as frontend/term.html:7077-7509 pays for them.
 *
 * Every test below is one rule that page records, and the ones that matter most
 * are the two nobody can see going wrong: the field is never rewritten
 * mid-line (that is what keeps iOS QuickType and Gboard predictions alive), and
 * an unchanged value diffs to nothing (that is what makes a double-send
 * impossible rather than merely unlikely).
 *
 * WHAT NO TEST HERE CAN SHOW. These are string transforms over the differ.
 * Nothing is mounted, so Gboard, QuickType and dictation appear only as the
 * values they would leave in the field, and whether a real predictor survives
 * is unproven until the component is wired and driven on the shared Android
 * emulator; iOS has no instrument here at all. Two wiring duties are out of
 * reach for the same reason and are recorded in mirror.ts instead: the field
 * has to be mounted OUTSIDE the terminal host, or TerminalNative's
 * capture-phase paste handler swallows its pastes, and `set-field` has to be
 * applied without re-entering reduce.
 */

const DEL = "\x7f";

const ONLINE: MirrorWorld = { connected: true };
const OFFLINE: MirrorWorld = { connected: false };

/** A baseline holding `line`, as the mirror shaped the pty's input line. */
const at = (line: string): MirrorState => ({ line });

/** The bytes the component would put on the wire, one string per term.input() call. */
function sends(r: MirrorReduction): string[] {
  const out: string[] = [];
  for (const a of r.actions) if (a.kind === "send") out.push(a.bytes);
  return out;
}

/** The action kinds in the order the component must perform them. */
function kinds(r: MirrorReduction): MirrorAction["kind"][] {
  return r.actions.map((a) => a.kind);
}

/**
 * One DOM `input` event. The caret defaults to the end of the value, which is
 * where typing leaves it; the tests that care pass their own.
 */
function edit(
  state: MirrorState,
  value: string,
  world: MirrorWorld = ONLINE,
  caret = value.length,
): MirrorReduction {
  return reduce(state, { type: "edited", value, caret }, world);
}

/** Type a run of field values in, returning where the baseline ended up. */
function typeRun(values: string[], from: MirrorState = EMPTY_MIRROR): MirrorState {
  return values.reduce((state, value) => edit(state, value).state, from);
}

describe("the field's attributes", () => {
  /**
   * A test rather than a comment because the failure is silent: with
   * `autocomplete='off'` set on this field, everything still works and the
   * QuickType bar is simply gone. term.html measured that on 2026-07-12 and
   * records it at :7103-7110. On iOS, pronounced in the installed PWA's
   * WKWebView, 'off' also suppresses the predictive and autocorrect bar. So
   * the attribute has to be ABSENT, not 'off', and the hardening set on
   * xterm's helper textarea (TerminalNative's `hardenInput`, which does set it) must
   * not be copied onto this one.
   */
  it("omits autocomplete rather than setting it off", () => {
    expect(Object.keys(MIRROR_FIELD_ATTRIBUTES)).not.toContain("autocomplete");
    expect(MIRROR_FIELD_ATTRIBUTES).not.toHaveProperty("autocomplete");
  });

  /** No `type` either: a textarea has none, and type=password is the hardening. */
  it("omits type", () => {
    expect(MIRROR_FIELD_ATTRIBUTES).not.toHaveProperty("type");
  });

  /**
   * The rest, exactly as term.html sets them (:7115-7120). autocorrect='on'
   * and spellcheck='true' are the real QuickType controls; autocapitalize is
   * off because sentence caps corrupt shell commands now that keystrokes
   * stream raw; enterkeyhint is fixed to 'send' because the newline in the
   * value IS the submit signal.
   */
  it("matches term.html's set", () => {
    expect(MIRROR_FIELD_ATTRIBUTES).toEqual({
      autocapitalize: "off",
      autocorrect: "on",
      spellcheck: "true",
      inputmode: "text",
      enterkeyhint: "send",
      "aria-label": "Compose text to send to the terminal",
    });
  });
});

describe("a plain typed character", () => {
  /**
   * The floor of the whole mechanism: one key, one character on the wire. The
   * field is the pty's input line, so a keystroke is an append and nothing
   * more (term.html:7251-7252, the no-deletion branch).
   */
  it("forwards exactly the character that was typed", () => {
    const r = edit(at("ls -l"), "ls -la");
    expect(sends(r)).toEqual(["a"]);
    expect(r.state.line).toBe("ls -la");
  });

  /** A run of keystrokes is a run of one-character frames, never a re-send of the line. */
  it("forwards one character per keystroke through a whole word", () => {
    const values = ["l", "ls", "ls ", "ls -", "ls -l", "ls -la"];
    const seen: string[][] = [];
    values.reduce((state, value) => {
      const r = edit(state, value);
      seen.push(sends(r));
      return r.state;
    }, EMPTY_MIRROR);
    expect(seen).toEqual([["l"], ["s"], [" "], ["-"], ["l"], ["a"]]);
  });

  /**
   * The claim term.html:7176-7178 makes about the differ: an unchanged value
   * diffs to nothing, so a double-send is impossible by construction rather
   * than guarded against. Composition updates and suggestion taps can both
   * re-fire `input` with the value already on screen.
   */
  it("forwards nothing when the value has not moved", () => {
    const before = at("ls -la");
    const r = edit(before, "ls -la");
    expect(r.actions).toEqual([]);
    // Identical object, so the component can compare by identity and skip work.
    expect(r.state).toBe(before);
  });

  /** An empty field with an empty baseline is the boot state, and it forwards nothing. */
  it("forwards nothing on an empty field", () => {
    const r = edit(EMPTY_MIRROR, "");
    expect(r.actions).toEqual([]);
    expect(r.state).toBe(EMPTY_MIRROR);
  });
});

describe("an autocorrect replacement", () => {
  /**
   * The behaviour this module exists for. Gboard and QuickType commit a
   * correction by rewriting the word behind the caret, and the mirror must pay
   * for the rewritten characters only. Sending the whole line instead would
   * put the line on the wire twice over on every corrected word, and a TUI
   * that echoes as it reads would show it.
   */
  const corrections: [string, string, string, string[]][] = [
    // Gboard commits "teh" as "the" when the space lands.
    ["teh to the on the space", "git commit -m teh", "git commit -m the ", [DEL + DEL + "he "]],
    // A one-letter insertion: only the tail after the common prefix moves.
    ["a one-letter insertion", "helo", "hello", [DEL + "lo"]],
    // A correction that lengthens the word still only pays for its own suffix.
    ["a longer replacement", "recieve", "receive", [DEL + DEL + DEL + DEL + "eive"]],
    // A transposition on the first letter shares no prefix, so the line IS the
    // cost. There is nothing cheaper to send without pty cursor tracking.
    ["a transposition with nothing shared", "hte", "the", [DEL.repeat(3) + "the"]],
    // Tapping a prediction extends the word in place.
    ["a prediction tap", "termi", "terminal ", ["nal "]],
  ];

  for (const [name, before, after, expected] of corrections) {
    it(`pays only for the rewritten tail: ${name}`, () => {
      const r = edit(at(before), after);
      expect(sends(r)).toEqual(expected);
      expect(r.state.line).toBe(after);
    });
  }

  /**
   * The backspaces and the insertion go in ONE frame, not two. term.html's
   * branch 2 builds a single string and hands it to one emit()
   * (term.html:7253-7254). Frame boundaries are observable to whatever is
   * reading the pty, so the grouping is part of the port.
   */
  it("sends the deletion and the retype as one frame", () => {
    const r = edit(at("git commit -m teh"), "git commit -m the ");
    expect(sends(r)).toHaveLength(1);
  });

  /**
   * Select-all then type: the whole line is deleted and the replacement typed.
   * There is no common prefix to keep, so the cost is the line, which is what
   * the person actually asked for.
   */
  it("replaces the whole line when nothing survives the overwrite", () => {
    const r = edit(at("ls -la"), "x");
    expect(sends(r)).toEqual([DEL.repeat(6) + "x"]);
    expect(r.state.line).toBe("x");
  });

  /** Shake-to-undo reverts the value, and the differ treats that as any other edit. */
  it("forwards an undo as the edit it is", () => {
    const r = edit(at("the"), "teh");
    expect(sends(r)).toEqual([DEL + DEL + "eh"]);
    expect(r.state.line).toBe("teh");
  });
});

describe("a dictation or swipe burst", () => {
  /**
   * Dictation and swipe typing both arrive as one `input` event carrying the
   * whole phrase. The differ is event-shape-agnostic (term.html:7169-7177), so
   * a burst costs one insertion rather than one per word.
   */
  it("forwards a dictated phrase as a single insertion", () => {
    const r = edit(at("echo "), "echo hello there how are you");
    expect(sends(r)).toEqual(["hello there how are you"]);
    expect(r.state.line).toBe("echo hello there how are you");
  });

  it("forwards a swipe-typed word as a single insertion", () => {
    const r = edit(at("git st"), "git status");
    expect(sends(r)).toEqual(["atus"]);
  });

  /**
   * Dictation revises what it already committed as the recognizer changes its
   * mind, which is a replacement rather than an append. It pays for its own
   * tail like any correction.
   */
  it("forwards a dictation revision as a deletion plus a retype", () => {
    const r = edit(at("echo to the store"), "echo to the shore");
    expect(sends(r)).toEqual([DEL.repeat(4) + "hore"]);
  });
});

describe("editing away from the end of the line", () => {
  /**
   * A caret moved into the middle and typed at produces an EDIT, not an
   * append: the differ deletes back to the common prefix and retypes the tail
   * (term.html:7179-7182, the V1 no-cursor-tracking constraint). The pty
   * cursor is never moved, so the final line is what matters, and it comes out
   * right.
   */
  it("deletes back to the common prefix and retypes the tail", () => {
    const r = edit(at("ls -la"), "ls x-la", ONLINE, 4);
    expect(sends(r)).toEqual([DEL.repeat(3) + "x-la"]);
    expect(r.state.line).toBe("ls x-la");
  });

  it("forwards a mid-line deletion as a deletion plus a retype", () => {
    // "ls -la" and "ls -a" share "ls -", so the cost is the two characters
    // after it and not the line.
    const r = edit(at("ls -la"), "ls -a", ONLINE, 4);
    expect(sends(r)).toEqual([DEL.repeat(2) + "a"]);
  });

  /**
   * The caret is carried on the event and the differ never reads it. That is
   * term.html's V1 constraint stated as a test: the same value from the same
   * baseline produces the same bytes wherever the caret happens to be, because
   * the diff is over the two strings alone. A port that started keying on the
   * caret would need pty cursor tracking to be correct, and there is none.
   */
  const carets = [0, 1, 3, 4, 7];
  for (const caret of carets) {
    it(`forwards the same bytes with the caret at ${caret}`, () => {
      const r = edit(at("ls -la"), "ls x-la", ONLINE, caret);
      expect(sends(r)).toEqual([DEL.repeat(3) + "x-la"]);
    });
  }

  /**
   * Inserting the same run that already ends the line reads as an append,
   * because the two strings share the longer prefix. The bytes differ from
   * what a caret-aware differ would send and the resulting line is identical,
   * which is why the caret can be ignored at all.
   */
  it("takes the cheapest diff even when the caret says otherwise", () => {
    const r = edit(at("abcabc"), "abcabcabc", ONLINE, 6);
    expect(sends(r)).toEqual(["abc"]);
    expect(r.state.line).toBe("abcabcabc");
  });
});

describe("the delete unit, where graphemes and code points disagree", () => {
  /**
   * The three-branch rule exists because the receivers disagree: Claude Code's
   * composer deletes one grapheme per DEL, readline and canonical mode delete
   * one code point (term.html:7191-7196, both measured through the real
   * ws/ttyd/tmux stack). Plain text is where they agree, so one DEL per code
   * point is exact.
   */
  it("sends one DEL per code point when the counts agree", () => {
    const r = edit(at("hello"), "he");
    expect(sends(r)).toEqual([DEL.repeat(3)]);
  });

  /**
   * A ZWJ family is one grapheme and five code points, so no DEL count is
   * right for both receivers. term.html:7240-7247 sidesteps the disagreement:
   * delete past empty from a KNOWN state and retype the whole line. The
   * over-delete is a verified no-op on both receiver classes.
   */
  it("nukes the line and retypes it when the counts disagree", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const r = edit(at(`hi ${family}`), "hi ");
    // 3 code points of "hi " plus 5 in the family.
    expect(sends(r)).toEqual([DEL.repeat(8) + "hi "]);
    expect(r.state.line).toBe("hi ");
  });

  /** A combining mark is the same class of problem: two code points, one grapheme. */
  it("nukes the line for a combining mark too", () => {
    const r = edit(at("café"), "caf");
    expect(sends(r)).toEqual([DEL.repeat(5) + "caf"]);
  });

  /** Typing an emoji deletes nothing, so it is an insertion and the branch never arises. */
  it("inserts an emoji without touching the delete rule", () => {
    const r = edit(at("hi "), "hi \u{1F44D}");
    expect(sends(r)).toEqual(["\u{1F44D}"]);
  });

  /**
   * A single astral character is one grapheme and one code point, so the
   * counts agree and the cheap branch is taken: one DEL, not a nuke.
   */
  it("deletes a lone astral character with one DEL", () => {
    const r = edit(at("hi \u{1F44D}"), "hi ");
    expect(sends(r)).toEqual([DEL]);
  });
});

describe("the common prefix", () => {
  /** The ordinary case, in code units. */
  it("stops at the first differing unit", () => {
    expect(commonPrefix("ls -la", "ls -lh")).toBe(5);
    expect(commonPrefix("abc", "abcdef")).toBe(3);
    expect(commonPrefix("abcdef", "abc")).toBe(3);
    expect(commonPrefix("", "abc")).toBe(0);
    expect(commonPrefix("abc", "")).toBe(0);
  });

  /**
   * Never mid-pair. A prefix that ends between a high and a low surrogate
   * would make the deletion suffix start with half a character, which is not
   * countable in whole units and renders as a box nobody typed
   * (term.html:7212-7215).
   */
  it("backs out of a split surrogate pair", () => {
    // Both start with U+1F44D's high surrogate and differ on the low one.
    expect(commonPrefix("\u{1F44D}", "\u{1F44E}")).toBe(0);
    expect(commonPrefix("hi \u{1F44D}", "hi \u{1F44E}")).toBe(3);
  });

  /**
   * And never mid-grapheme. term.html:7216-7224 snaps the prefix down to a
   * grapheme boundary of the OLD value, so the deletion suffix is a whole
   * number of things the receiver can delete.
   */
  it("snaps back to a grapheme boundary of the old value", () => {
    // "cafe" plus a combining acute, against "cafes": they share "cafe", but
    // that boundary sits inside the accented grapheme, so the prefix drops to
    // the start of it.
    expect(commonPrefix("café", "cafes")).toBe(3);
  });

  /** A pure append needs no snapping, and term.html skips the walk for it. */
  it("keeps the whole old value as the prefix when it is a prefix", () => {
    const family = "hi \u{1F468}‍\u{1F469}‍\u{1F467}";
    expect(commonPrefix(family, `${family} there`)).toBe(family.length);
  });
});

describe("Enter", () => {
  /**
   * The soft keyboard's `send` key inserts a newline; there is no key event to
   * read. So the newline in the value IS the submit signal
   * (term.html:7279-7285), the line is reconciled without it, and the carriage
   * return follows.
   */
  it("reconciles the line and then submits it", () => {
    const r = edit(at("ls -l"), "ls -la\n");
    expect(sends(r)).toEqual(["a", "\r"]);
  });

  /**
   * Two frames, never one. term.html emits the delta and the carriage return
   * through separate emit() calls, so each is its own sendInput frame
   * (term.html:7283-7284, :7300). Concatenating them would be a change to what
   * the pty reads, with nothing saying it is safe.
   */
  it("sends the carriage return as its own frame", () => {
    const r = edit(at("ls -l"), "ls -la\n");
    expect(sends(r)).toHaveLength(2);
    expect(sends(r)[1]).toBe("\r");
  });

  /**
   * A mid-string Enter submits the WHOLE value regardless of where the caret
   * was (term.html:7280-7283, called out there as proven necessary end to
   * end). Splitting the line at the caret is what terminal semantics do not do.
   */
  const enterPositions = [0, 2, 3, 5];
  for (const k of enterPositions) {
    it(`submits the whole line with the newline inserted at ${k}`, () => {
      // The newline really is at k, which is what a mid-string Enter produces:
      // the caret follows it. Every case reconciles to the same line, so the
      // only bytes are the carriage return, and nothing is split.
      const value = `${"ls -l".slice(0, k)}\n${"ls -l".slice(k)}`;
      const r = edit(at("ls -l"), value, ONLINE, k + 1);
      expect(sends(r)).toEqual(["\r"]);
      expect(r.state).toEqual(EMPTY_MIRROR);
    });
  }

  /**
   * Same test with the line unfinished, so the delta and the submit both have
   * work to do: the newline lands mid-string, the whole line still goes.
   */
  it("reconciles and submits a line whose Enter landed in the middle", () => {
    const r = edit(at("ls -l"), "ls -\nla", ONLINE, 5);
    expect(sends(r)).toEqual(["a", "\r"]);
    expect(r.state).toEqual(EMPTY_MIRROR);
  });

  /** Every newline is stripped, not just the first, so a multi-newline burst still submits one line. */
  it("strips every newline before reconciling", () => {
    const r = edit(at(""), "ls\n-la\n");
    expect(sends(r)).toEqual(["ls-la", "\r"]);
  });

  /** Enter on an empty field is a bare carriage return, which is a fresh prompt. */
  it("sends a bare carriage return on an empty field", () => {
    const r = edit(EMPTY_MIRROR, "\n");
    expect(sends(r)).toEqual(["\r"]);
  });

  /**
   * Select-all then the send key: the browser replaces the selection with the
   * newline, so the value is just that. The line is reconciled away first, then
   * submitted, which runs an empty command rather than the deleted text. That
   * is what the person asked for, and it is term.html's behaviour because the
   * reconcile always runs before the submit.
   */
  it("empties the line before submitting when the send key replaced a selection", () => {
    const r = edit(at("abc"), "\n");
    expect(sends(r)).toEqual([DEL.repeat(3), "\r"]);
    expect(r.state.line).toBe("");
  });

  /**
   * The baseline resets because the pty's input line restarts empty
   * (term.html:7301 calls mirrorLineReset). Leaving the submitted text as the
   * baseline would desync the field from a line that no longer exists.
   */
  it("resets the baseline after a submit", () => {
    const r = edit(at("ls -l"), "ls -la\n");
    expect(r.state).toEqual(EMPTY_MIRROR);
  });

  /**
   * And the field is cleared with it, in the one place the mirror is allowed
   * to write it. term.html:7269-7272. A submitted line is a finished sentence,
   * so no prediction is lost; what would break predictions is clearing
   * mid-word, which is the case below in "the field is never rewritten
   * mid-line".
   */
  it("clears the field on a submit, and says why", () => {
    const r = edit(at("ls -l"), "ls -la\n");
    const set = r.actions.filter((a) => a.kind === "set-field");
    expect(set).toEqual([{ kind: "set-field", value: "", reason: "line-submitted" }]);
  });

  it("clears the field after the bytes, not before them", () => {
    const r = edit(at("ls -l"), "ls -la\n");
    expect(kinds(r)).toEqual(["send", "send", "set-field"]);
  });

  /**
   * The clear is unconditional here, where term.html reaches it through
   * mirrorLineReset, whose early-out returns when the field AND the baseline
   * are both empty (:7268, called at :7301). That early-out cannot fire on
   * this path: the value that triggered the submit still holds the newline
   * that triggered it, so the field is non-empty by construction. Bare Enter
   * on an empty line is where the two would differ if it could, and it does
   * not.
   */
  it("clears the field even when the whole value was the newline", () => {
    const r = edit(at(""), "\n");
    expect(r.actions).toEqual([
      { kind: "send", bytes: "\r" },
      { kind: "set-field", value: "", reason: "line-submitted" },
    ]);
  });

  /**
   * A submit whose delta takes the nuke branch. Both halves are tested on
   * their own above; this is the composition, and the grouping is the point:
   * the over-delete and the retype are ONE frame, the carriage return is the
   * next, and the clear comes last (term.html:7286, :7300-7301).
   */
  it("nukes, retypes, submits and clears, in that order", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const r = edit(at(`hi ${family}`), "hi \n");
    // 3 code points of "hi " plus 5 in the family, then the whole line back.
    expect(sends(r)).toEqual([DEL.repeat(8) + "hi ", "\r"]);
    expect(kinds(r)).toEqual(["send", "send", "set-field"]);
    expect(r.state).toEqual(EMPTY_MIRROR);
  });
});

describe("a bare carriage return in the value", () => {
  /**
   * Only \n is the submit signal: term.html's check at :7279 tests for \n, so
   * a lone \r is ordinary text to both the page and this port and rides out
   * inside the delta. Neither side has a test for it, and the field cannot
   * pick one up in practice (`enterkeyhint` is fixed to `send`, and Gboard and
   * QuickType both insert \n), so this records the behaviour rather than
   * endorsing it.
   */
  it("forwards the CR inside the delta and does not submit", () => {
    const r = edit(at("ls"), "ls\r");
    expect(sends(r)).toEqual(["\r"]);
    expect(kinds(r)).toEqual(["send"]);
    // No clear, and the baseline keeps the CR: the mirror has no way to know
    // whatever is reading the pty just took that as Enter.
    expect(r.state.line).toBe("ls\r");
  });

  /** A CRLF pair submits on its \n, and the CR goes out as part of the line. */
  it("submits on the newline of a CRLF pair", () => {
    const r = edit(at("ls"), "ls\r\n");
    expect(sends(r)).toEqual(["\r", "\r"]);
    expect(r.state).toEqual(EMPTY_MIRROR);
  });
});

describe("Enter with no socket", () => {
  /**
   * Offline the text is sitting in a hold (see held.ts), so clearing the field
   * would take the line away from under it and leave an empty box with no way
   * back (term.html:7286-7299). The newline is stripped, the text stays where
   * the person can see it, and the reason is said out loud.
   */
  it("keeps the text and does not submit", () => {
    const r = edit(at("ls -l"), "ls -la\n", OFFLINE);
    expect(sends(r)).toEqual(["a"]);
    expect(sends(r)).not.toContain("\r");
  });

  it("puts the newline-stripped text back in the field", () => {
    const r = edit(at("ls -l"), "ls -la\n", OFFLINE);
    expect(r.actions).toContainEqual({
      kind: "set-field",
      value: "ls -la",
      reason: "line-restored",
    });
  });

  it("keeps the baseline on the text it restored", () => {
    const r = edit(at("ls -l"), "ls -la\n", OFFLINE);
    expect(r.state.line).toBe("ls -la");
  });

  /** The wording is term.html's, and it names the way out of the state. */
  it("says what happened, once, in term.html's words", () => {
    const r = edit(at("ls -l"), "ls -la\n", OFFLINE);
    expect(r.actions).toContainEqual({ kind: "say", message: HELD_ENTER_MESSAGE });
    expect(HELD_ENTER_MESSAGE).toContain("reconnect and press Enter");
  });

  it("restores the field after the bytes and before it speaks", () => {
    const r = edit(at("ls -l"), "ls -la\n", OFFLINE);
    expect(kinds(r)).toEqual(["send", "set-field", "say"]);
  });

  /**
   * The delta still goes out. The mirror hands its bytes to the same send path
   * as any keystroke, and held.ts is what catches them with no socket, so the
   * offline branch changes the Enter and nothing else.
   */
  it("still forwards the typed delta so the hold can catch it", () => {
    const r = edit(at(""), "ls -la\n", OFFLINE);
    expect(sends(r)).toEqual(["ls -la"]);
  });

  /**
   * Enter again, still with no socket: the value has not moved, so there is no
   * delta to re-send, and the text stays in front of the person with the
   * message repeated. The one thing this must not do is forward the line a
   * second time.
   *
   * What it deliberately is NOT is a reconnect. The pair this leaves behind, a
   * field and a baseline both holding the kept line, never survives a socket
   * coming back: term.html resets the mirror early in ws.onopen (:10293) and
   * replays the hold further down the same handler (:10342). "across a
   * reconnect" below walks the sequence that really happens.
   */
  it("does not re-send the line when Enter arrives again with no socket", () => {
    const held = edit(at("ls -l"), "ls -la\n", OFFLINE).state;
    const again = edit(held, "ls -la\n", OFFLINE);
    expect(sends(again)).toEqual([]);
    expect(kinds(again)).toEqual(["set-field", "say"]);
    expect(again.state.line).toBe("ls -la");
  });
});

describe("across a reconnect", () => {
  /**
   * The sequence end to end, because each piece is faithful on its own and the
   * state they add up to is the part worth pinning.
   *
   * term.html resets the mirror early in ws.onopen (:10293) and replays the
   * hold 49 lines further down the same handler (:10342), so the reset always
   * lands first; and that replay writes to ws.send directly (:8243-8250)
   * rather than through onData, so no out-of-band event follows it. The pty
   * therefore comes back holding the flushed line while the mirror's field and
   * baseline are both empty. That asymmetry is
   * term.html's, not this port's, and it is the state the transparent erase
   * exists for.
   */
  it("clears both sides on the attach, then runs the line on a bare Enter", () => {
    // Offline: the text is kept where the person can see it, and the hold has
    // the bytes.
    const offline = edit(at("ls -l"), "ls -la\n", OFFLINE);
    expect(offline.state.line).toBe("ls -la");

    // The socket comes back. :10293 fires with the field still holding
    // "ls -la", so the reset takes both sides down with no emission.
    const attached = reduce(offline.state, { type: "out-of-band", value: "ls -la" }, ONLINE);
    expect(attached.actions).toEqual([{ kind: "set-field", value: "", reason: "out-of-band" }]);
    expect(attached.state).toEqual(EMPTY_MIRROR);

    // The hold replays "ls -la" past this module, so the pty holds the line
    // while the baseline says empty. Enter over the now-empty field runs it,
    // and a bare carriage return is all it costs.
    const run = edit(attached.state, "\n", ONLINE);
    expect(sends(run)).toEqual(["\r"]);
    expect(run.state).toEqual(EMPTY_MIRROR);
  });

  /**
   * And the flushed line is erasable. With both sides empty and text in the
   * pty, Backspace is the only way to take a character of it back, which is
   * why the transparent erase is load-bearing rather than a corner case
   * (term.html:7320-7327).
   */
  it("erases the flushed line one DEL at a time", () => {
    const attached = reduce(at("ls -la"), { type: "out-of-band", value: "ls -la" }, ONLINE).state;
    const back = reduce(
      attached,
      { type: "backspace-at-empty", value: "", composing: false },
      ONLINE,
    );
    expect(sends(back)).toEqual([DEL]);
    expect(back.state).toBe(attached);
  });
});

describe("with no socket, every path but Enter is unchanged", () => {
  /**
   * `world` is read on the submit branch and nowhere else. term.html's
   * reconcile never looks at ws (:7246-7259), and neither does its beforeinput
   * or its keydown listener (:7314-7327); held.ts catches the bytes
   * downstream. Every other OFFLINE case in this file carries a newline, so
   * without these the suite would stay green if the differ started
   * early-returning with the socket down.
   */
  const shapes: [string, string, string][] = [
    ["a typed character", "ls -l", "ls -la"],
    ["an autocorrect replacement", "git commit -m teh", "git commit -m the "],
    ["a dictation burst", "echo ", "echo hello there how are you"],
    ["a mid-line edit", "ls -la", "ls x-la"],
    ["a select-all overwrite", "ls -la", "x"],
    ["an emptied field", "ls -la", ""],
    ["a ZWJ family being deleted", "hi \u{1F468}‍\u{1F469}‍\u{1F467}", "hi "],
  ];

  for (const [name, before, after] of shapes) {
    it(`sends the same bytes offline as online: ${name}`, () => {
      const online = edit(at(before), after, ONLINE);
      const offline = edit(at(before), after, OFFLINE);
      expect(offline.actions).toEqual(online.actions);
      expect(offline.state).toEqual(online.state);
    });
  }

  it("routes a multiline paste with no socket just as it would with one", () => {
    const on = reduce(at("cd "), { type: "paste-intent", data: "one\ntwo" }, ONLINE);
    const off = reduce(at("cd "), { type: "paste-intent", data: "one\ntwo" }, OFFLINE);
    expect(off.actions).toEqual(on.actions);
  });

  it("lets a single-line paste insert natively with no socket", () => {
    const before = at("cd ");
    const off = reduce(before, { type: "paste-intent", data: "/var/log" }, OFFLINE);
    expect(off.actions).toEqual([]);
    expect(off.state).toBe(before);
  });

  it("erases pty-side with no socket just as it would with one", () => {
    const off = reduce(
      EMPTY_MIRROR,
      { type: "backspace-at-empty", value: "", composing: false },
      OFFLINE,
    );
    expect(sends(off)).toEqual([DEL]);
  });

  it("resets on out-of-band bytes with no socket just as it would with one", () => {
    const off = reduce(at("ls -l"), { type: "out-of-band", value: "ls -l" }, OFFLINE);
    expect(off.actions).toEqual([{ kind: "set-field", value: "", reason: "out-of-band" }]);
    expect(off.state).toEqual(EMPTY_MIRROR);
  });
});

describe("the field is never rewritten mid-line", () => {
  /**
   * THE MECHANISM. Writing the field mid-word is what kills QuickType and
   * Gboard predictions, so the mirror is passive: it reads .value and forwards
   * a delta. A port that writes the value back on an ordinary edit has removed
   * the feature while keeping the code, so the invariant is asserted over
   * every edit shape rather than described.
   *
   * xterm's own field is unusable for this because term.html hardens it:
   * type=password plus the autocorrect set, which is the page's own stated
   * reason for a separate field (:7078-7082). What that field's value holds in
   * @xterm/xterm 6.0.0 is written out in mirror.ts's header, checked against
   * the installed source; the short version is that it is neither empty nor
   * the input line, so it could not be diffed even unhardened.
   */
  const shapes: [string, string, string][] = [
    ["a typed character", "ls -l", "ls -la"],
    ["an autocorrect replacement", "git commit -m teh", "git commit -m the "],
    ["a dictation burst", "echo ", "echo hello there how are you"],
    ["a swipe-typed word", "git st", "git status"],
    ["a mid-line edit", "ls -la", "ls x-la"],
    ["a select-all overwrite", "ls -la", "x"],
    ["a single-line paste landing natively", "cd ", "cd /var/log/nginx"],
    ["an emptied field", "ls -la", ""],
    ["an emoji", "hi ", "hi \u{1F44D}"],
    ["a ZWJ family being deleted", "hi \u{1F468}‍\u{1F469}‍\u{1F467}", "hi "],
  ];

  for (const [name, before, after] of shapes) {
    it(`writes nothing back for ${name}`, () => {
      const r = edit(at(before), after);
      expect(kinds(r)).not.toContain("set-field");
      // And the baseline follows the field rather than the other way round.
      expect(r.state.line).toBe(after);
    });
  }

  /**
   * Emptying the field by hand is the closest thing to a clear, and it is
   * still not one: the mirror forwards the deletions and leaves the empty
   * field alone, because the person emptied it.
   */
  it("forwards the deletions when the person empties the field", () => {
    const r = edit(at("ls -la"), "");
    expect(sends(r)).toEqual([DEL.repeat(6)]);
    expect(kinds(r)).not.toContain("set-field");
  });
});

describe("a paste into the mirror", () => {
  /**
   * A multiline block never enters the one-line field: the edit is swallowed,
   * the armed soft modifiers are disarmed so they cannot remap the paste's
   * first character, and the whole block goes through term.paste, which
   * brackets it (term.html:7305-7318).
   */
  it("routes a multiline paste to term.paste instead of the field", () => {
    const r = reduce(at("cd "), { type: "paste-intent", data: "one\ntwo\nthree" }, ONLINE);
    expect(kinds(r)).toEqual(["swallow-edit", "disarm-soft-mods", "paste"]);
    expect(r.actions).toContainEqual({ kind: "paste", text: "one\ntwo\nthree" });
  });

  /** No bytes of its own: term.paste is the send, and the mirror adds nothing to it. */
  it("forwards no delta for a multiline paste", () => {
    const r = reduce(at("cd "), { type: "paste-intent", data: "one\ntwo" }, ONLINE);
    expect(sends(r)).toEqual([]);
  });

  /**
   * The baseline does not move here. term.paste's own traffic comes back
   * through onData as out-of-band bytes, and THAT is what resets the baseline
   * (term.html:7309-7310, :8342), which is why the paste action must not be
   * marked as the mirror's own.
   */
  it("leaves the baseline for the out-of-band echo to reset", () => {
    const before = at("cd ");
    const r = reduce(before, { type: "paste-intent", data: "one\ntwo" }, ONLINE);
    expect(r.state).toBe(before);
    const echo = reduce(r.state, { type: "out-of-band", value: "cd " }, ONLINE);
    expect(echo.state).toEqual(EMPTY_MIRROR);
  });

  /**
   * A single-line paste falls through and inserts natively, then streams like
   * typing. That is the whole reason the document-level paste handler defers a
   * text paste aimed at this field (term.html:8892-8903): its own handler is
   * capture-phase and preventDefaults the paste, so without the deferral the
   * text would reach the pty through term.paste with no native insertion at
   * all, and the mirror would be blanked by that paste's own onData reset
   * instead of showing the line (:8896-8898).
   */
  it("lets a single-line paste insert natively", () => {
    const before = at("cd ");
    const r = reduce(before, { type: "paste-intent", data: "/var/log" }, ONLINE);
    expect(r.actions).toEqual([]);
    expect(r.state).toBe(before);
  });

  it("forwards a single-line paste exactly once, as one insertion", () => {
    const intent = reduce(at("cd "), { type: "paste-intent", data: "/var/log" }, ONLINE);
    const inserted = edit(intent.state, "cd /var/log");
    expect(sends(inserted)).toEqual(["/var/log"]);
  });

  /** A paste with no data to read is nothing to decide about. */
  it("does nothing for an empty paste", () => {
    const before = at("cd ");
    const r = reduce(before, { type: "paste-intent", data: "" }, ONLINE);
    expect(r.actions).toEqual([]);
    expect(r.state).toBe(before);
  });

  /** A trailing newline is still multiline: the field must never hold one. */
  it("treats a trailing newline as multiline", () => {
    const r = reduce(at(""), { type: "paste-intent", data: "make build\n" }, ONLINE);
    expect(kinds(r)).toContain("paste");
  });
});

describe("Backspace against an empty field", () => {
  /**
   * Transparent erase. After an out-of-band reset the pty line can hold text
   * the mirror does not, and the field is the only thing the person can see:
   * an empty field with a live line behind it. Backspace there erases pty-side
   * (term.html:7320-7327).
   */
  it("erases pty-side text the mirror does not hold", () => {
    const r = reduce(EMPTY_MIRROR, { type: "backspace-at-empty", value: "", composing: false }, ONLINE);
    expect(sends(r)).toEqual([DEL]);
  });

  /**
   * The baseline does not move, because there is nothing in it to move. The
   * erase is aimed at text the mirror never tracked.
   */
  it("leaves the baseline alone", () => {
    const r = reduce(EMPTY_MIRROR, { type: "backspace-at-empty", value: "", composing: false }, ONLINE);
    expect(r.state).toBe(EMPTY_MIRROR);
  });

  /**
   * With text in the field the ordinary path owns the deletion: the value
   * changes and the differ pays for it. Emitting here as well would delete
   * twice.
   */
  it("stays out of the way when the field has text", () => {
    const before = at("ls");
    const r = reduce(before, { type: "backspace-at-empty", value: "ls", composing: false }, ONLINE);
    expect(r.actions).toEqual([]);
    expect(r.state).toBe(before);
  });

  /** An IME owns its own backspaces mid-composition (term.html:7323-7326). */
  it("stays out of the way mid-composition", () => {
    const r = reduce(EMPTY_MIRROR, { type: "backspace-at-empty", value: "", composing: true }, ONLINE);
    expect(r.actions).toEqual([]);
  });

  /**
   * The guard reads the FIELD, so a non-empty baseline does not stop it: one
   * DEL goes out and the baseline is left exactly where it was, which is what
   * term.html does too (:7325-7327 never touches lastValue). No wiring path
   * reaches this pair today, because every reset empties both sides at once,
   * so it pins the shape of the code rather than a sequence anyone can walk.
   */
  it("leaves a non-empty baseline exactly where it was", () => {
    const before = at("ls -la");
    const r = reduce(before, { type: "backspace-at-empty", value: "", composing: false }, ONLINE);
    expect(sends(r)).toEqual([DEL]);
    expect(r.state).toBe(before);
  });
});

describe("an out-of-band reset", () => {
  /**
   * Bytes reaching the pty from any non-mirror path invalidate the baseline:
   * soft keys, the paste bridge, raw typing in the helper textarea, an upload
   * path-send, a fresh socket attach (term.html:6369-6376, :7261-7274). The
   * field and the baseline both drop, with no emission, because the pty
   * already has the bytes.
   */
  it("drops the field and the baseline without emitting", () => {
    const r = reduce(at("ls -l"), { type: "out-of-band", value: "ls -l" }, ONLINE);
    expect(sends(r)).toEqual([]);
    expect(r.actions).toEqual([{ kind: "set-field", value: "", reason: "out-of-band" }]);
    expect(r.state).toEqual(EMPTY_MIRROR);
  });

  /**
   * The early-out matters for cost, not correctness: raw typing in the helper
   * textarea fires this once per keystroke through onData, and re-clearing an
   * already-empty field would force a re-measure and a refit on every one
   * (term.html:7268).
   */
  it("does nothing when the field and the baseline are already empty", () => {
    const r = reduce(EMPTY_MIRROR, { type: "out-of-band", value: "" }, ONLINE);
    expect(r.actions).toEqual([]);
    expect(r.state).toBe(EMPTY_MIRROR);
  });

  /**
   * It reads the FIELD as well as the baseline, so a field holding text the
   * baseline lost is still cleared. No wiring path reaches this pair either,
   * for the same reason as the Backspace pair above: every reset empties both
   * sides at once, and typing keeps them equal edit by edit. It pins the shape
   * of the guard rather than a sequence anyone can walk, and the shape is
   * term.html's: an OR over both sides (:7268), so either one holding
   * something is work to do. The one moment the pair is real is inside a
   * single submit reduction, between the emptied baseline it returns and the
   * `set-field` the component has yet to apply, and no event can arrive in
   * there.
   */
  it("clears a field that holds text the baseline does not", () => {
    const r = reduce(EMPTY_MIRROR, { type: "out-of-band", value: "ls -l" }, ONLINE);
    expect(r.actions).toEqual([{ kind: "set-field", value: "", reason: "out-of-band" }]);
  });

  /** After a reset the next keystroke is an insertion, not a re-send of the old line. */
  it("makes the next keystroke a plain insertion", () => {
    const reset = reduce(at("ls -l"), { type: "out-of-band", value: "ls -l" }, ONLINE).state;
    expect(sends(edit(reset, "x"))).toEqual(["x"]);
  });
});

describe("the identity of an unmoved baseline", () => {
  /**
   * The contract on the returned state, so a component can compare by identity
   * and skip work. fit.ts holds the same line for its debt. Both reset paths
   * can be reached with the baseline already empty, and neither should look
   * like a change.
   */
  it("keeps the state object when a submit finds the baseline empty", () => {
    const before = at("");
    const r = edit(before, "\n");
    expect(sends(r)).toEqual(["\r"]);
    expect(r.state).toBe(before);
  });

  it("keeps the state object when an out-of-band reset finds it empty", () => {
    const before = at("");
    const r = reduce(before, { type: "out-of-band", value: "leftover" }, ONLINE);
    expect(kinds(r)).toEqual(["set-field"]);
    expect(r.state).toBe(before);
  });
});

describe("the baseline across a whole session", () => {
  /** Typing, correcting, submitting and typing again leaves the baseline where it belongs. */
  it("tracks the field through a correction and a submit", () => {
    const typed = typeRun(["g", "gi", "git", "git ", "git st", "git status"]);
    expect(typed.line).toBe("git status");
    const submitted = edit(typed, "git status\n").state;
    expect(submitted).toEqual(EMPTY_MIRROR);
    expect(sends(edit(submitted, "l"))).toEqual(["l"]);
  });
});

describe("without Intl.Segmenter", () => {
  const real = Intl.Segmenter;
  afterEach(() => {
    (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter = real;
  });
  const withoutSegmenter = () => {
    delete (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  };

  /**
   * On an engine with no segmenter the grapheme count falls back to the code
   * point count, so the two can never disagree and the nuke branch is
   * unreachable. term.html has the same shape (:7197-7204): the cheap
   * per-code-point delete rule is what an old engine gets, which is exact for
   * readline and over-deletes nothing.
   */
  it("takes the per-code-point delete rule for a ZWJ family", () => {
    withoutSegmenter();
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const r = edit(at(`hi ${family}`), "hi ");
    // 5 code points of family deleted, and no retype of "hi ".
    expect(sends(r)).toEqual([DEL.repeat(5)]);
  });

  /** The surrogate guard is not the segmenter's job, so it still holds. */
  it("still refuses to split a surrogate pair", () => {
    withoutSegmenter();
    expect(commonPrefix("\u{1F44D}", "\u{1F44E}")).toBe(0);
    expect(commonPrefix("hi \u{1F44D}", "hi \u{1F44E}")).toBe(3);
  });

  /** Plain typing is untouched by any of it. */
  it("forwards a plain character unchanged", () => {
    withoutSegmenter();
    expect(sends(edit(at("ls -l"), "ls -la"))).toEqual(["a"]);
  });
});
