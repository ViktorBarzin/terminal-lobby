/**
 * Selection → clipboard decisions for the native xterm terminal.
 *
 * Ported from the copy half of `frontend/term.html` (ADR-0003, native
 * select/copy). Everything here is pure: it takes the selection, the recovery
 * stash and a clock reading, and returns what should happen. No clipboard
 * call, no DOM, no xterm import — the component does the writing, so the rules
 * stay testable.
 *
 * Out of scope on purpose (they live with the pointer interceptor, not with
 * copy): the synthetic-modifier mousedown clone, the trackpad ghost-click
 * guard, the 4px travel threshold, the mode-1003 motion swallow, and the
 * wheel-pixel accumulation that decides when a scroll counts as a dismissal.
 * This module only cares that a dismissal HAPPENED — see `reduceStash`.
 *
 * What the component still owes, because none of it survives as a pure
 * decision:
 *   - the clipboard write itself, and the toast each decision names. Every
 *     path here returns its own `toast`/`failureToast` wording, and a null
 *     `failureToast` means term.html stays silent on that path rather than
 *     meaning "pick something";
 *   - reading `term.hasSelection()` AND `term.getSelection()` and passing both
 *     (`SelectionState.hasSelection` is not `selection !== ""`; see the field);
 *   - the same reading at the moment of a dismissal, for `StashEvent`;
 *   - `term.paste()` for the browser paste event, the GET /capture fetch, the
 *     telemetry (`tel('copy-recovered', …)`) and the haptic on the soft key.
 */

/** A keyboard event, narrowed to the fields the chord rules read. */
export interface ChordEvent {
  /** "keydown" | "keyup". xterm consults the handler on both. */
  type?: string;
  key?: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/**
 * A copy of the selection text, kept after the highlight itself is gone.
 * `at` is a monotonic reading (performance.now()), not wall clock.
 */
export interface SelectionStash {
  text: string;
  at: number;
}

export interface SelectionState {
  /**
   * `term.hasSelection()` — whether a selection RANGE is on screen.
   *
   * This is NOT `selection !== ""`, and the difference is load-bearing. xterm
   * right-trims every row it hands back, so a drag that ends inside a row's
   * trailing blank space leaves a visible highlight with `hasSelection() ===
   * true` and `getSelection() === ""`. term.html gates both the Escape branch
   * (8565) and the copy chord (8569) on hasSelection() and copies whatever
   * getSelection() returns (8570): the chord is swallowed, "" goes to the
   * clipboard, 'Copied' toasts. Gating on the text instead would let ^C
   * through to the pty — SIGINT fired with a highlight on screen, the failure
   * ADR-0003's contract exists to prevent.
   */
  hasSelection: boolean;
  /** xterm's live selection text, i.e. `term.getSelection()`. */
  selection: string;
  /** The recovery stash, or null once dismissed. */
  stash: SelectionStash | null;
}

/**
 * How long a stashed selection still backs the copy chord.
 *
 * Field telemetry (ADR-0003 addendum 3) found the real cause of "the selection
 * vanished": panes in mouse mode 1003 report every pointer move, the TUI
 * repaints on hover, and the repaint clears xterm's highlight. The user's
 * intent to copy outlives the highlight, so the chord falls back to this for
 * 15 seconds. Longer would start copying text the user has forgotten about;
 * shorter loses the case the stash exists for.
 */
export const STASH_TTL_MS = 15_000;

/**
 * Layout-proof chord match, the ADR-0003 rule.
 *
 * `e.key` follows the keyboard layout: under Cyrillic, Ctrl+C reports
 * 'с'/'ъ'/'ц', an `e.key === 'c'` test fails, and the chord falls through as
 * ^C — SIGINT fired while a selection was visible. `e.code` is the physical
 * position, so it is the fallback. Match `e.key` FIRST while it is a Latin
 * letter, which keeps Dvorak-style remaps correct (the letter the user thinks
 * they pressed wins over the key position); fall back to `e.code` only when
 * the layout yields a non-Latin key. Lowercasing covers CapsLock and Shift.
 * `altKey` is excluded so AltGr (Ctrl+Alt) typing chords are never hijacked.
 *
 * Ctrl and Meta are interchangeable here: Cmd+C on Mac, Ctrl+C elsewhere.
 */
export function isTerminalChord(e: ChordEvent, latin: string, code: string): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
  const key = e.key ?? "";
  const k = key.length === 1 ? key.toLowerCase() : key;
  return k === latin || (!/^[a-zA-Z]$/.test(key) && e.code === code);
}

export const isCopyChord = (e: ChordEvent): boolean => isTerminalChord(e, "c", "KeyC");
export const isPasteChord = (e: ChordEvent): boolean => isTerminalChord(e, "v", "KeyV");

/** What happened to the selection, as far as the stash is concerned. */
export type StashEvent =
  /** xterm reported a selection; `text` is what it holds. */
  | { type: "selection"; text: string }
  /**
   * The user dismissed the selection on purpose — wheel scroll past the
   * threshold, Escape, or a replacing drag / double-click. Anything routed
   * through term.html's `clearSelectionBecause`.
   *
   * `hasSelection` is `term.hasSelection()` AT THE MOMENT OF THE DISMISSAL,
   * and it decides whether the stash dies; see `reduceStash`. It is required
   * rather than defaulted so a caller has to answer the question.
   */
  | { type: "dismissed"; hasSelection: boolean }
  /**
   * The highlight went away with no explained cause: pane output repainted
   * over it. This is the case the stash exists for.
   */
  | { type: "repaint-cleared" };

/**
 * The stash lifecycle, as one reducer.
 *
 * The asymmetry between the two clear paths is the whole point. A deliberate
 * dismissal restores interrupt semantics immediately — after it, Ctrl+C must
 * be SIGINT again, so the stash dies with the highlight. A repaint-clear is
 * not the user's doing and must leave the stash alone, or a streaming turn
 * silently turns the next Ctrl+C into an interrupt the user did not ask for.
 *
 * A dismissal only kills the stash while a highlight is actually on screen.
 * term.html:5893 `if (!term.hasSelection()) return;` runs BEFORE `selStash =
 * null` (5894), so a dismissal reason that fires with nothing selected leaves
 * the stash alive for the rest of its 15 s. That guard is reachable: the
 * double-click path (6010-6011) calls `clearSelectionBecause('double-click
 * replace')` from inside a branch entered when `!term.hasSelection()`. So a
 * second click landing after a repaint wiped the highlight must NOT turn the
 * user's pending copy back into SIGINT.
 */
export function reduceStash(
  prev: SelectionStash | null,
  ev: StashEvent,
  now: number,
): SelectionStash | null {
  switch (ev.type) {
    case "selection":
      // An empty selection is not worth stashing, and must not overwrite a
      // good stash: xterm fires onSelectionChange with "" in the middle of
      // gestures.
      return ev.text ? { text: ev.text, at: now } : prev;
    case "dismissed":
      // Mirrors clearSelectionBecause's early return: no live highlight, no
      // dismissal, so the stash is untouched.
      return ev.hasSelection ? null : prev;
    case "repaint-cleared":
      return prev;
  }
}

/** Is the stash still young enough to back a copy? */
export function stashIsFresh(stash: SelectionStash | null, now: number): boolean {
  return !!stash && now - stash.at < STASH_TTL_MS;
}

/** Text the copy chord would put on the clipboard, or null when it has none. */
export interface CopySource {
  text: string;
  /** True when the text came from the stash rather than a live highlight. */
  recovered: boolean;
}

/**
 * Which text a copy chord acts on: the live selection first, the fresh stash
 * second, nothing third.
 *
 * The text is passed through untouched — no trimming, no re-joining of wrapped
 * rows. A drag across a TUI's hard split yields indent, an injected newline
 * and padding spaces BY DESIGN; selection semantics are frozen (ADR-0003), and
 * "helpfully" trimming here would change what every existing user copies.
 *
 * A live RANGE wins even when its text is empty (term.html:8569-8570 gates on
 * hasSelection() and copies getSelection()): the chord is spent, "" is written
 * and 'Copied' toasts. The stash is not consulted there — term.html reaches
 * its stash branch (8575) only when hasSelection() is false — so a
 * trailing-blank drag over an older stash copies the empty string, not the
 * stash.
 */
export function copySource(state: SelectionState, now: number): CopySource | null {
  if (state.hasSelection) return { text: state.selection, recovered: false };
  if (stashIsFresh(state.stash, now)) {
    return { text: state.stash!.text, recovered: true };
  }
  return null;
}

export type KeyDecision =
  /** Clear the selection, and still let the app see the key. */
  | { action: "clear-selection"; reason: "Escape"; passToTerminal: true }
  | {
      action: "copy";
      text: string;
      recovered: boolean;
      toast: string;
      failureToast: string;
      passToTerminal: false;
    }
  /** Send nothing to the pty; let the browser's own paste event fire. */
  | { action: "browser-paste"; passToTerminal: false }
  /** Not ours: xterm handles the key as usual (Ctrl+C with nothing = SIGINT). */
  | { action: "pty"; passToTerminal: true };

/**
 * The copy/paste/Escape tail of xterm's `attachCustomKeyEventHandler`.
 *
 * `passToTerminal` is exactly what that handler must return. xterm stores ONE
 * handler, so the component's app-chord layer and its other special keys have
 * to run before this and share the same function.
 */
export function terminalKeydownDecision(
  e: ChordEvent,
  state: SelectionState,
  now: number,
): KeyDecision {
  // xterm consults the handler on keyup too; acting there would copy twice and
  // would let a keyup-only Ctrl+C copy after the user changed their mind.
  if (e.type !== undefined && e.type !== "keydown") {
    return { action: "pty", passToTerminal: true };
  }

  // Escape clears the selection AND still reaches the app. Swallowing it would
  // break vim, where Escape is the most-pressed key in the editor.
  // Gated on the RANGE, not the text (term.html:8565): a highlight made of
  // trailing blanks reads as "" and must still clear on Escape.
  if (e.key === "Escape" && state.hasSelection) {
    return { action: "clear-selection", reason: "Escape", passToTerminal: true };
  }

  if (isCopyChord(e)) {
    const src = copySource(state, now);
    if (src) {
      return {
        action: "copy",
        text: src.text,
        recovered: src.recovered,
        // The recovered wording is deliberate: the user sees no highlight, so
        // an unqualified "Copied" would look like a bug.
        toast: src.recovered ? "Copied (recovered)" : "Copied",
        failureToast: "Copy blocked by browser",
        passToTerminal: false,
      };
    }
    // No selection and no fresh stash: Ctrl+C stays SIGINT. This fall-through
    // is the contract, not an oversight.
    return { action: "pty", passToTerminal: true };
  }

  if (isPasteChord(e)) {
    // Nothing reaches the pty; the browser's paste event fires and the
    // component routes the text through `term.paste()`, never raw input. That
    // is what wraps it in bracketed paste when the app asked for it and
    // normalizes \r\n, so multiline text stops executing line by line in a
    // shell.
    return { action: "browser-paste", passToTerminal: false };
  }

  return { action: "pty", passToTerminal: true };
}

export type CommandCopyDecision =
  | { action: "copy"; text: string; toast: "Copied"; failureToast: "Copy failed" }
  /** No selection to copy: grab the visible screen from the capture endpoint. */
  | { action: "capture-screen"; toast: "Screen copied"; failureToast: "Copy failed" };

/**
 * The `terminal.copy` command — the mobile soft-key and the frontend-v2
 * bridge, one routine.
 *
 * Unlike the chord, a press of a Copy button is unambiguous intent, so an
 * empty selection falls back to the screen capture instead of falling through.
 * On touch there is never a selection (a drag scrolls, by design), which is
 * the case this fallback exists for.
 *
 * This one gates on the TEXT, not on `hasSelection` — term.html:9572-9573 is
 * `const sel = term.getSelection(); if (!sel) { …capture… }`. The asymmetry
 * with the chord is deliberate: a range that yields "" would put nothing on
 * the clipboard, and a Copy button that copies nothing is a dead button, so
 * the capture fallback takes it.
 */
export function copyCommandDecision(state: SelectionState): CommandCopyDecision {
  if (state.selection) {
    return {
      action: "copy",
      text: state.selection,
      toast: "Copied",
      failureToast: "Copy failed",
    };
  }
  return { action: "capture-screen", toast: "Screen copied", failureToast: "Copy failed" };
}

export interface ClipboardCapabilities {
  /** navigator.clipboard.write exists. */
  hasClipboardWrite: boolean;
  /** The ClipboardItem constructor exists. */
  hasClipboardItem: boolean;
}

/**
 * How to hand the capture to the clipboard.
 *
 * "promise-item" means calling `navigator.clipboard.write` SYNCHRONOUSLY
 * inside the tap, with the fetch handed over as a ClipboardItem promise. iOS
 * Safari only honours a write inside the gesture's transient activation, and
 * awaiting the fetch first voids it — the copy then fails on exactly the
 * platform the button exists for. "await-text" is the fallback for engines
 * without ClipboardItem, where awaiting is the only option.
 */
export function chooseCaptureWrite(caps: ClipboardCapabilities): "promise-item" | "await-text" {
  return caps.hasClipboardWrite && caps.hasClipboardItem ? "promise-item" : "await-text";
}

/**
 * Whether an inbound OSC 52 write should reach the clipboard.
 *
 * tmux 3.4 emits an EMPTY selection field (`\x1b]52;;<base64>`), and the
 * addon's stock provider accepts only exactly 'c' — which is why copy-mode
 * yanks never reached the browser clipboard. Accept '' and 'c', and nothing
 * else: 'p' (primary) and friends are not this clipboard.
 *
 * The predicate alone is not the whole provider — an accepted write also
 * toasts. `osc52WriteDecision` carries that half.
 */
export function osc52Accepts(selectionField: string): boolean {
  return selectionField === "" || selectionField === "c";
}

export type Osc52WriteDecision =
  /**
   * Write the payload, then toast. `failureToast` is null ON PURPOSE — see
   * below; it is not an omission to be filled in later.
   */
  | { action: "write"; toast: "Copied"; failureToast: null }
  /** Not this clipboard: drop the sequence, say nothing. */
  | { action: "ignore" };

/**
 * The whole OSC 52 write provider, toast included.
 *
 * ADR-0003 names the toast as contract: tmux copy-mode copies "land on the OS
 * clipboard via OSC 52, with the same 'Copied' toast as the chord". It has to
 * be, because a copy-mode yank leaves NO highlight in the browser — the toast
 * is the only evidence the yank crossed the pty boundary at all.
 *
 * Failure is silent (term.html:5491 `.catch(() => {})`), which is the one
 * place in this module where a copy path has no failure toast, and it is
 * deliberate: the pty emits OSC 52 unprompted — an app can yank on its own —
 * so an error toast would fire for something the user never asked for. A
 * rejected selection field is silent for the same reason (5492
 * `Promise.resolve()`).
 */
export function osc52WriteDecision(selectionField: string): Osc52WriteDecision {
  return osc52Accepts(selectionField)
    ? { action: "write", toast: "Copied", failureToast: null }
    : { action: "ignore" };
}

/**
 * The answer to an OSC 52 read query ('?'), which is always nothing.
 *
 * Answering truthfully would let any program running in the pty read the
 * user's clipboard. The refusal is a security boundary, not a stub.
 */
export function osc52ReadText(): string {
  return "";
}
