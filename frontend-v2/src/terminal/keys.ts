/**
 * The keyboard: which keys the terminal never sees, and what an armed soft
 * modifier does to the ones it does.
 *
 * Ported from `frontend/term.html`:
 *   - **:8516-8589**, the whole `attachCustomKeyEventHandler` contract. xterm
 *     stores exactly ONE handler (`CoreBrowserTerminal._customKeyEventHandler`
 *     is a single field, and a second `attachCustomKeyEventHandler` call
 *     replaces it), so every rule that wants a look at a keydown shares this
 *     one function, and the order the legs are tested in below is the order
 *     they are tested in there.
 *   - **:8337-8360**, the whole `term.onData` wrapper: the two unconditional
 *     calls at its head (:8341-8342) and the armed soft-modifier remap below
 *     them.
 *
 * Everything here is pure: the world as read at the moment of the event goes
 * in, and what to do comes out. No DOM, no clipboard, no socket, no clock.
 *
 * WHY THIS IS A MODULE RATHER THAN A FUNCTION IN THE COMPONENT. The handler is
 * nine branches deep and the interesting part of each one is what it does NOT
 * do: Escape clears a selection and still reaches vim; Ctrl+C is a copy while a
 * highlight is up and SIGINT the moment it is not; F12 goes to the browser
 * whole. None of that was reachable by a test inside term.html.
 *
 * WHAT THE COMPONENT STILL OWES, per action, because the module decides and
 * never acts:
 *   - `copy`: the `navigator.clipboard.writeText` call, then
 *     `showToast(toast, toastKind, timeoutMs)` on fulfilment and
 *     `showToast(failureToast, failureToastKind, failureTimeoutMs)` on
 *     rejection (selection.ts words both; the kind and the duration are this
 *     module's, see the action). Then `tel('copy-recovered', { len })` when
 *     `recovered` is true, OUTSIDE that promise chain: :8582 is a plain
 *     statement following the `.then`/`.catch` opened at :8579, so it runs
 *     whether the clipboard write resolves or is refused. Moved inside the
 *     chain it would lose the count exactly where the write is refused, which
 *     is the case the failure toast exists for.
 *   - `clear-selection`: term.html's `clearSelectionBecause` (:5892-5897), all
 *     five of its lines IN ITS ORDER. `term.hasSelection()` is read FIRST
 *     (:5893 returns early when nothing is highlighted) and handed to
 *     selection.ts's `reduceStash` as a `dismissed` event, which is :5894's
 *     `selStash = null`, so the stash dies exactly when a highlight was up.
 *     Clearing before that read reports `hasSelection: false`, the stash
 *     survives its own dismissal, and the next Ctrl+C copies recovered text
 *     instead of interrupting the process, which is the ADR-0003 failure class
 *     reached from the other side. Then the two telemetry lines, in this order:
 *     the stamp `lastExplainedClear = { why, t: performance.now() }` (:5895)
 *     and `tel('sel-cleared', { 'tl.reason': why })` (:5896). Only the second
 *     is modelled here, and the port has no equivalent of the first. It is the
 *     200 ms window term.html's `onSelectionChange` watcher reads before
 *     calling a clear UNEXPLAINED (:6316-6317, `!(lastExplainedClear.why && dt
 *     < 200)`), so once that watcher is ported a stamp-less Escape fires
 *     `sel-cleared` a SECOND time and files the deliberate dismissal under the
 *     bucket that exists for repaint-clears nobody asked for (:6299-6301, and
 *     the field recording in ADR-0003 that bucket found).
 *     `term.clearSelection()` (:5897) is last.
 *   - `discard-held`: clear the queue back to `EMPTY_HELD` and dispose the
 *     overlay (term.html's `discardHeldInput`, :8237-8242). It resets
 *     `heldDim` too, which is why nothing here has to.
 *   - `send`: route the bytes through the SAME choke point a keystroke takes
 *     (`attach.ts`'s `send`, which carries the watch-mode drop and the
 *     held-input offer), never `term.write` and never `term.paste`. term.html
 *     calls `sendInput` here (:8550) for exactly that reason.
 *   - `prevent-default`: `e.preventDefault()`. Only two legs ask for it, and
 *     the ones that do not are deliberate; see `KeyReduction.actions`.
 *   - `toast`: `showToast(message, toastKind, timeoutMs)`.
 *   - `cancel-momentum` and `mirror-out-of-band`: see `DataAction`. Only
 *     `reduceData` emits them, and only because term.html runs both at the head
 *     of the same hook (:8341-8342).
 *   - reading `term.hasSelection()` AND `term.getSelection()` apart, and the
 *     keybinding layer's `matchesAppChord(e)`, into `KeyWorld`.
 */

import type { ChordEventLike } from "../keybindings/chords.logic";
import {
  applyMods,
  consumeSoftMods,
  modActive,
  type SoftMods,
} from "../mobile/softmods";
import { isHolding, type HeldState } from "./held";
import { terminalKeydownDecision, type KeyDecision, type SelectionState } from "./selection";

/**
 * ESC b, `backward-word`. iTerm2 sends this for Option+Left, and zsh, bash,
 * readline and Claude Code's editor all bind it.
 *
 * xterm's own answer for Option+Left is the modifier-3 cursor form
 * `ESC [ 1;3D`, which zsh leaves as `undefined-key` (bash binds it, zsh does
 * not, verified with bindkey), so word navigation silently no-ops for Mac users
 * in zsh. That is the reported bug this leg exists for. term.html:8537-8547.
 */
export const WORD_LEFT = "\x1bb";

/** ESC f, `forward-word`. The Option+Right half of `WORD_LEFT`. */
export const WORD_RIGHT = "\x1bf";

/**
 * What Escape says when it throws a hold away (term.html:8561).
 *
 * Exported so it can be pinned byte for byte, and so the held-input refusal
 * line can promise it: the refusal at term.html:8221 says the line is held,
 * that Backspace edits it and Esc discards it, and until this leg existed the
 * native build had to cut that sentence in half because nothing bound Escape.
 */
export const DISCARD_HELD_TOAST = "Discarded what you typed while offline";

/** How long the discard toast stays up (term.html:8561). */
export const DISCARD_HELD_TOAST_MS = 2500;

/**
 * How long a copy toast stays up (term.html:8571, and :8580 for the recovered
 * wording, which passes the same pair).
 *
 * The kind and the duration live here rather than in selection.ts because that
 * module returns only wording, and `showToast` defaults its kind to "info"
 * (src/store/toast.ts:200-205): a wiring that passed the message alone would
 * ship an info toast of default length where the page shows a short success.
 */
export const COPY_TOAST_MS = 1500;

/** The refusal's, which term.html leaves up longer (:8572, :8581). */
export const COPY_FAILURE_TOAST_MS = 2500;

/**
 * Everything the handler reads, as read at the moment of the event.
 *
 * The name follows `DragSelectWorld` in this directory: none of it is state
 * this module carries, all of it is read fresh per event, and reading it is the
 * component's job precisely because each field comes from somewhere else
 * (xterm, held.ts, the keybinding engine, `navigator`).
 */
export interface KeyWorld {
  /** A monotonic reading (`performance.now()`), for the selection stash's TTL. */
  readonly now: number;
  /**
   * The platform is a Mac. term.html reads
   * `['Macintosh','MacIntel','MacPPC','Mac68K'].includes(navigator.platform)`
   * (:5817); the keybinding engine's `isMac` answers the same question from
   * `userAgentData.platform` first, and agrees with that list on every engine
   * that ships. Mac-only because off a Mac the word-motion modifier is Ctrl,
   * which zsh already binds (`ESC [ 1;5C/D`), and Alt is not it.
   */
  readonly macLike: boolean;
  /**
   * The keybinding layer matched this event exactly and in context
   * (term.html:8526, `tlKb.matchesAppChord(e)`; here the engine's own
   * `matchesAppChord`, engine.ts:112-119).
   *
   * A boolean rather than the binding, because the command has ALREADY RUN by
   * the time xterm consults this handler. The engine installs a capture-phase
   * `window` keydown listener (engine.ts:197); xterm's own is capture-phase too
   * but on the helper textarea (@xterm/xterm 6.0.0 registers `textarea`,
   * `"keydown"`, capture `true` in its core browser terminal), a descendant, and
   * capture descends. So the only thing left to decide is that the key must not
   * also be typed into the pty.
   *
   * READ IT ON EVERY KEYDOWN, unconditionally. Skipping the read while the
   * keybinding layer is off is the one shortcut this field invites, and it is
   * wrong twice over:
   *   - `matchesAppChord` walks the ALWAYS-ON table BEFORE the `enabled` gate
   *     (bindings.logic.ts:302-309, and term.html:3528-3533 in the same order),
   *     so an always-on chord matches with the layer off. Here that table is
   *     one row, `alt+shift+backspace` -> `session.kill.current`
   *     (bindings.logic.ts:129-131), whose `when` is "lobbyOpen &&
   *     !overlayOpen" (bindings.logic.ts:58) and whose `lobbyOpen` is
   *     hardcoded true by `keyContext` (bindings.logic.ts:250), so it holds
   *     whenever no overlay is up. term.html has a second row, `ctrl+j`
   *     (`meta+j` on a Mac) -> `session.new.shell` (term.html:3382-3391),
   *     which this build dropped along with the dock (bindings.logic.ts:15-19).
   *   - the gate defaults to ON anyway. `normalizeKeybindings` starts from
   *     `{ enabled: true }` and only a stored `enabled: false` turns it off
   *     (bindings.logic.ts:164-167, term.html:3427-3430).
   * term.html:8524-8525 says "layer disabled (the default) -> matchesAppChord
   * is null for every event and nothing changes"; both halves of that are
   * false, and it is the sentence this field's contract inherited. What it
   * costs to believe is a chord that fires AND types: by xterm 6.0.0's own
   * keymap Alt+Shift+Backspace would kill the session and put ESC DEL on the
   * pty (its Backspace arm reads `ctrlKey` and `altKey`, never `shiftKey`),
   * and in term.html Ctrl+J would open a shell and put 0x0A there. term.html
   * does neither, because :8526 reads the matcher on every keydown rather than
   * on a condition.
   *
   * Which also means the terminal being in the SAME document is what makes one
   * layer enough: while term.html was an iframe, a lobby keydown never reached
   * it, so the framed document ran a keybinding layer of its own
   * (term.html:3521).
   */
  readonly appChord: boolean;
  /** The selection, split into the RANGE and the text; see `SelectionState`. */
  readonly selection: SelectionState;
  /** The offline hold. term.html's `heldShadow`. */
  readonly held: HeldState;
  /**
   * The hold has been replayed and is waiting for the pty to answer.
   * term.html's `heldDim`.
   *
   * It is the second half of "is there anything of mine on screen to throw
   * away": held.ts assigns the component `isHolding(state) && !dim` for exactly
   * this leg. A dimmed run is already on the wire, so Escape has nothing left
   * to discard and must not pretend otherwise.
   */
  readonly heldDim: boolean;
}

/** The soft toolbar's modifiers, the only state either reducer carries. */
export interface KeyState {
  /**
   * term.html's `softMods`, or null where no toolbar is mounted.
   *
   * Null is the desktop case and it is a real one, not a default: term.html
   * declares `softMods = null` (:6355, "only populated on touch devices") and
   * builds it inside the coarse-pointer block (:6558), and the wrapper's whole
   * block is gated on it being there (:8343).
   */
  readonly mods: SoftMods | null;
}

/**
 * Bytes for the pty, through the ordinary input path.
 *
 * Named because both reducers here produce it and nothing else in either
 * union is shared: a keydown leg sends a word-jump sequence, the onData hook
 * sends the remapped chunk, and both go through the one choke point.
 */
export interface SendAction {
  readonly kind: "send";
  readonly data: string;
}

/** What the component must carry out. The module never does any of it. */
export type KeyAction =
  | SendAction
  /** `e.preventDefault()`. */
  | { readonly kind: "prevent-default" }
  /** Throw the offline hold away: the queue and the overlay both. */
  | { readonly kind: "discard-held" }
  /** Drop xterm's selection, for this reason. */
  | { readonly kind: "clear-selection"; readonly reason: "Escape" }
  /**
   * Put `text` on the clipboard, then say `toast`, or `failureToast` if the
   * write is refused. Both strings are selection.ts's, so the chord and the
   * Copy button cannot drift apart.
   *
   * The kind and the duration beside each one are the other two arguments
   * term.html passes: `showToast('Copied', 'success', 1500)` on the live path
   * (:8571), the same pair for `'Copied (recovered)'` (:8580), and
   * `showToast('Copy blocked by browser', 'error', 2500)` on both failures
   * (:8572, :8581). They are carried rather than left to the wiring because
   * `showToast`'s kind defaults to "info"; see `COPY_TOAST_MS`.
   */
  | {
      readonly kind: "copy";
      readonly text: string;
      /** The text came from the recovery stash, not from a live highlight. */
      readonly recovered: boolean;
      readonly toast: string;
      readonly toastKind: "success";
      readonly timeoutMs: number;
      readonly failureToast: string;
      readonly failureToastKind: "error";
      readonly failureTimeoutMs: number;
    }
  /** Say something. `toastKind` is `showToast`'s second argument. */
  | {
      readonly kind: "toast";
      readonly message: string;
      readonly toastKind: "info";
      readonly timeoutMs: number;
    };

/**
 * Which branch answered, named after term.html's own branches.
 *
 * It exists so a test can assert the REASON rather than only the answer: six of
 * the nine legs answer `passToTerminal: false`, for six unrelated reasons, so a
 * test that checks the boolean alone passes when the wrong branch fired.
 *
 * The last four names come from selection.ts's `KeyDecision`, by construction,
 * so the two cannot drift.
 */
export type KeyLeg =
  /** :8517. xterm consults the handler on keyup and keypress too. */
  | "not-keydown"
  /** :8526. The keybinding layer's command has already run. */
  | "app-chord"
  /** :8534. F12 belongs to the browser. */
  | "devtools"
  /** :8548. Option+Arrow moves by word. */
  | "word-jump"
  /** :8558. Escape throws the offline hold away. */
  | "discard-held"
  | KeyDecision["action"];

export interface KeyReduction {
  /**
   * Exactly what `attachCustomKeyEventHandler` must return. True hands the key
   * to xterm as usual; false stops xterm dead, which in `_keyDown` happens
   * BEFORE its own `cancel(ev)`, so false alone means no pty byte AND no
   * `preventDefault`. That is what makes the F12 leg work, and it is why the
   * two legs that DO want the browser default suppressed ask for
   * `prevent-default` explicitly.
   */
  readonly passToTerminal: boolean;
  /** The branch that answered; see `KeyLeg`. */
  readonly leg: KeyLeg;
  /** In the order term.html performs them. */
  readonly actions: readonly KeyAction[];
}

/**
 * Shared, because most keystrokes are ordinary and this runs on every one of
 * them. `readonly` is what makes sharing safe: no caller can push into it.
 */
const NOTHING: readonly KeyAction[] = [];

/**
 * The whole `attachCustomKeyEventHandler` contract (term.html:8516-8589).
 *
 * No next state comes back, and that is deliberate rather than an omission.
 * Every fact this reads is owned elsewhere (xterm holds the selection, held.ts
 * the hold, the keybinding engine its document) and everything it changes it
 * changes through an action, so a `state` field here would be a copy for a
 * caller to store and let go stale. The soft modifiers, which this module does
 * carry, are untouched by a keydown: term.html spends them in the onData
 * wrapper, and a key this handler swallows never reaches onData at all.
 *
 * `now` rides in `world` rather than as a third argument so that the whole
 * reading is taken at one instant; `terminalKeydownDecision` takes it apart
 * because it predates this module.
 */
export function reduce(world: KeyWorld, e: ChordEventLike): KeyReduction {
  // :8517. Acting on a keyup would copy twice and would let a keyup-only
  // Ctrl+C copy after the user changed their mind. xterm asks on `keypress`
  // too, from `_keyPress`, so this is not only about keyup.
  //
  // ONE DECLARED DIVERGENCE, and it is only reachable from a test. :8517 is
  // `if (e.type !== 'keydown') return true`, so an event with NO type returns
  // true there and acts here. `type` is always a string on a real
  // KeyboardEvent, so no browser path can tell the two apart; the leniency is
  // the form selection.ts's `terminalKeydownDecision` already uses, and
  // term.html's own `matchesAppChord` is lenient about it too, by truthiness
  // rather than by `undefined` (:3522).
  if (e.type !== undefined && e.type !== "keydown") {
    return { passToTerminal: true, leg: "not-keydown", actions: NOTHING };
  }

  // :8518-8526. The command ran in the capture phase; all that is left is to
  // keep the key out of the pty. No `prevent-default`: the engine's own
  // listener already called it on the match.
  if (world.appChord) {
    return { passToTerminal: false, leg: "app-chord", actions: NOTHING };
  }

  // :8527-8536. F12 opens devtools like on any normal web page. Without this,
  // xterm's function-key handling sends ESC [ 24~ to the pty AND cancels the
  // event, so devtools never opens over a focused terminal. Answering false
  // hands the key wholly to the browser, so NO `prevent-default` here: that is
  // the one leg where the browser default is the entire point. Modified F12
  // stays with xterm. (Viktor, 2026-07-17.)
  if (e.key === "F12" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
    return { passToTerminal: false, leg: "devtools", actions: NOTHING };
  }

  // :8537-8553. Option+Arrow moves by word; see `WORD_LEFT` for why xterm's own
  // sequence does not. Shift is excluded so Option+Shift+Arrow keeps xterm's
  // selection form, and Ctrl/Cmd are excluded so their own chords survive.
  // Option+Delete already sends ESC DEL through xterm and is left alone.
  if (
    world.macLike &&
    e.altKey &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.shiftKey &&
    (e.key === "ArrowLeft" || e.key === "ArrowRight")
  ) {
    return {
      passToTerminal: false,
      leg: "word-jump",
      actions: [
        { kind: "send", data: e.key === "ArrowLeft" ? WORD_LEFT : WORD_RIGHT },
        // term.html calls preventDefault here (:8551) and `passToTerminal:
        // false` is not a substitute: it short-circuits xterm before xterm's
        // own `cancel(ev)`, so nothing else suppresses the default. What is
        // left to suppress belongs to the focused element, and that element is
        // xterm's helper textarea: on a Mac, Option+Arrow is the system's
        // word-motion binding for a text field, so without this the caret moves
        // inside that hidden field. NOT history navigation, which is Cmd+[ /
        // Cmd+Left on a Mac; Alt+Left is Back on Windows and Linux, which the
        // `macLike` gate above excludes by construction.
        { kind: "prevent-default" },
      ],
    };
  }

  // :8554-8564. Escape throws a hold away. Precedence over the selection branch
  // below is term.html's and is deliberate: while held keys are on screen,
  // discarding them is the live intent, and an Escape that reached the pty
  // while offline would only earn a refusal toast anyway.
  //
  // Shift is NOT guarded, unlike the two legs above. That is the source's
  // condition, not an oversight here: Shift+Escape discards.
  //
  // `isHolding` rather than a text test, so a line backspaced empty still
  // discards: the person is mid-edit and the next thing they press is as likely
  // to be Escape as another letter.
  if (
    e.key === "Escape" &&
    !e.ctrlKey &&
    !e.altKey &&
    !e.metaKey &&
    isHolding(world.held) &&
    !world.heldDim
  ) {
    return {
      passToTerminal: false,
      leg: "discard-held",
      actions: [
        { kind: "discard-held" },
        {
          kind: "toast",
          message: DISCARD_HELD_TOAST,
          toastKind: "info",
          timeoutMs: DISCARD_HELD_TOAST_MS,
        },
        // Returning false already keeps the key off the pty; the
        // preventDefault is term.html's own (:8562) and covers what the
        // browser would otherwise do with the key, which on Firefox is
        // stopping a page load. NOT leaving fullscreen: that is a user-agent
        // action a page cannot cancel, deliberately, so nobody should read
        // this line as the thing that keeps a fullscreen terminal fullscreen.
        { kind: "prevent-default" },
      ],
    };
  }

  // :8565-8587. Escape-clears-a-selection, the copy chord and the paste chord,
  // all three already extracted with their layout-proof predicates and their
  // toast wording. Consumed rather than restated: writing an `e.key === "c"`
  // test here would miss a Cyrillic layout, which is the failure ADR-0003's
  // contract exists to prevent.
  return fromSelection(terminalKeydownDecision(e, world.selection, world.now));
}

/**
 * Translate selection.ts's decision into this module's answer.
 *
 * `passToTerminal` is taken straight off the decision, which documents itself
 * as "exactly what that handler must return", so the two cannot disagree. None
 * of these legs calls `preventDefault`: term.html's copy and paste branches
 * return false and leave it at that, and the Escape branch returns TRUE
 * precisely so the app still sees the key.
 */
function fromSelection(decision: KeyDecision): KeyReduction {
  const base = { passToTerminal: decision.passToTerminal, leg: decision.action };
  switch (decision.action) {
    case "clear-selection":
      return { ...base, actions: [{ kind: "clear-selection", reason: decision.reason }] };
    case "copy":
      return {
        ...base,
        actions: [
          {
            kind: "copy",
            text: decision.text,
            recovered: decision.recovered,
            toast: decision.toast,
            toastKind: "success",
            timeoutMs: COPY_TOAST_MS,
            failureToast: decision.failureToast,
            failureToastKind: "error",
            failureTimeoutMs: COPY_FAILURE_TOAST_MS,
          },
        ],
      };
    case "browser-paste":
      // Nothing to do: `passToTerminal: false` IS the whole action. xterm
      // otherwise turns Ctrl+V into 0x16 and cancels the keydown, which is what
      // stops the browser firing its paste event at all.
      return { ...base, actions: NOTHING };
    case "pty":
      return { ...base, actions: NOTHING };

    default: {
      // `KeyLeg` widens automatically with selection.ts's `KeyDecision`, so a
      // fifth decision added there has to be answered somewhere. This arm is
      // NOT what makes forgetting it a compile error, and an earlier version of
      // this comment claimed it was, on the reasoning that `noImplicitReturns`
      // is off here. That flag is off and irrelevant: `fromSelection` declares
      // an explicit `KeyReduction` return type and tsconfig sets `strict`, so
      // a reachable end point is already an error without this arm. Measured
      // with this repo's tsc on the same shape: delete the arm, add a fifth
      // member, and it reports "error TS2366: Function lacks ending return
      // statement and return type does not include 'undefined'" against the
      // signature.
      //
      // What the arm buys is a better error in the place the work belongs:
      // TS2322 on the assignment below, naming the member nobody handled
      // (Type '{ action: "fifth" }' is not assignable to type 'never')
      // rather than a complaint about the signature that says nothing about
      // which decision is new. battery.ts:179-183 is the same arm over its
      // events, and its `act` has an explicit return type too.
      const unhandled: never = decision;
      void unhandled;
      return { passToTerminal: true, leg: "pty", actions: NOTHING };
    }
  }
}

/**
 * What the onData hook can ask for, which is not what a keydown can.
 *
 * A keydown this handler swallows never reaches onData, and nothing on this
 * side has a toast or a `preventDefault` to give, so the two action sets are
 * kept apart rather than merged into one union with dead arms on both sides.
 */
export type DataAction =
  | SendAction
  /**
   * touchscroll.ts's `{ type: "interrupt" }`, which is term.html's
   * `cancelScrollMomentum` at the head of the hook (:8341).
   *
   * Deliberately redundant, and worth keeping anyway. attach.ts's `send` is
   * the one choke point every pty-bound byte passes, and that is where
   * touchscroll.ts puts the same obligation (term.html cancels there too, at
   * :8269, whose comment reads "The scattered per-path cancels remain as
   * belt-and-braces"). The port keeps the source's line so a build whose choke
   * point has not been wired to touchscroll yet still cancels a coast on a
   * keystroke, and so this hook does not silently owe a duty it never states.
   */
  | { readonly kind: "cancel-momentum" }
  /**
   * mirror.ts's `{ type: "out-of-band", value }`, which is term.html's
   * `mirrorLineReset` at :8342. The component supplies the field's current
   * value, which that reducer's early-out reads.
   *
   * Not redundant with anything: `sendInput` does NOT reset the mirror, so
   * every other path that reaches the pty calls it for itself (a soft key at
   * :6828, the upload and paste path-sends at :8922, :8963, :9004 and :9126,
   * the postMessage bridge at :9388, :9689, and a fresh attach at :10293), and
   * this hook is the one that covers ordinary typing. Bytes reaching the pty by
   * a route the mirror did not emit make its baseline a lie, and a stale
   * baseline re-sends part of a line on the next keystroke.
   *
   * With no mirror mounted there is nothing to route it to, and dropping it is
   * right rather than a gap: term.html makes the same call into an inert stub
   * on a fine pointer. `mirrorLineReset` is declared as a no-op at :6376 and
   * replaced only at :7267, which term.html's own note at :6367-6368 places
   * inside the coarse-pointer block.
   */
  | { readonly kind: "mirror-out-of-band" };

/** What the onData hook reads that is not the chunk itself. */
export interface DataWorld {
  /**
   * These bytes are the compose mirror's own, so they are not out of band.
   * term.html's `mirrorEmitting`, declared at :6367-6376 and set around the
   * mirror's `term.input` call at :7232-7236, read here at :8342.
   *
   * Required rather than defaulted, because the gate IS the hazard in both
   * directions: answering false mid-emit clears the field the person is typing
   * in, and answering true for a keystroke leaves the baseline stale. mirror.ts's
   * `send` action is what tells the component when the answer is true.
   */
  readonly mirrorEmitting: boolean;
}

export interface DataReduction {
  /** The modifiers after this chunk. Armed ones are spent; latched ones stay. */
  readonly state: KeyState;
  readonly actions: readonly DataAction[];
}

/**
 * The two unconditional calls at the head of the hook (:8341-8342), in
 * term.html's order and ahead of the chunk's own bytes.
 *
 * Unconditional means unconditional: they run for an empty chunk too, since
 * both sit ABOVE the `if (softMods && data)` gate, and they run whether or not
 * the remap fires.
 */
function headActions(world: DataWorld): DataAction[] {
  const head: DataAction[] = [{ kind: "cancel-momentum" }];
  if (!world.mirrorEmitting) head.push({ kind: "mirror-out-of-band" });
  return head;
}

/**
 * The whole `term.onData` wrapper (term.html:8340-8360): its two unconditional
 * head calls, then the armed soft-modifier remap.
 *
 * A phone's soft keyboard has no Ctrl and no Alt, so the toolbar fakes them:
 * tap arms one for a single key, double-tap latches it. The remap has to happen
 * HERE, on the way out of xterm, because the key it applies to is typed on the
 * SYSTEM keyboard and arrives as ordinary `onData` text. A remap that lived in
 * the toolbar would only ever reach the toolbar's own buttons.
 *
 * THE HOOK IS MORE THAN THE REMAP. Its first two lines (:8341-8342) cancel a
 * flick coast and invalidate the compose-mirror baseline on every chunk, and
 * both come back as actions rather than being left to a callback wrapped around
 * this reducer: touchscroll.ts and mirror.ts are both in this directory and
 * both name this hook as a caller that owes them an event, so a wiring that
 * forgets one should fail a test rather than quietly lose a coast cancel or
 * carry a stale baseline. `DataAction` documents each one, including which of
 * the two is redundant with the send choke point and which is not.
 *
 * `applyMods` and `consumeSoftMods` are softmods.ts's, already ported and
 * already tested; what this adds is term.html's gating, which is not the same
 * as calling them unconditionally:
 *
 * - An empty chunk spends nothing (`if (softMods && data)`, :8343). xterm emits
 *   one on some composition paths, and burning an arm on it would drop the
 *   modifier before the character it was armed for arrived. It still cancels a
 *   coast and still resets the mirror, because those two sit above the gate.
 * - A chunk with no modifier active returns the SAME `KeyState` object, so a
 *   component holding these in a signal is not woken on every keystroke.
 * - The consume happens only on the branch that remapped (:8355), which is
 *   where term.html puts it.
 *
 * Not modelled, on purpose: term.html's toolbar buttons send their pre-baked
 * bytes with NO remap and then consume (`sendKey`, :6822-6830) on the reasoning
 * that a Ctrl-byte transform "only makes sense for letters typed on the system
 * soft keyboard". Those bytes never pass `term.onData`, so they never reach
 * this reducer either.
 *
 * A PASTE DOES REACH IT, and that is the one thing wiring this up can get
 * wrong. `term.paste()` ends in `coreService.triggerDataEvent`
 * (`Clipboard.ts:51-56`), so pasted text arrives here like any keystroke, and
 * with bracketed paste on its first character is the ESC of `ESC [200~`. An
 * ARMED Ctrl would be spent on that ESC for no visible effect; an armed Alt
 * would prepend a second ESC and corrupt the bracket sequence itself. term.html
 * avoids both by calling `consumeSoftMods()` immediately BEFORE `term.paste`
 * (:8973, :8978), so the caller has to do the same. It consumes rather than
 * clears, so a LATCHED modifier still remaps the first pasted character there;
 * that asymmetry is term.html's and this reducer keeps it.
 */
export function reduceData(
  state: KeyState,
  data: string,
  world: DataWorld,
): DataReduction {
  const head = headActions(world);
  const asIs: DataReduction = { state, actions: [...head, { kind: "send", data }] };
  const mods = state.mods;
  if (!mods || !data) return asIs;
  if (!modActive(mods.ctrl) && !modActive(mods.alt)) return asIs;
  return {
    state: { mods: consumeSoftMods(mods) },
    actions: [...head, { kind: "send", data: applyMods(data, mods) }],
  };
}
