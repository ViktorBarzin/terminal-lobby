import { describe, expect, it } from "vitest";
import {
  keyContext,
  matchesAppChord,
  resolveAlways,
  resolveBindings,
} from "../src/keybindings/bindings.logic";
import type { ChordEventLike } from "../src/keybindings/chords.logic";
import { idleMods, type SoftMods } from "../src/mobile/softmods";
import { EMPTY_HELD, type HeldState } from "../src/terminal/held";
import {
  reduceStash,
  STASH_TTL_MS,
  type SelectionStash,
  type SelectionState,
} from "../src/terminal/selection";
import {
  COPY_FAILURE_TOAST_MS,
  COPY_TOAST_MS,
  DISCARD_HELD_TOAST,
  reduce,
  reduceData,
  WORD_LEFT,
  WORD_RIGHT,
  type DataAction,
  type DataWorld,
  type KeyAction,
  type KeyLeg,
  type KeyWorld,
} from "../src/terminal/keys";

const NOW = 10_000;

const ev = (over: Partial<ChordEventLike> = {}): ChordEventLike => ({
  type: "keydown",
  key: "",
  code: "",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

const NO_SELECTION: SelectionState = { hasSelection: false, selection: "", stash: null };

/** The ordinary case: a highlight is on screen and it yields its text. */
const selected = (text: string): SelectionState => ({
  hasSelection: true,
  selection: text,
  stash: null,
});

/**
 * The case this project has already got wrong once (ADR-0017, ADR-0003): a drag
 * released inside a row's trailing blank space. xterm right-trims every row it
 * hands back, so the RANGE is on screen and `getSelection()` is "".
 */
const BLANK_RANGE: SelectionState = { hasSelection: true, selection: "", stash: null };

const stashed = (text: string, age: number): SelectionState => ({
  hasSelection: false,
  selection: "",
  stash: { text, at: NOW - age },
});

/** A hold with glyphs on it: term.html's `heldShadow` holding a line. */
const HOLDING: HeldState = { text: "ls -la", enter: false, since: 100, active: true };

/**
 * A hold whose line was backspaced away. `active` is still true, which is the
 * whole reason held.ts stores it rather than deriving it from the text.
 */
const EMPTIED_HOLD: HeldState = { text: "", enter: false, since: 0, active: true };

const world = (over: Partial<KeyWorld> = {}): KeyWorld => ({
  now: NOW,
  macLike: false,
  appChord: false,
  selection: NO_SELECTION,
  held: EMPTY_HELD,
  heldDim: false,
  ...over,
});

/** term.html:8560-8562, in that order: discard, say so, then swallow the key. */
const DISCARD: readonly KeyAction[] = [
  { kind: "discard-held" },
  { kind: "toast", message: DISCARD_HELD_TOAST, toastKind: "info", timeoutMs: 2500 },
  { kind: "prevent-default" },
];

/**
 * term.html:8570-8572 for the live path and :8579-8581 for the recovered one:
 * the same three arguments to `showToast` on each side, so the kind and the
 * duration are part of every row rather than something a wiring picks.
 */
const copyAction = (text: string, recovered: boolean): KeyAction => ({
  kind: "copy",
  text,
  recovered,
  toast: recovered ? "Copied (recovered)" : "Copied",
  toastKind: "success",
  timeoutMs: 1500,
  failureToast: "Copy blocked by browser",
  failureToastKind: "error",
  failureTimeoutMs: 2500,
});

interface Row {
  readonly name: string;
  readonly world: KeyWorld;
  readonly event: ChordEventLike;
  readonly leg: KeyLeg;
  /** Exactly what `attachCustomKeyEventHandler` must return. */
  readonly pass: boolean;
  readonly actions: readonly KeyAction[];
}

/**
 * Every leg of term.html:8516-8589, in the order the handler tests them, with
 * the rows that prove each guard. Each block names the branch it exercises.
 */
const LEGS: readonly Row[] = [
  // --- :8517, the handler is consulted on keyup and keypress too -----------
  {
    name: "a keyup is not ours, even when a keydown would have acted",
    world: world({ selection: selected("hello") }),
    event: ev({ type: "keyup", key: "Escape" }),
    leg: "not-keydown",
    pass: true,
    actions: [],
  },
  {
    name: "a keypress is not ours either",
    world: world({ selection: selected("hello") }),
    event: ev({ type: "keypress", key: "c", code: "KeyC", ctrlKey: true }),
    leg: "not-keydown",
    pass: true,
    actions: [],
  },

  // --- :8518-8526, the keybinding layer already ran the command ------------
  {
    name: "an app chord never reaches the pty",
    world: world({ appChord: true }),
    event: ev({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true }),
    leg: "app-chord",
    pass: false,
    actions: [],
  },
  {
    name: "an app chord wins over F12",
    world: world({ appChord: true }),
    event: ev({ key: "F12" }),
    leg: "app-chord",
    pass: false,
    actions: [],
  },
  {
    name: "an app chord wins over the word jump",
    world: world({ appChord: true, macLike: true }),
    event: ev({ key: "ArrowLeft", altKey: true }),
    leg: "app-chord",
    pass: false,
    actions: [],
  },
  {
    name: "an app chord wins over discarding a hold",
    world: world({ appChord: true, held: HOLDING }),
    event: ev({ key: "Escape" }),
    leg: "app-chord",
    pass: false,
    actions: [],
  },
  {
    name: "an app chord wins over the copy chord",
    world: world({ appChord: true, selection: selected("hello") }),
    event: ev({ key: "c", code: "KeyC", ctrlKey: true }),
    leg: "app-chord",
    pass: false,
    actions: [],
  },
  {
    /**
     * The ALWAYS-ON chord, and the only kind of appChord that fires with the
     * keybinding layer switched off: `matchesAppChord` walks
     * `KB_ALWAYS_BINDINGS` before the `enabled` gate (bindings.logic.ts:302-309,
     * term.html:3528-3533). Every other row in this block is a default chord,
     * which is why this one is here.
     */
    name: "the always-on kill chord is an app chord, layer enabled or not",
    world: world({ appChord: true }),
    event: ev({ key: "Backspace", code: "Backspace", altKey: true, shiftKey: true }),
    leg: "app-chord",
    pass: false,
    actions: [],
  },
  {
    /** term.html's other always-on row, `ctrl+j` -> `session.new.shell` (:3382). */
    name: "term.html's always-on Ctrl+J is an app chord too",
    world: world({ appChord: true }),
    event: ev({ key: "j", code: "KeyJ", ctrlKey: true }),
    leg: "app-chord",
    pass: false,
    actions: [],
  },
  {
    /**
     * The other side of those two rows, which is the wiring hazard rather than
     * a feature: an always-on chord whose `appChord` was never read is an
     * ordinary key here, and xterm 6.0.0 turns this one into ESC DEL (its
     * Backspace arm reads `ctrlKey` and `altKey`, never `shiftKey`). The
     * session would be killed AND the bytes would land on the pty, which is
     * what `KeyWorld.appChord` says to read unconditionally to avoid.
     */
    name: "the same kill chord with appChord unread is just a key for xterm",
    world: world(),
    event: ev({ key: "Backspace", code: "Backspace", altKey: true, shiftKey: true }),
    leg: "pty",
    pass: true,
    actions: [],
  },
  {
    /** The same for Ctrl+J, which xterm sends to the pty as 0x0A. */
    name: "Ctrl+J with appChord unread is just a key for xterm",
    world: world(),
    event: ev({ key: "j", code: "KeyJ", ctrlKey: true }),
    leg: "pty",
    pass: true,
    actions: [],
  },

  // --- :8527-8536, F12 opens devtools --------------------------------------
  {
    name: "bare F12 goes wholly to the browser",
    world: world(),
    event: ev({ key: "F12" }),
    leg: "devtools",
    pass: false,
    actions: [],
  },
  {
    name: "F12 still opens devtools over a live selection",
    world: world({ selection: selected("hello") }),
    event: ev({ key: "F12" }),
    leg: "devtools",
    pass: false,
    actions: [],
  },
  {
    name: "Shift+F12 stays with xterm",
    world: world(),
    event: ev({ key: "F12", shiftKey: true }),
    leg: "pty",
    pass: true,
    actions: [],
  },
  {
    name: "Ctrl+F12 stays with xterm",
    world: world(),
    event: ev({ key: "F12", ctrlKey: true }),
    leg: "pty",
    pass: true,
    actions: [],
  },
  {
    name: "Alt+F12 stays with xterm",
    world: world(),
    event: ev({ key: "F12", altKey: true }),
    leg: "pty",
    pass: true,
    actions: [],
  },
  {
    name: "Cmd+F12 stays with xterm",
    world: world(),
    event: ev({ key: "F12", metaKey: true }),
    leg: "pty",
    pass: true,
    actions: [],
  },

  // --- :8537-8553, Option+Arrow is a word jump -----------------------------
  {
    name: "Option+Left sends ESC b on a Mac",
    world: world({ macLike: true }),
    event: ev({ key: "ArrowLeft", altKey: true }),
    leg: "word-jump",
    pass: false,
    actions: [{ kind: "send", data: WORD_LEFT }, { kind: "prevent-default" }],
  },
  {
    name: "Option+Right sends ESC f on a Mac",
    world: world({ macLike: true }),
    event: ev({ key: "ArrowRight", altKey: true }),
    leg: "word-jump",
    pass: false,
    actions: [{ kind: "send", data: WORD_RIGHT }, { kind: "prevent-default" }],
  },
  {
    /**
     * :8548 is tested before the Escape/copy tail at :8565, so a highlight on
     * screen changes nothing about a word jump. The two cannot both fire for
     * one event (the copy chord needs Ctrl or Cmd and rejects Alt), which is
     * why this row asserts the LEG: it is what separates "the jump won" from
     * "the tail answered pty and the jump never ran".
     */
    name: "Option+Left is still a word jump with a highlight on screen",
    world: world({ macLike: true, selection: selected("hello") }),
    event: ev({ key: "ArrowLeft", altKey: true }),
    leg: "word-jump",
    pass: false,
    actions: [{ kind: "send", data: WORD_LEFT }, { kind: "prevent-default" }],
  },
  {
    name: "Option+Right is still a word jump over a fresh stash",
    world: world({ macLike: true, selection: stashed("older", 1_000) }),
    event: ev({ key: "ArrowRight", altKey: true }),
    leg: "word-jump",
    pass: false,
    actions: [{ kind: "send", data: WORD_RIGHT }, { kind: "prevent-default" }],
  },
  {
    name: "Alt+Left off a Mac stays with xterm, where Ctrl+Arrow is the word motion",
    world: world({ macLike: false }),
    event: ev({ key: "ArrowLeft", altKey: true }),
    leg: "pty",
    pass: true,
    actions: [],
  },
  {
    name: "Option+Shift+Left stays with xterm, so the selection form survives",
    world: world({ macLike: true }),
    event: ev({ key: "ArrowLeft", altKey: true, shiftKey: true }),
    leg: "pty",
    pass: true,
    actions: [],
  },
  {
    name: "Ctrl+Option+Left stays with xterm",
    world: world({ macLike: true }),
    event: ev({ key: "ArrowLeft", altKey: true, ctrlKey: true }),
    leg: "pty",
    pass: true,
    actions: [],
  },
  {
    name: "Cmd+Option+Left stays with xterm",
    world: world({ macLike: true }),
    event: ev({ key: "ArrowLeft", altKey: true, metaKey: true }),
    leg: "pty",
    pass: true,
    actions: [],
  },
  {
    name: "Option+Up is not a word jump",
    world: world({ macLike: true }),
    event: ev({ key: "ArrowUp", altKey: true }),
    leg: "pty",
    pass: true,
    actions: [],
  },
  {
    name: "a plain Left arrow stays with xterm",
    world: world({ macLike: true }),
    event: ev({ key: "ArrowLeft" }),
    leg: "pty",
    pass: true,
    actions: [],
  },

  // --- :8554-8564, Esc throws a hold away ----------------------------------
  {
    name: "Esc discards a hold that is on screen",
    world: world({ held: HOLDING }),
    event: ev({ key: "Escape" }),
    leg: "discard-held",
    pass: false,
    actions: DISCARD,
  },
  {
    name: "Esc discards a hold whose line was backspaced empty",
    world: world({ held: EMPTIED_HOLD }),
    event: ev({ key: "Escape" }),
    leg: "discard-held",
    pass: false,
    actions: DISCARD,
  },
  {
    name: "Shift+Esc discards too: term.html guards ctrl, alt and meta, not shift",
    world: world({ held: HOLDING }),
    event: ev({ key: "Escape", shiftKey: true }),
    leg: "discard-held",
    pass: false,
    actions: DISCARD,
  },
  {
    name: "discarding the hold wins over clearing the selection",
    world: world({ held: HOLDING, selection: selected("hello") }),
    event: ev({ key: "Escape" }),
    leg: "discard-held",
    pass: false,
    actions: DISCARD,
  },
  {
    name: "Esc leaves a REPLAYED hold alone, and clears the selection instead",
    world: world({ held: HOLDING, heldDim: true, selection: selected("hello") }),
    event: ev({ key: "Escape" }),
    leg: "clear-selection",
    pass: true,
    actions: [{ kind: "clear-selection", reason: "Escape" }],
  },
  {
    /**
     * The other half of the `heldDim` guard, with no selection to fall through
     * to: a replayed run is already on the wire, so Escape has nothing to throw
     * away and belongs to the app. `heldDim` is what term.html reads at :8559,
     * and without this row the only dim case in the table is one where the
     * Escape had a selection to clear anyway.
     */
    name: "Esc with a REPLAYED hold and nothing selected reaches the app",
    world: world({ held: HOLDING, heldDim: true }),
    event: ev({ key: "Escape" }),
    leg: "pty",
    pass: true,
    actions: [],
  },
  {
    name: "Esc with nothing held and nothing selected goes to the app",
    world: world(),
    event: ev({ key: "Escape" }),
    leg: "pty",
    pass: true,
    actions: [],
  },
  {
    name: "Ctrl+Esc does not discard a hold",
    world: world({ held: HOLDING }),
    event: ev({ key: "Escape", ctrlKey: true }),
    leg: "pty",
    pass: true,
    actions: [],
  },
  {
    name: "Alt+Esc does not discard a hold",
    world: world({ held: HOLDING }),
    event: ev({ key: "Escape", altKey: true }),
    leg: "pty",
    pass: true,
    actions: [],
  },
  {
    name: "Cmd+Esc does not discard a hold",
    world: world({ held: HOLDING }),
    event: ev({ key: "Escape", metaKey: true }),
    leg: "pty",
    pass: true,
    actions: [],
  },

  // --- :8565-8568, Esc clears a selection AND reaches the app --------------
  {
    name: "Esc clears a live selection and still reaches the app",
    world: world({ selection: selected("hello") }),
    event: ev({ key: "Escape" }),
    leg: "clear-selection",
    pass: true,
    actions: [{ kind: "clear-selection", reason: "Escape" }],
  },
  {
    name: "Esc clears a trailing-whitespace range, which yields no text",
    world: world({ selection: BLANK_RANGE }),
    event: ev({ key: "Escape" }),
    leg: "clear-selection",
    pass: true,
    actions: [{ kind: "clear-selection", reason: "Escape" }],
  },

  // --- :8569-8584, the copy chord ------------------------------------------
  {
    name: "Ctrl+C copies a live selection and never reaches the pty",
    world: world({ selection: selected("hello") }),
    event: ev({ key: "c", code: "KeyC", ctrlKey: true }),
    leg: "copy",
    pass: false,
    actions: [copyAction("hello", false)],
  },
  {
    name: "Cmd+C copies a live selection",
    world: world({ selection: selected("hello") }),
    event: ev({ key: "c", code: "KeyC", metaKey: true }),
    leg: "copy",
    pass: false,
    actions: [copyAction("hello", false)],
  },
  {
    name: "Ctrl+C on a trailing-whitespace range copies nothing and is still swallowed",
    world: world({ selection: BLANK_RANGE }),
    event: ev({ key: "c", code: "KeyC", ctrlKey: true }),
    leg: "copy",
    pass: false,
    actions: [copyAction("", false)],
  },
  {
    name: "Cmd+C on a trailing-whitespace range is swallowed too",
    world: world({ selection: BLANK_RANGE }),
    event: ev({ key: "c", code: "KeyC", metaKey: true }),
    leg: "copy",
    pass: false,
    actions: [copyAction("", false)],
  },
  {
    name: "Ctrl+C on a Cyrillic layout copies, matched by e.code",
    world: world({ selection: BLANK_RANGE }),
    event: ev({ key: "с", code: "KeyC", ctrlKey: true }),
    leg: "copy",
    pass: false,
    actions: [copyAction("", false)],
  },
  {
    name: "Ctrl+C falls back to a fresh stash when a repaint took the highlight",
    world: world({ selection: stashed("older", 1_000) }),
    event: ev({ key: "c", code: "KeyC", ctrlKey: true }),
    leg: "copy",
    pass: false,
    actions: [copyAction("older", true)],
  },
  {
    name: "Ctrl+C with a stale stash is SIGINT again",
    world: world({ selection: stashed("older", STASH_TTL_MS) }),
    event: ev({ key: "c", code: "KeyC", ctrlKey: true }),
    leg: "pty",
    pass: true,
    actions: [],
  },
  {
    name: "Ctrl+C with nothing selected reaches the pty as SIGINT",
    world: world(),
    event: ev({ key: "c", code: "KeyC", ctrlKey: true }),
    leg: "pty",
    pass: true,
    actions: [],
  },
  {
    /**
     * term.html's `isChord` (:8512) guards ctrl/meta and alt and says nothing
     * about shift, so Ctrl+Shift+C copies exactly like Ctrl+C. That asymmetry
     * is asserted for Escape elsewhere in this table; here is the same rule on
     * the chord, where a stray `!e.shiftKey` would be easy to add and would
     * send SIGINT with a highlight up.
     */
    name: "Ctrl+Shift+C copies too: the chord guards ctrl, meta and alt, not shift",
    world: world({ selection: selected("hello") }),
    event: ev({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: true }),
    leg: "copy",
    pass: false,
    actions: [copyAction("hello", false)],
  },
  {
    name: "Cmd+Shift+C copies too",
    world: world({ selection: selected("hello") }),
    event: ev({ key: "C", code: "KeyC", metaKey: true, shiftKey: true }),
    leg: "copy",
    pass: false,
    actions: [copyAction("hello", false)],
  },
  {
    name: "Ctrl+Alt+C is an AltGr typing chord, not a copy",
    world: world({ selection: selected("hello") }),
    event: ev({ key: "c", code: "KeyC", ctrlKey: true, altKey: true }),
    leg: "pty",
    pass: true,
    actions: [],
  },

  // --- :8585-8587, paste ---------------------------------------------------
  {
    name: "Ctrl+V sends nothing and lets the browser paste event fire",
    world: world(),
    event: ev({ key: "v", code: "KeyV", ctrlKey: true }),
    leg: "browser-paste",
    pass: false,
    actions: [],
  },
  {
    name: "Cmd+V does the same",
    world: world(),
    event: ev({ key: "v", code: "KeyV", metaKey: true }),
    leg: "browser-paste",
    pass: false,
    actions: [],
  },
  {
    /** Shift is unguarded on the paste chord for the same reason (:8512). */
    name: "Ctrl+Shift+V is still a paste",
    world: world(),
    event: ev({ key: "V", code: "KeyV", ctrlKey: true, shiftKey: true }),
    leg: "browser-paste",
    pass: false,
    actions: [],
  },
  {
    name: "Ctrl+V on a Cyrillic layout is still a paste, matched by e.code",
    world: world(),
    event: ev({ key: "м", code: "KeyV", ctrlKey: true }),
    leg: "browser-paste",
    pass: false,
    actions: [],
  },

  // --- :8588, everything else ---------------------------------------------
  {
    name: "an ordinary letter goes to the pty",
    world: world(),
    event: ev({ key: "a", code: "KeyA" }),
    leg: "pty",
    pass: true,
    actions: [],
  },
  {
    name: "Ctrl+D goes to the pty even with a selection up",
    world: world({ selection: selected("hello") }),
    event: ev({ key: "d", code: "KeyD", ctrlKey: true }),
    leg: "pty",
    pass: true,
    actions: [],
  },
];

describe("the one key handler xterm stores", () => {
  it.each(LEGS)("$name", (row) => {
    const r = reduce(row.world, row.event);
    expect(r.leg).toBe(row.leg);
    expect(r.passToTerminal).toBe(row.pass);
    expect(r.actions).toEqual(row.actions);
  });

  it("covers every leg of term.html's handler", () => {
    const covered = [...new Set(LEGS.map((row) => row.leg))].sort();
    expect(covered).toEqual([
      "app-chord",
      "browser-paste",
      "clear-selection",
      "copy",
      "devtools",
      "discard-held",
      "not-keydown",
      "pty",
      "word-jump",
    ]);
  });

  /**
   * The bytes, not just the constants. iTerm2 sends these for Option+Arrow and
   * zsh binds them to backward-word / forward-word; xterm's own modifier-3
   * cursor form (ESC [ 1;3D) is `undefined-key` there, which is the reported bug.
   */
  it("sends the universal Meta-b / Meta-f bytes", () => {
    expect(WORD_LEFT).toBe("\x1bb");
    expect(WORD_RIGHT).toBe("\x1bf");
  });

  /** term.html:8561, byte for byte, so the two builds say the same sentence. */
  it("says term.html's own line when it throws a hold away", () => {
    expect(DISCARD_HELD_TOAST).toBe("Discarded what you typed while offline");
  });

  /**
   * The failure ADR-0003 exists to prevent, asserted on its own rather than
   * left implicit in the table: a drag into trailing whitespace has a RANGE and
   * no text, and gating the chord on the text would send SIGINT with a
   * highlight on screen.
   */
  it("never lets Ctrl+C through while a highlight is on screen", () => {
    for (const selection of [selected("hello"), BLANK_RANGE]) {
      const r = reduce(world({ selection }), ev({ key: "c", code: "KeyC", ctrlKey: true }));
      expect(r.passToTerminal).toBe(false);
      expect(r.leg).toBe("copy");
    }
  });

  /**
   * The two arguments the wording alone would lose. term.html:8570-8572 is
   * `writeText(...).then(() => showToast('Copied', 'success', 1500)).catch(()
   * => showToast('Copy blocked by browser', 'error', 2500))`, and the recovered
   * path passes the same pair (:8579-8581). `showToast` defaults its kind to
   * "info" (src/store/toast.ts:200-205), so an action carrying only the two
   * strings would ship a different toast than the page does with nothing
   * failing. Written out here rather than through `copyAction`, so the helper
   * cannot hide a wrong value from both places at once.
   */
  it("carries term.html's toast kind and duration on both copy paths", () => {
    const chord = ev({ key: "c", code: "KeyC", ctrlKey: true });
    expect(reduce(world({ selection: selected("hello") }), chord).actions).toEqual([
      {
        kind: "copy",
        text: "hello",
        recovered: false,
        toast: "Copied",
        toastKind: "success",
        timeoutMs: 1500,
        failureToast: "Copy blocked by browser",
        failureToastKind: "error",
        failureTimeoutMs: 2500,
      },
    ]);
    expect(reduce(world({ selection: stashed("older", 1_000) }), chord).actions).toEqual([
      {
        kind: "copy",
        text: "older",
        recovered: true,
        toast: "Copied (recovered)",
        toastKind: "success",
        timeoutMs: 1500,
        failureToast: "Copy blocked by browser",
        failureToastKind: "error",
        failureTimeoutMs: 2500,
      },
    ]);
    expect([COPY_TOAST_MS, COPY_FAILURE_TOAST_MS]).toEqual([1500, 2500]);
  });

  /**
   * The order inside the `clear-selection` action, which the action itself
   * cannot enforce. term.html's `clearSelectionBecause` reads
   * `if (!term.hasSelection()) return` at :5893 and only clears at :5897, so an
   * Escape over a live highlight kills the stash and the next Ctrl+C is SIGINT
   * again. Composed with selection.ts's `reduceStash` BOTH ways round, because
   * the wrong order fails silently: clear first and the read reports false, the
   * stash outlives its own dismissal, and the next Ctrl+C copies text the
   * person already dismissed instead of interrupting the process.
   */
  it("kills the stash on Escape only if hasSelection is read before the clear", () => {
    const stash: SelectionStash = { text: "dismissed", at: NOW - 1_000 };
    const chord = ev({ key: "c", code: "KeyC", ctrlKey: true });
    const withStash = (kept: SelectionStash | null): KeyWorld =>
      world({ selection: { hasSelection: false, selection: "", stash: kept } });

    const live: SelectionState = { hasSelection: true, selection: "dismissed", stash };
    expect(reduce(world({ selection: live }), ev({ key: "Escape" })).actions).toEqual([
      { kind: "clear-selection", reason: "Escape" },
    ]);

    // Read, then clear: `hasSelection` is still true, so the stash dies with it.
    const inOrder = reduceStash(stash, { type: "dismissed", hasSelection: true }, NOW);
    expect(inOrder).toBeNull();
    expect(reduce(withStash(inOrder), chord).leg).toBe("pty");

    // Clear, then read: false, and the dismissal is a no-op on the stash.
    const reversed = reduceStash(stash, { type: "dismissed", hasSelection: false }, NOW);
    expect(reversed).toBe(stash);
    expect(reduce(withStash(reversed), chord).leg).toBe("copy");
  });

  /**
   * term.html's `discardHeldInput` (:8237-8242) clears the queue, drops the
   * shadow AND sets `heldDim = false`, which is why the action carries none of
   * those three. Escape twice in a row is where a component that performed only
   * part of it would show up: the second one has nothing to throw away and
   * belongs to whatever is running in the pty.
   */
  it("has nothing left to discard on a second Escape", () => {
    const escape = ev({ key: "Escape" });
    expect(reduce(world({ held: HOLDING }), escape).leg).toBe("discard-held");
    const second = reduce(world({ held: EMPTY_HELD, heldDim: false }), escape);
    expect(second.leg).toBe("pty");
    expect(second.passToTerminal).toBe(true);
    expect(second.actions).toEqual([]);
  });

  /**
   * The word jump goes out through the ordinary input choke point, so watch
   * mode still drops it and a dead socket still holds it. Asserted as bytes on
   * a `send` action rather than as anything this module performs.
   */
  it("routes the word jump through the input path rather than writing it", () => {
    const r = reduce(world({ macLike: true }), ev({ key: "ArrowRight", altKey: true }));
    expect(r.actions.filter((a) => a.kind === "send")).toEqual([
      { kind: "send", data: "\x1bf" },
    ]);
  });

  /**
   * An absent `type` is a keydown, matching selection.ts's own leniency. This
   * is the module's one declared divergence from the line it ports: :8517 is
   * `e.type !== 'keydown'`, which returns true for an event with no type at
   * all. Only a test can reach it, since `type` is always a string on a real
   * KeyboardEvent, and term.html's own `matchesAppChord` is lenient here too
   * (:3522). Asserted so the divergence is on the record rather than latent.
   */
  it("treats an event with no type as a keydown", () => {
    const r = reduce(world({ selection: selected("hello") }), {
      key: "Escape",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    });
    expect(r.leg).toBe("clear-selection");
  });

  /**
   * `appChord` joined to the REAL matcher rather than asserted as a boolean,
   * for the one configuration a wiring is most likely to skip the read in.
   * `matchesAppChord` walks the always-on table before the `enabled` gate
   * (bindings.logic.ts:302-309; term.html:3528-3533 in the same order), so
   * `alt+shift+backspace` -> `session.kill.current` matches with
   * `enabled: false`, and the lobby context that guards it is hardcoded
   * `lobbyOpen: true` (`keyContext`, :250). A component that read the matcher
   * only while the layer was on would kill the session AND hand xterm the key,
   * whose Backspace arm sends ESC DEL. Written against the table rather than
   * against a literal so that changing `KB_ALWAYS_BINDINGS` has to come past
   * this test.
   */
  it("swallows an always-on chord while the keybinding layer is disabled", () => {
    const kill = ev({ key: "Backspace", code: "Backspace", altKey: true, shiftKey: true });
    const matched = matchesAppChord(kill, {
      enabled: false,
      resolvedDefaults: resolveBindings({}),
      resolvedAlways: resolveAlways(),
      ctx: keyContext({
        paletteOpen: false,
        helpOpen: false,
        settingsOpen: false,
        galleryOpen: false,
        previewOpen: false,
        previewDirty: false,
      }),
    });
    expect(matched?.command).toBe("session.kill.current");

    const read = reduce(world({ appChord: matched !== null }), kill);
    expect(read.leg).toBe("app-chord");
    expect(read.passToTerminal).toBe(false);

    // The same event with the read skipped: xterm gets it, and the pty gets
    // ESC DEL on top of the kill the engine's own listener already ran.
    expect(reduce(world({ appChord: false }), kill).passToTerminal).toBe(true);
  });
});

/* ------------------------------------------------------------------------- *
 * The onData wrapper's armed soft-modifier remap (term.html:8340-8360).
 * ------------------------------------------------------------------------- */

const mods = (over: Partial<SoftMods> = {}): SoftMods => ({ ...idleMods(), ...over });

/** Ordinary typing: the bytes are not the compose mirror's own (:8342). */
const TYPED: DataWorld = { mirrorEmitting: false };

/** The mirror feeding its own delta through `term.input` (:7232-7236). */
const MIRRORING: DataWorld = { mirrorEmitting: true };

/**
 * term.html:8341-8342, ahead of the chunk and unconditional. `cancel-momentum`
 * is `cancelScrollMomentum()`; `mirror-out-of-band` is the `mirrorLineReset()`
 * that the `!mirrorEmitting` gate lets through.
 */
const HEAD: readonly DataAction[] = [
  { kind: "cancel-momentum" },
  { kind: "mirror-out-of-band" },
];

interface DataRow {
  readonly name: string;
  readonly mods: SoftMods | null;
  readonly data: string;
  readonly sent: string;
  readonly after: SoftMods | null;
}

const DATA: readonly DataRow[] = [
  {
    name: "no toolbar at all: the bytes go out untouched",
    mods: null,
    data: "c",
    sent: "c",
    after: null,
  },
  {
    name: "nothing armed: the bytes go out untouched",
    mods: mods(),
    data: "c",
    sent: "c",
    after: mods(),
  },
  {
    name: "Ctrl armed turns c into ^C, and the arm is spent",
    mods: mods({ ctrl: "armed" }),
    data: "c",
    sent: "\x03",
    after: mods(),
  },
  {
    name: "Ctrl latched turns c into ^C and stays latched",
    mods: mods({ ctrl: "latched" }),
    data: "c",
    sent: "\x03",
    after: mods({ ctrl: "latched" }),
  },
  {
    name: "Ctrl armed lowercases first, so a shifted C is still ^C",
    mods: mods({ ctrl: "armed" }),
    data: "C",
    sent: "\x03",
    after: mods(),
  },
  {
    name: "Alt armed prefixes ESC",
    mods: mods({ alt: "armed" }),
    data: "b",
    sent: "\x1bb",
    after: mods(),
  },
  {
    name: "both armed compose: ESC then the control byte",
    mods: mods({ ctrl: "armed", alt: "armed" }),
    data: "c",
    sent: "\x1b\x03",
    after: mods(),
  },
  {
    name: "Ctrl armed over a digit leaves the byte alone but still spends the arm",
    mods: mods({ ctrl: "armed" }),
    data: "1",
    sent: "1",
    after: mods(),
  },
  {
    name: "only the first character is remapped: abc becomes ^A then bc",
    mods: mods({ ctrl: "armed" }),
    data: "abc",
    sent: "\x01bc",
    after: mods(),
  },
  {
    name: "an arrow's escape sequence is not a letter, and the arm is spent on it",
    mods: mods({ ctrl: "armed" }),
    data: "\x1b[A",
    sent: "\x1b[A",
    after: mods(),
  },
  {
    name: "Alt latched over an escape sequence prefixes a second ESC",
    mods: mods({ alt: "latched" }),
    data: "\x1b[A",
    sent: "\x1b\x1b[A",
    after: mods({ alt: "latched" }),
  },
];

describe("the armed soft-modifier remap", () => {
  it.each(DATA)("$name", (row) => {
    const r = reduceData({ mods: row.mods }, row.data, TYPED);
    expect(r.actions).toEqual([...HEAD, { kind: "send", data: row.sent }]);
    expect(r.state.mods).toEqual(row.after);
  });

  /**
   * term.html gates the whole block on `if (softMods && data)` (:8343), so an
   * empty chunk sends and spends nothing. Identity, not equality: a component
   * holding these in a signal must not be woken by a chunk that changed
   * nothing. Both modifiers, because the gate is one `if` for the pair and an
   * Alt-only arm has to survive it too.
   */
  it.each([
    { name: "Ctrl", armed: mods({ ctrl: "armed" }) },
    { name: "Alt", armed: mods({ alt: "armed" }) },
  ])("spends no armed $name on an empty chunk", (row) => {
    const r = reduceData({ mods: row.armed }, "", TYPED);
    expect(r.actions).toEqual([...HEAD, { kind: "send", data: "" }]);
    expect(r.state.mods).toBe(row.armed);
  });

  it("returns the same modifiers when none was active", () => {
    const idle = mods();
    expect(reduceData({ mods: idle }, "c", TYPED).state.mods).toBe(idle);
    expect(reduceData({ mods: null }, "c", TYPED).state.mods).toBeNull();
  });

  /** The one-shot really is one-shot: the second key is not remapped. */
  it("remaps exactly one keystroke per arm", () => {
    const first = reduceData({ mods: mods({ ctrl: "armed" }) }, "c", TYPED);
    expect(first.actions).toEqual([...HEAD, { kind: "send", data: "\x03" }]);
    const second = reduceData(first.state, "c", TYPED);
    expect(second.actions).toEqual([...HEAD, { kind: "send", data: "c" }]);
  });
});

/* ------------------------------------------------------------------------- *
 * The two unconditional calls at the head of the same hook (:8341-8342).
 * ------------------------------------------------------------------------- */

describe("the head of the onData hook", () => {
  /**
   * :8341 and :8342 sit ABOVE the `if (softMods && data)` gate, so they run on
   * every chunk: with no toolbar at all, with an arm spent, and on the empty
   * chunk that spends nothing. `cancel-momentum` is touchscroll.ts's
   * `{ type: "interrupt" }` and `mirror-out-of-band` is mirror.ts's
   * `{ type: "out-of-band", value }`, in term.html's order and both ahead of
   * the bytes.
   */
  it.each([
    { name: "no toolbar", mods: null, data: "a" },
    { name: "an idle toolbar", mods: mods(), data: "a" },
    { name: "an armed Ctrl", mods: mods({ ctrl: "armed" }), data: "a" },
    { name: "a latched Alt", mods: mods({ alt: "latched" }), data: "a" },
    { name: "an empty chunk", mods: mods({ ctrl: "armed" }), data: "" },
  ])("cancels a coast and resets the mirror baseline with $name", (row) => {
    const r = reduceData({ mods: row.mods }, row.data, TYPED);
    expect(r.actions.slice(0, 2)).toEqual(HEAD);
    expect(r.actions.filter((a) => a.kind === "send")).toHaveLength(1);
  });

  /**
   * The one gate on the pair. Bytes the mirror itself fed through `term.input`
   * are not out of band, and resetting on them would clear the field the person
   * is typing into mid-word, which is the desync the flag exists to prevent
   * (term.html:8342, `if (!mirrorEmitting)`). The coast cancel is NOT gated:
   * :8341 runs first and unconditionally, and its comment names the mirror as
   * one of the byte sources it cancels for.
   */
  it("skips the mirror reset for the mirror's own bytes, and still cancels the coast", () => {
    const r = reduceData({ mods: null }, "a", MIRRORING);
    expect(r.actions).toEqual([{ kind: "cancel-momentum" }, { kind: "send", data: "a" }]);
  });
});

/* ------------------------------------------------------------------------- *
 * The paste hazard the remap's doc block describes (term.html:8973, :8978).
 * ------------------------------------------------------------------------- */

describe("a paste reaching the remap", () => {
  /** What `term.paste` produces once the app has asked for bracketed paste. */
  const BRACKETED = "\x1b[200~ls -la\x1b[201~";

  /**
   * `term.paste()` ends in `coreService.triggerDataEvent`, so pasted text
   * arrives here like a keystroke and its first character is the ESC of
   * `ESC [200~`. An armed Ctrl is therefore spent on a character no Ctrl remap
   * applies to, and the arm is gone before the letter it was armed for.
   * term.html disarms with `consumeSoftMods()` immediately before `term.paste`
   * (:8973, :8978) so this cannot happen; the reducer keeps the behaviour that
   * makes the disarm necessary rather than papering over it.
   */
  it("spends an armed Ctrl on the ESC of a bracketed paste", () => {
    const r = reduceData({ mods: mods({ ctrl: "armed" }) }, BRACKETED, TYPED);
    expect(r.actions).toEqual([...HEAD, { kind: "send", data: BRACKETED }]);
    expect(r.state.mods).toEqual(mods());
  });

  /**
   * The worse half of the same hazard, and the reason the caller's disarm has
   * to happen even for a LATCHED modifier: Alt prefixes an ESC, so the frame
   * the pty parses starts `ESC ESC [ 200 ~` and the bracket introducer is
   * corrupted. `consumeSoftMods` leaves a latch alone, which is term.html's
   * asymmetry and this reducer's too, so the only thing standing between a
   * latched Alt and a mangled paste is that the caller disarms first.
   */
  it("prepends a second ESC when Alt is latched, corrupting the introducer", () => {
    const r = reduceData({ mods: mods({ alt: "latched" }) }, BRACKETED, TYPED);
    expect(r.actions).toEqual([...HEAD, { kind: "send", data: "\x1b" + BRACKETED }]);
    expect(r.state.mods).toEqual(mods({ alt: "latched" }));
  });

  /** With the caller's disarm done first, the bytes go out untouched. */
  it("leaves the paste alone once the caller has disarmed", () => {
    const r = reduceData({ mods: mods() }, BRACKETED, TYPED);
    expect(r.actions).toEqual([...HEAD, { kind: "send", data: BRACKETED }]);
  });
});
