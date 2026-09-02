import { describe, it, expect, afterEach } from "vitest";
import {
  EMPTY_HELD,
  PENDING_INPUT_MAX_BYTES,
  PENDING_INPUT_TTL_MS,
  byteLength,
  flush,
  graphemeCount,
  graphemes,
  hasGlyphs,
  isHoldable,
  isHolding,
  offer,
  popGrapheme,
  unwrapPaste,
  type HeldGates,
  type HeldState,
} from "../src/terminal/held";

/** The normal case: a socket that has been up, is down now, the tab is awake, and this client may type. */
const OFFLINE: HeldGates = {
  watching: false,
  hasConnectedOnce: true,
  suspended: false,
  now: 1_000,
};

const at = (now: number): HeldGates => ({ ...OFFLINE, now });

/** Type a run of chunks into a fresh hold and return where it ended up. */
function type(chunks: string[], gates: HeldGates = OFFLINE, from: HeldState = EMPTY_HELD) {
  return chunks.reduce((state, chunk) => offer(state, chunk, gates).state, from);
}

describe("the gates on holding at all", () => {
  /**
   * Before the first connection there is no tmux session yet, so a hold has
   * nothing to replay INTO — it would be typed at whatever the session turns
   * out to be, which is not what the person aimed at.
   */
  it("refuses everything before a socket has ever opened", () => {
    const r = offer(EMPTY_HELD, "ls", { ...OFFLINE, hasConnectedOnce: false });
    expect(r.verdict).toBe("refused:no-session");
    expect(r.state.text).toBe("");
  });

  /**
   * The battery saver drops the socket on purpose once the tab has been hidden
   * a while, and a suspend outlives the replay window by design. Holding
   * through one would promise a replay that the suspend itself cancels.
   */
  it("refuses while the battery saver holds the socket down", () => {
    const r = offer(EMPTY_HELD, "ls", { ...OFFLINE, suspended: true });
    expect(r.verdict).toBe("refused:suspended");
  });

  /**
   * A read-only client never reaches the hold at all in term.html: sendInput
   * drops its pty-bound bytes at the top, before the branch that offers them.
   * Holding for a watcher would draw glyphs for a session they are not
   * permitted to write to, and then try to replay them into it.
   */
  it("refuses a watcher, who has no session to replay into either", () => {
    const r = offer(EMPTY_HELD, "ls", { ...OFFLINE, watching: true });
    expect(r.verdict).toBe("refused:watching");
    expect(r.state).toBe(EMPTY_HELD);
    expect(isHolding(r.state)).toBe(false);
  });

  /** The page guards the choke point, not each key, so Backspace and Enter go the same way. */
  it("refuses every key from a watcher, not only the printable ones", () => {
    const watching = { ...OFFLINE, watching: true };
    for (const key of ["a", "\x7f", "\b", "\r", "\n", "\x1b[200~ls\x1b[201~"]) {
      expect(offer(EMPTY_HELD, key, watching).verdict).toBe("refused:watching");
    }
  });

  /**
   * Watch mode outranks both socket gates. In term.html the return sits above
   * the readyState check, so it wins whatever the connection is doing, and a
   * component that asked about the socket first would answer with the wrong
   * refusal.
   */
  it("refuses a watcher before it asks anything about the socket", () => {
    const r = offer(EMPTY_HELD, "ls", {
      watching: true,
      hasConnectedOnce: false,
      suspended: true,
      now: 0,
    });
    expect(r.verdict).toBe("refused:watching");
  });

  it("keeps the two gates apart, because the reasons are different", () => {
    expect(offer(EMPTY_HELD, "x", { ...OFFLINE, hasConnectedOnce: false }).verdict).not.toBe(
      offer(EMPTY_HELD, "x", { ...OFFLINE, suspended: true }).verdict,
    );
  });

  /**
   * A refusal must not disturb what is already on screen. The component may
   * compare by identity and skip a repaint, so a refusal returns the very same
   * object rather than a copy.
   */
  it("hands back the identical state for every refusal, so nothing repaints", () => {
    const held = type(["ls"]);
    for (const [data, gates] of [
      ["x", { ...OFFLINE, watching: true }],
      ["x", { ...OFFLINE, hasConnectedOnce: false }],
      ["x", { ...OFFLINE, suspended: true }],
      ["\t", OFFLINE],
      ["\x1b[A", OFFLINE],
    ] as const) {
      const r = offer(held, data, gates);
      expect(r.verdict.startsWith("refused:")).toBe(true);
      expect(r.state).toBe(held);
    }
  });
});

describe("holding printable input", () => {
  it("holds a keystroke and stamps when the hold began", () => {
    const r = offer(EMPTY_HELD, "l", at(500));
    expect(r.verdict).toBe("held");
    expect(r.state).toEqual({ text: "l", enter: false, since: 500, active: true });
  });

  /**
   * The TTL runs from the FIRST character. If every keystroke re-stamped it, a
   * slowly typed line would keep buying itself a fresh window and auto-Enter
   * against a prompt that moved on minutes ago.
   */
  it("starts the Enter clock at the first character, not the latest", () => {
    const state = offer(offer(EMPTY_HELD, "l", at(500)).state, "s", at(9_000)).state;
    expect(state.text).toBe("ls");
    expect(state.since).toBe(500);
  });

  it("appends chunk after chunk in the order they were typed", () => {
    expect(type(["g", "i", "t", " ", "log"]).text).toBe("git log");
  });
});

describe("keys the session alone can resolve", () => {
  /**
   * Tab, the arrows and Ctrl-anything are resolved BY the pty. Holding one
   * would draw something on screen the session never produced — a completion
   * that did not happen, a history entry nobody recalled.
   */
  it("refuses Tab, arrows and control keys", () => {
    for (const key of ["\t", "\x1b[A", "\x1b[B", "\x12", "\x03", "\x1b"]) {
      expect(offer(type(["ls"]), key, OFFLINE).verdict).toBe("refused:key");
    }
  });

  it("refuses C1 controls as well as C0, since neither is a glyph", () => {
    expect(isHoldable("\u0085")).toBe(false); // NEL, a C1 control
    expect(isHoldable("\u009f")).toBe(false); // APC, the top of the C1 range
    expect(isHoldable("\u00a0")).toBe(true); // a non-breaking space still draws
  });

  it("refuses an empty chunk, because there is no glyph to draw for it", () => {
    expect(offer(type(["ls"]), "", OFFLINE).verdict).toBe("refused:key");
  });

  it("holds letters, accents, CJK and emoji", () => {
    expect(isHoldable("ls -la")).toBe(true);
    expect(isHoldable("café")).toBe(true);
    expect(isHoldable("日本語")).toBe(true);
    expect(isHoldable("🚀")).toBe(true);
  });
});

describe("pasting into a dead socket", () => {
  it("holds the payload of a bracketed paste, not the escape sequences", () => {
    const r = offer(EMPTY_HELD, "\x1b[200~git status\x1b[201~", OFFLINE);
    expect(r.verdict).toBe("held");
    expect(r.state.text).toBe("git status");
  });

  /**
   * A multi-line paste is a sequence of commands. Holding it would show one
   * line and hide the rest, and replaying it would run every one of them; the
   * newline makes the whole chunk unholdable so nothing is half-kept.
   */
  it("refuses a multi-line paste rather than holding part of it", () => {
    const r = offer(EMPTY_HELD, "\x1b[200~make\nmake test\x1b[201~", OFFLINE);
    expect(r.verdict).toBe("refused:key");
    expect(r.state.text).toBe("");
  });

  /** Anchored at both ends: a paste whose tail has not arrived is still raw escapes. */
  it("only unwraps a paste that is wrapped end to end", () => {
    expect(unwrapPaste("\x1b[200~half")).toBe("\x1b[200~half");
    expect(offer(EMPTY_HELD, "\x1b[200~half", OFFLINE).verdict).toBe("refused:key");
  });

  it("refuses an empty paste, the same as an empty chunk", () => {
    expect(offer(type(["ls"]), "\x1b[200~\x1b[201~", OFFLINE).verdict).toBe("refused:key");
  });
});

describe("the byte budget", () => {
  it("holds a chunk that lands exactly on the limit", () => {
    const r = offer(EMPTY_HELD, "a".repeat(PENDING_INPUT_MAX_BYTES), OFFLINE);
    expect(r.verdict).toBe("held");
    expect(byteLength(r.state.text)).toBe(PENDING_INPUT_MAX_BYTES);
  });

  /**
   * All or nothing per chunk. Truncating a paste to fit would replay a
   * command with its tail missing, which runs something the person never
   * typed.
   */
  it("refuses the whole chunk when it would overflow, and keeps what is held", () => {
    const full = type(["a".repeat(PENDING_INPUT_MAX_BYTES)]);
    const r = offer(full, "b", OFFLINE);
    expect(r.verdict).toBe("refused:full");
    expect(r.state.text).toBe(full.text);
  });

  /**
   * The budget is UTF-8 bytes, not code units. An emoji is one JS "length" of
   * two and four bytes on the wire; counting code units would let a paste of
   * emoji through at twice the size it was measured for.
   */
  it("counts UTF-8 bytes, so a surrogate pair costs four and not two", () => {
    expect(byteLength("a")).toBe(1);
    expect(byteLength("é")).toBe(2);
    expect(byteLength("€")).toBe(3);
    expect(byteLength("😀")).toBe(4);

    const nearly = type(["a".repeat(PENDING_INPUT_MAX_BYTES - 2)]);
    // Two code units left, four bytes needed.
    expect(offer(nearly, "😀", OFFLINE).verdict).toBe("refused:full");
  });
});

describe("Backspace", () => {
  /**
   * An Enter typed by reflex must not be a dead end you cannot edit out of, so
   * Backspace is tested before the "line is closed" refusal and takes the
   * Enter back off first.
   */
  it("takes the Enter back off a committed line before it deletes anything", () => {
    const closed = type(["ls", "\r"]);
    expect(closed).toEqual({ text: "ls", enter: true, since: 1_000, active: true });
    const r = offer(closed, "\x7f", OFFLINE);
    expect(r.verdict).toBe("reopened");
    expect(r.state).toEqual({ text: "ls", enter: false, since: 1_000, active: true });
  });

  it("deletes a character only on the Backspace after that", () => {
    const reopened = type(["ls", "\r", "\x7f"]);
    const r = offer(reopened, "\x7f", OFFLINE);
    expect(r.verdict).toBe("popped");
    expect(r.state.text).toBe("l");
  });

  it("answers to the \\b form as well as DEL", () => {
    expect(offer(type(["ls"]), "\b", OFFLINE).verdict).toBe("popped");
  });

  /**
   * Nothing held means the cell to the left belongs to tmux, and this overlay
   * never touches those: readline would refuse to delete past its line start
   * anyway, so blanking one would show a deletion that never happens.
   */
  it("refuses to delete past the start of what it holds", () => {
    const r = offer(EMPTY_HELD, "\x7f", OFFLINE);
    expect(r.verdict).toBe("refused:nothing-held");
    expect(r.state).toBe(EMPTY_HELD);
  });

  /**
   * Chopping a code unit off an emoji leaves a lone surrogate, which is not a
   * character anyone typed and draws as a replacement box.
   */
  it("deletes a whole grapheme, never half an emoji", () => {
    const r = offer(type(["hi 👩‍👩‍👧‍👦"]), "\x7f", OFFLINE);
    expect(r.state.text).toBe("hi ");
  });

  /** Emptied by Backspace, the next character begins a fresh window rather than inheriting the old line's age. */
  it("restarts the Enter clock once Backspace empties the hold", () => {
    const emptied = offer(type(["l"], at(100)), "\x7f", at(200)).state;
    expect(emptied).toEqual({ text: "", enter: false, since: 0, active: true });
    expect(offer(emptied, "x", at(5_000)).state.since).toBe(5_000);
  });

  it("leaves the clock alone while something is still held", () => {
    const state = offer(type(["ls"], at(100)), "\x7f", at(900)).state;
    expect(state).toEqual({ text: "l", enter: false, since: 100, active: true });
  });
});

describe("Enter", () => {
  it("commits the line and stops taking typing", () => {
    const closed = offer(type(["ls"]), "\r", OFFLINE);
    expect(closed.verdict).toBe("closed");
    expect(closed.state.enter).toBe(true);
    expect(offer(closed.state, "x", OFFLINE).verdict).toBe("refused:closed");
  });

  it("takes \\n as well as \\r", () => {
    expect(offer(type(["ls"]), "\n", OFFLINE).verdict).toBe("closed");
  });

  /** An Enter on an empty hold would commit nothing and draw a bare ⏎ over tmux's cells. */
  it("refuses to commit an empty hold", () => {
    expect(offer(EMPTY_HELD, "\r", OFFLINE).verdict).toBe("refused:nothing-held");
  });

  it("refuses a second Enter on an already committed line", () => {
    expect(offer(type(["ls", "\r"]), "\r", OFFLINE).verdict).toBe("refused:closed");
  });

  /** A closed line still counts as on-screen: Esc has something to discard and the pill still reads "held". */
  it("still counts as holding once it is committed", () => {
    expect(isHolding(EMPTY_HELD)).toBe(false);
    expect(isHolding(type(["ls"]))).toBe(true);
    expect(isHolding(type(["ls", "\r"]))).toBe(true);
  });
});

describe("replaying on reconnect", () => {
  it("sends nothing and clears when there is nothing held", () => {
    const r = flush(EMPTY_HELD, 5_000);
    expect(r.outcome).toBeNull();
    expect(r.sends).toEqual([]);
    expect(r.state).toEqual(EMPTY_HELD);
  });

  it("replays the text alone when the line was never committed", () => {
    const r = flush(type(["ls"], at(0)), 60_000);
    expect(r.outcome).toBe("typed");
    expect(r.sends).toEqual(["ls"]);
  });

  it("replays the text and the Enter inside the window", () => {
    const r = flush(type(["ls", "\r"], at(0)), 1_000);
    expect(r.outcome).toBe("ran");
    expect(r.sends).toEqual(["ls", "\r"]);
  });

  /**
   * The text survives any gap — it has been on screen the whole time. What
   * expires is permission to press Enter for you: a command run against a
   * prompt that has moved on is the part nobody can take back.
   */
  it("keeps the text but drops the Enter once the window has passed", () => {
    const r = flush(type(["ls", "\r"], at(0)), PENDING_INPUT_TTL_MS + 1);
    expect(r.outcome).toBe("held-enter");
    expect(r.sends).toEqual(["ls"]);
    expect(r.droppedEnterAfterMs).toBe(PENDING_INPUT_TTL_MS + 1);
  });

  /** The window is inclusive; an off-by-one here silently changes what a 3s blip does. */
  it("treats the last millisecond of the window as inside it", () => {
    expect(flush(type(["ls", "\r"], at(0)), PENDING_INPUT_TTL_MS).outcome).toBe("ran");
    expect(flush(type(["ls", "\r"], at(0)), PENDING_INPUT_TTL_MS + 1).outcome).toBe("held-enter");
  });

  /**
   * The age is measured from the first keystroke, so a line reopened and
   * re-committed does not win itself a second window.
   */
  it("does not restart the window when a line is reopened and committed again", () => {
    const state = type(["ls", "\r", "\x7f", "\r"], at(0));
    expect(state).toEqual({ text: "ls", enter: true, since: 0, active: true });
    expect(flush(state, PENDING_INPUT_TTL_MS + 1).outcome).toBe("held-enter");
  });

  it("leaves nothing behind, whatever it did", () => {
    for (const state of [type(["ls"]), type(["ls", "\r"]), EMPTY_HELD]) {
      expect(flush(state, 99_999).state).toEqual(EMPTY_HELD);
    }
  });
});

describe("what still counts as a hold", () => {
  /**
   * The failure this prevents: answering "is a hold on screen" from the text
   * alone. Backspace the last character away and term.html is still sitting on
   * a heldShadow object, so Esc discards it, toasts, and swallows the key. A
   * component reading `!!text` would let that Esc through to the pty instead.
   */
  it("keeps holding after Backspace empties the line, so Esc still discards it", () => {
    const emptied = type(["ls", "\x7f", "\x7f"]);
    expect(emptied.text).toBe("");
    expect(isHolding(emptied)).toBe(true);
  });

  /** Nothing is drawn for it, though. That narrower question is heldRender's, and it takes the other answer. */
  it("draws nothing for that same empty hold", () => {
    expect(hasGlyphs(type(["ls", "\x7f", "\x7f"]))).toBe(false);
    expect(hasGlyphs(EMPTY_HELD)).toBe(false);
    expect(hasGlyphs(type(["ls"]))).toBe(true);
    expect(hasGlyphs(type(["ls", "\r"]))).toBe(true);
  });

  /** Backspacing past the start is refused, and a refusal must not end the hold either. */
  it("is still holding after a Backspace that had nothing left to delete", () => {
    const emptied = type(["ls", "\x7f", "\x7f"]);
    const again = offer(emptied, "\x7f", OFFLINE);
    expect(again.verdict).toBe("refused:nothing-held");
    expect(again.state).toBe(emptied);
    expect(isHolding(again.state)).toBe(true);
  });

  /** A refused key starts nothing: no overlay, no anchor, and the pill has nothing to report. */
  it("does not begin a hold on any refusal", () => {
    const refusals: [string, HeldGates][] = [
      ["ls", { ...OFFLINE, watching: true }],
      ["ls", { ...OFFLINE, hasConnectedOnce: false }],
      ["ls", { ...OFFLINE, suspended: true }],
      ["\t", OFFLINE],
      ["\x7f", OFFLINE],
      ["\r", OFFLINE],
    ];
    for (const [data, gates] of refusals) {
      expect(isHolding(offer(EMPTY_HELD, data, gates).state)).toBe(false);
    }
  });

  /**
   * Both ways a hold ends. Esc is the component resetting to EMPTY_HELD; a
   * replay ends it here, and an emptied hold flushes to nothing at all, which
   * is how the overlay finally goes away after a reconnect.
   */
  it("stops holding once the hold is discarded or replayed", () => {
    expect(isHolding(EMPTY_HELD)).toBe(false);
    expect(isHolding(flush(type(["ls", "\r"]), 1_000).state)).toBe(false);
    const emptied = flush(type(["ls", "\x7f", "\x7f"]), 1_000);
    expect(emptied.outcome).toBeNull();
    expect(isHolding(emptied.state)).toBe(false);
  });
});

describe("counting what is drawn", () => {
  it("counts a ZWJ emoji as one cell, not one per code point", () => {
    expect(graphemeCount("hi 👩‍👩‍👧‍👦")).toBe(4);
    expect(graphemes("a👍b")).toEqual(["a", "👍", "b"]);
  });

  it("counts nothing for an empty hold", () => {
    expect(graphemeCount("")).toBe(0);
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
   * The fallback is what an old engine gets. It splits by code point, so a ZWJ
   * family reads as several cells — imperfect, but every cell is a real
   * character.
   */
  it("falls back to code points rather than throwing", () => {
    withoutSegmenter();
    expect(graphemes("a👍b")).toEqual(["a", "👍", "b"]);
    expect(graphemeCount("ab")).toBe(2);
  });

  /** Slicing one code unit off an emoji leaves a lone surrogate, which renders as a box nobody typed. */
  it("never leaves half a surrogate pair behind when it deletes", () => {
    withoutSegmenter();
    expect(popGrapheme("hi 👍")).toBe("hi ");
    expect(popGrapheme("hi")).toBe("h");
    expect(popGrapheme("a")).toBe("");
    expect(popGrapheme("")).toBe("");
  });
});
