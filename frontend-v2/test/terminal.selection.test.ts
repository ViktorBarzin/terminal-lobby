import { describe, it, expect } from "vitest";
import {
  STASH_TTL_MS,
  chooseCaptureWrite,
  copyCommandDecision,
  copySource,
  isCopyChord,
  isPasteChord,
  isTerminalChord,
  osc52Accepts,
  osc52ReadText,
  osc52WriteDecision,
  reduceStash,
  stashIsFresh,
  terminalKeydownDecision,
  type ChordEvent,
  type SelectionStash,
  type SelectionState,
} from "../src/terminal/selection";

const key = (over: Partial<ChordEvent> = {}): ChordEvent => ({
  type: "keydown",
  key: "",
  code: "",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...over,
});

const ctrlC = (over: Partial<ChordEvent> = {}) =>
  key({ key: "c", code: "KeyC", ctrlKey: true, ...over });

/** The ordinary case: a highlight exists exactly when it has text. */
const state = (selection: string, stash: SelectionStash | null = null): SelectionState => ({
  hasSelection: selection !== "",
  selection,
  stash,
});

/**
 * The case the two fields exist for: a highlight IS on screen, and xterm's
 * right-trimming hands back "" for it — a drag released inside a row's
 * trailing blank space.
 */
const blankRange = (stash: SelectionStash | null = null): SelectionState => ({
  hasSelection: true,
  selection: "",
  stash,
});

describe("the layout-proof copy chord", () => {
  it("matches Ctrl+C on a Latin layout", () => {
    expect(isCopyChord(ctrlC())).toBe(true);
  });

  it("matches Cmd+C, so Mac users copy with the key they expect", () => {
    expect(isCopyChord(key({ key: "c", code: "KeyC", metaKey: true }))).toBe(true);
  });

  /**
   * The bug ADR-0003 names: under Cyrillic, Ctrl+C reports 'с' (U+0441), an
   * `e.key === 'c'` test fails, and the chord falls through as ^C — SIGINT
   * fired at the moment the user asked to copy a visible selection.
   */
  it("matches by physical key position when the layout yields a non-Latin letter", () => {
    expect(isCopyChord(ctrlC({ key: "с" }))).toBe(true);
    expect(isCopyChord(ctrlC({ key: "ъ" }))).toBe(true);
    expect(isCopyChord(key({ key: "в", code: "KeyV", ctrlKey: true }))).toBe(false);
    expect(isPasteChord(key({ key: "в", code: "KeyV", ctrlKey: true }))).toBe(true);
  });

  it("survives CapsLock and Shift, which only change the letter's case", () => {
    expect(isCopyChord(ctrlC({ key: "C" }))).toBe(true);
  });

  /**
   * `e.key` wins while it is a Latin letter, so a remapped layout copies with
   * the key that prints 'c' — not with whatever sits at the QWERTY C position.
   * A code-first rule would copy on Dvorak's 'j'.
   */
  it("prefers the letter over the key position on a remapped Latin layout", () => {
    expect(isCopyChord(ctrlC({ key: "c", code: "KeyJ" }))).toBe(true);
    expect(isCopyChord(ctrlC({ key: "j", code: "KeyC" }))).toBe(false);
  });

  /**
   * AltGr arrives as Ctrl+Alt. Hijacking those would eat characters people
   * type on European layouts.
   */
  it("ignores AltGr chords", () => {
    expect(isCopyChord(ctrlC({ altKey: true }))).toBe(false);
    expect(isCopyChord(key({ key: "c", code: "KeyC", ctrlKey: true, altKey: true }))).toBe(false);
  });

  it("needs a modifier at all, so plain typing is never a chord", () => {
    expect(isCopyChord(key({ key: "c", code: "KeyC" }))).toBe(false);
  });

  it("does not fire on a different key that happens to be modified", () => {
    expect(isCopyChord(key({ key: "x", code: "KeyX", ctrlKey: true }))).toBe(false);
    expect(isTerminalChord(key({ key: "с", code: "KeyX", ctrlKey: true }), "c", "KeyC")).toBe(false);
  });
});

describe("what the copy chord puts on the clipboard", () => {
  /**
   * Selection semantics are frozen (ADR-0003): a drag across a TUI's hard
   * split yields indent, an injected newline and pad spaces on purpose. A port
   * that trims or re-joins would change what every existing user copies.
   */
  it("copies the selection verbatim, keeping trailing spaces and injected newlines", () => {
    const raw = "https://example.com/a-very   \n  long/path   ";
    const d = terminalKeydownDecision(ctrlC(), state(raw), 0);
    expect(d).toMatchObject({ action: "copy", text: raw, recovered: false, toast: "Copied" });
  });

  it("keeps a blank-looking selection of spaces rather than treating it as empty", () => {
    const d = terminalKeydownDecision(ctrlC(), state("   "), 0);
    expect(d).toMatchObject({ action: "copy", text: "   " });
  });

  /**
   * The contract's hard edge: with nothing to copy, Ctrl+C is still the
   * interrupt. Turning it into a no-op would strand anyone trying to kill a
   * running command.
   */
  it("leaves Ctrl+C as SIGINT when there is nothing to copy", () => {
    expect(terminalKeydownDecision(ctrlC(), state(""), 0)).toEqual({
      action: "pty",
      passToTerminal: true,
    });
  });

  it("never lets the pty see the key when it did copy", () => {
    const d = terminalKeydownDecision(ctrlC(), state("x"), 0);
    expect(d.passToTerminal).toBe(false);
  });

  /**
   * term.html gates the chord on hasSelection() (8569) and copies
   * getSelection() (8570) — a RANGE predicate and a TEXT getter, which do not
   * agree. xterm right-trims each row, so a drag released in a row's trailing
   * blanks highlights something and returns "". Deciding on the text would
   * send ^C to the pty: SIGINT fired with a highlight on screen, which is the
   * failure ADR-0003's contract exists to prevent. term.html spends the chord
   * on an empty write instead, and so does this.
   */
  it("spends the chord on a highlight whose text xterm trims away to nothing", () => {
    expect(terminalKeydownDecision(ctrlC(), blankRange(), 0)).toEqual({
      action: "copy",
      text: "",
      recovered: false,
      toast: "Copied",
      failureToast: "Copy blocked by browser",
      passToTerminal: false,
    });
  });

  /**
   * The stash branch (term.html:8575) sits BEHIND the hasSelection() branch,
   * so it is never consulted while a range is live. Reaching past the empty
   * range for a stash would copy text the user replaced with this drag.
   */
  it("copies the empty range rather than an older stash still sitting behind it", () => {
    const d = terminalKeydownDecision(ctrlC(), blankRange({ text: "stale", at: 0 }), 1_000);
    expect(d).toMatchObject({ action: "copy", text: "", recovered: false });
    expect(copySource(blankRange({ text: "stale", at: 0 }), 1_000)).toEqual({
      text: "",
      recovered: false,
    });
  });
});

describe("the recovery stash", () => {
  /**
   * Mode-1003 panes report every pointer move, the TUI repaints, and the
   * repaint clears xterm's highlight while the user still means to copy. The
   * stash must survive that, or the next Ctrl+C is an unwanted interrupt.
   */
  it("survives a repaint that wipes the highlight", () => {
    const stash = reduceStash(null, { type: "selection", text: "npm run build" }, 100);
    expect(reduceStash(stash, { type: "repaint-cleared" }, 150)).toBe(stash);
  });

  /**
   * The other half of the same rule: after a deliberate dismissal (wheel,
   * Escape, a replacing drag) interrupt semantics must come back immediately.
   */
  it("dies the moment the user dismisses the selection on purpose", () => {
    const stash = reduceStash(null, { type: "selection", text: "npm run build" }, 100);
    expect(reduceStash(stash, { type: "dismissed", hasSelection: true }, 150)).toBeNull();
  });

  /**
   * term.html:5893 `if (!term.hasSelection()) return;` runs BEFORE `selStash =
   * null` (5894), so a dismissal reason that fires with nothing highlighted
   * leaves the stash alive. That guard is reachable, not defensive: the
   * double-click path (6010-6011) calls clearSelectionBecause('double-click
   * replace') from inside a branch entered when hasSelection() is false.
   * Nulling the stash there would turn the pending copy back into SIGINT.
   */
  it("keeps the stash when a dismissal fires with no highlight left to dismiss", () => {
    const stash = reduceStash(null, { type: "selection", text: "npm run build" }, 100);
    const afterRepaint = reduceStash(stash, { type: "repaint-cleared" }, 150);
    expect(reduceStash(afterRepaint, { type: "dismissed", hasSelection: false }, 200)).toBe(stash);
  });

  /**
   * The same sequence as a user sees it: the highlight is repainted away, a
   * second click lands, and Ctrl+C must still copy what was selected rather
   * than interrupting the command that repainted over it.
   */
  it("still copies the recovered text after a dismissal that had nothing to dismiss", () => {
    let stash = reduceStash(null, { type: "selection", text: "docker compose up" }, 100);
    stash = reduceStash(stash, { type: "repaint-cleared" }, 300);
    stash = reduceStash(stash, { type: "dismissed", hasSelection: false }, 400);
    expect(terminalKeydownDecision(ctrlC(), state("", stash), 500)).toMatchObject({
      action: "copy",
      text: "docker compose up",
      recovered: true,
      toast: "Copied (recovered)",
      passToTerminal: false,
    });
  });

  /**
   * xterm reports an empty selection mid-gesture. Storing that would erase a
   * perfectly good stash a heartbeat before the chord asks for it.
   */
  it("ignores an empty selection instead of overwriting a good stash", () => {
    const stash = reduceStash(null, { type: "selection", text: "keep me" }, 100);
    expect(reduceStash(stash, { type: "selection", text: "" }, 120)).toBe(stash);
  });

  it("replaces the stash when a new selection is made", () => {
    const first = reduceStash(null, { type: "selection", text: "first" }, 100);
    const second = reduceStash(first, { type: "selection", text: "second" }, 200);
    expect(second).toEqual({ text: "second", at: 200 });
  });

  it("expires after fifteen seconds, and not a millisecond earlier", () => {
    const stash = { text: "old", at: 0 };
    expect(STASH_TTL_MS).toBe(15_000);
    expect(stashIsFresh(stash, STASH_TTL_MS - 1)).toBe(true);
    expect(stashIsFresh(stash, STASH_TTL_MS)).toBe(false);
    expect(stashIsFresh(null, 0)).toBe(false);
  });

  it("copies the stash, and says so, when the highlight is gone", () => {
    const d = terminalKeydownDecision(ctrlC(), state("", { text: "recovered text", at: 0 }), 5_000);
    expect(d).toMatchObject({
      action: "copy",
      text: "recovered text",
      recovered: true,
      toast: "Copied (recovered)",
      passToTerminal: false,
    });
  });

  it("falls back to SIGINT once the stash is stale", () => {
    const d = terminalKeydownDecision(ctrlC(), state("", { text: "old", at: 0 }), STASH_TTL_MS);
    expect(d).toEqual({ action: "pty", passToTerminal: true });
  });

  /**
   * The live highlight always wins. Copying a stale stash while something else
   * is visibly selected would copy text the user cannot see.
   */
  it("prefers the live selection over a fresh stash", () => {
    const src = copySource(state("live", { text: "stashed", at: 0 }), 1_000);
    expect(src).toEqual({ text: "live", recovered: false });
  });
});

describe("the rest of the keydown contract", () => {
  /**
   * Escape clears AND still reaches the app. Swallowing it breaks vim, where
   * Escape is the most-pressed key in the editor.
   */
  it("clears on Escape and still hands Escape to the app", () => {
    const d = terminalKeydownDecision(key({ key: "Escape" }), state("something"), 0);
    expect(d).toEqual({ action: "clear-selection", reason: "Escape", passToTerminal: true });
  });

  it("leaves Escape alone when there is no selection to clear", () => {
    const d = terminalKeydownDecision(key({ key: "Escape" }), state(""), 0);
    expect(d).toEqual({ action: "pty", passToTerminal: true });
  });

  /**
   * Same range-vs-text split as the chord (term.html:8565 gates on
   * hasSelection()). A highlight of trailing blanks is visible, so Escape has
   * to clear it; deciding on the text would leave it stuck on screen with no
   * key that dismisses it.
   */
  it("clears a highlight whose text trims to nothing, which is still on screen", () => {
    expect(terminalKeydownDecision(key({ key: "Escape" }), blankRange(), 0)).toEqual({
      action: "clear-selection",
      reason: "Escape",
      passToTerminal: true,
    });
  });

  /**
   * xterm consults the handler on keyup as well. Acting there would copy twice
   * per chord, and would let a release copy after the user changed their mind.
   */
  it("does nothing on keyup, only on keydown", () => {
    const d = terminalKeydownDecision(ctrlC({ type: "keyup" }), state("selected"), 0);
    expect(d).toEqual({ action: "pty", passToTerminal: true });
  });

  /**
   * Ctrl+V must not reach the pty as ^V. The browser's own paste event fires
   * instead, and the component routes the text through `term.paste()`, which
   * is what brackets it and normalizes \r\n — raw input would execute a
   * multiline paste line by line in a shell.
   */
  it("hands paste to the browser rather than the pty, selection or not", () => {
    for (const sel of ["", "some selection"]) {
      expect(terminalKeydownDecision(key({ key: "v", code: "KeyV", ctrlKey: true }), state(sel), 0))
        .toEqual({ action: "browser-paste", passToTerminal: false });
    }
    expect(terminalKeydownDecision(key({ key: "м", code: "KeyV", metaKey: true }), state(""), 0))
      .toEqual({ action: "browser-paste", passToTerminal: false });
  });

  it("passes every unrelated key through untouched", () => {
    expect(terminalKeydownDecision(key({ key: "a", code: "KeyA" }), state("sel"), 0)).toEqual({
      action: "pty",
      passToTerminal: true,
    });
  });
});

describe("the terminal.copy command behind the soft key", () => {
  it("copies the selection when there is one", () => {
    expect(copyCommandDecision(state("picked"))).toMatchObject({
      action: "copy",
      text: "picked",
      toast: "Copied",
    });
  });

  /**
   * On touch there is never an xterm selection — a drag scrolls, by design —
   * so a Copy tap that fell through would do nothing at all. The button's
   * intent is unambiguous, so it grabs the visible screen instead.
   */
  it("grabs the visible screen when there is no selection", () => {
    expect(copyCommandDecision(state(""))).toMatchObject({
      action: "capture-screen",
      toast: "Screen copied",
    });
  });

  /**
   * iOS Safari honours a clipboard write only inside the tap's transient
   * activation, which an awaited fetch voids. Where ClipboardItem exists, the
   * fetch goes in as a promise and the write is called synchronously.
   */
  it("hands the capture in as a promise wherever ClipboardItem exists", () => {
    expect(chooseCaptureWrite({ hasClipboardWrite: true, hasClipboardItem: true })).toBe(
      "promise-item",
    );
    expect(chooseCaptureWrite({ hasClipboardWrite: false, hasClipboardItem: true })).toBe(
      "await-text",
    );
    expect(chooseCaptureWrite({ hasClipboardWrite: true, hasClipboardItem: false })).toBe(
      "await-text",
    );
  });
});

describe("OSC 52 writes coming out of the pty", () => {
  /**
   * tmux 3.4 emits an empty selection field (`\x1b]52;;<base64>`). The stock
   * provider accepts only exactly 'c', which is why copy-mode yanks never
   * reached the browser clipboard.
   */
  it("accepts tmux's empty selection field as well as 'c'", () => {
    expect(osc52Accepts("")).toBe(true);
    expect(osc52Accepts("c")).toBe(true);
  });

  it("ignores every other selection field", () => {
    for (const field of ["p", "s", "q", "C", "cp", "clipboard"]) {
      expect(osc52Accepts(field)).toBe(false);
    }
  });

  /**
   * ADR-0003: tmux copy-mode copies land on the OS clipboard "with the same
   * 'Copied' toast as the chord" (term.html:5490). A copy-mode yank leaves no
   * highlight in the browser, so the toast is the only sign it crossed the pty
   * boundary — a provider that writes silently looks broken to the user.
   */
  it("toasts 'Copied' on an accepted write, the only sign a yank landed", () => {
    for (const field of ["", "c"]) {
      expect(osc52WriteDecision(field)).toEqual({
        action: "write",
        toast: "Copied",
        failureToast: null,
      });
    }
  });

  /**
   * term.html swallows a failed OSC 52 write with `.catch(() => {})` (5491),
   * alone among the copy paths here. The pty can emit OSC 52 unprompted, so an
   * error toast would fire for something the user never asked for. The null is
   * the contract, not a gap for a component to fill with 'Copy failed'.
   */
  it("stays silent when an accepted write fails, unlike every other copy path", () => {
    const d = osc52WriteDecision("c");
    expect(d.action).toBe("write");
    expect(d.action === "write" && d.failureToast).toBeNull();
  });

  it("says nothing at all for a selection field that is not this clipboard", () => {
    for (const field of ["p", "s", "q", "C", "cp", "clipboard"]) {
      expect(osc52WriteDecision(field)).toEqual({ action: "ignore" });
    }
  });

  /**
   * Answering an OSC 52 '?' query would let anything running in the pty read
   * the user's clipboard. The refusal is the security boundary.
   */
  it("never reads the clipboard back to the pty", () => {
    expect(osc52ReadText()).toBe("");
  });
});
