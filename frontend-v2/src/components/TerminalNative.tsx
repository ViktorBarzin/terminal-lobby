import { createEffect, onCleanup, onMount, type Component } from "solid-js";
import { ownWhile } from "../lib/ownwhile";
// xterm ships its own stylesheet and WILL NOT LAY OUT WITHOUT IT: the rows get
// no positioning, so the terminal renders as a narrow column of overlapping
// glyphs. It looks like a sizing bug and it is a missing import. Vite folds it
// into the bundle's CSS, so it costs no extra request.
import "@xterm/xterm/css/xterm.css";
import { attach, type Attachment } from "../terminal/attach";
import { toXtermTheme, THEME_LIVE_GLOBAL } from "../terminal/theme";
import type { LadderState } from "../terminal/reconnect";
import {
  initialAttention,
  reduce as reduceAttention,
  type AttentionEvent,
  type AttentionKind,
  type AttentionState,
} from "../terminal/attention";
import type { TerminalReport } from "../diagnostics/status";
import {
  NO_FIT_OWED,
  reduce as reduceFit,
  type FitEvent,
  type FitState,
  type HostBox,
} from "../terminal/fit";
import { EMPTY_HELD, isHolding, type HeldState, type HeldVerdict } from "../terminal/held";
import {
  NO_GESTURE,
  reduce as reduceGesture,
  type DragSelectReduction,
  type DragSelectState,
  type DragSelectWorld,
  type ScreenBox,
} from "../terminal/dragselect";
import { reduceStash, type SelectionStash } from "../terminal/selection";
import {
  NO_TOUCH_SCROLL,
  reduce as reduceTouchScroll,
  type LineWheel,
  type TouchScrollEvent,
  type TouchScrollState,
  type TouchScrollWorld,
} from "../terminal/touchscroll";
import {
  isSmoothOn,
  NO_WHEEL,
  reduce as reduceWheel,
  type SmoothWheelEvent,
  type WheelState,
  type WheelWorld,
} from "../terminal/wheel";
import {
  reduce as reduceKey,
  reduceData,
  type KeyReduction,
  type KeyState,
} from "../terminal/keys";
import {
  EMPTY_MIRROR,
  MIRROR_FIELD_ATTRIBUTES,
  reduce as reduceMirror,
  type MirrorEvent,
  type MirrorState,
} from "../terminal/mirror";
import {
  hostHeightStyle,
  NO_KEYBOARD_RESERVE,
  reduce as reduceViewport,
  type ViewportEvent,
  type ViewportFacts,
  type ViewportState,
} from "../terminal/viewport";
import {
  noteTouchEmit,
  NO_TOUCH_EMIT,
  screenGeometry,
  touchScrollWorld,
  wheelsFor,
  wheelWorld,
  type EmitPoint,
} from "../terminal/emit";
import { isCoarsePointer } from "../mobile/pointer";
import { consumeSoftMods } from "../mobile/softmods";
import { diag } from "../telemetry/diag";
import {
  coercePrefs,
  FONT_SIZE_KEY,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  PREFS_KEY,
  readPersistedPrefs,
  type Prefs,
} from "../store/prefs";
import { gesturesEnabled } from "../store/device-prefs";
import { showToast } from "../store/toast";

/** Every fit trigger waits this long first (term.html:8471-8481, `refit`). */
const REFIT_DEBOUNCE_MS = 120;

/** One watch-mode nudge per this long, however many keys (term.html:8303). */
const WATCH_NUDGE_MS = 4000;

/**
 * One held-input message per this long, across all of them. term.html keeps
 * this clock (`dropToastAt`, :8191-8195) separate from the watch nudge's and
 * LONGER, so the two throttles are two variables here as well.
 */
const HELD_SAY_MS = 5000;

/**
 * The device-local "I dismissed the input bar here" override
 * (term.html:3208-3211, `tl:input.barHidden:v1`, read by `inputBarHiddenHere`).
 *
 * Same origin as this app, so a person who hid the bar with the iframe's ⌨ soft
 * key already has this set, and a native mirror that ignored it would hand them
 * back the surface they dismissed with nothing on this side to dismiss it again:
 * the SPA's own ⌨ key is a keyboard-DISMISS (SoftKeys.tsx, "Dismiss the soft
 * keyboard"), not a bar toggle. Device-local on purpose in the page too: the
 * roamed `input.bar` is what the settings row writes, so an accidental tap on
 * one device does not hide the bar on all of them.
 */
const INPUT_BAR_HIDDEN_KEY = "tl:input.barHidden:v1";

/**
 * The mono stack, for when `--font-mono` cannot be read.
 *
 * The app declares one stack in theme/theme.css and calls it the single source
 * of truth, so the option is read from there rather than copied. The copy is
 * still needed: `getComputedStyle` answers "" for a custom property in a
 * document whose stylesheet has not applied, and xterm measures cell metrics
 * from whatever family it is constructed with. Identical to term.html's
 * TL_MONO_STACK (:4970-4971); its slow-tier stack, which swaps the webfont out
 * on a measured-bad link, is part of the webfont race and is not ported yet.
 */
const MONO_STACK_FALLBACK =
  '"JetBrains Mono", "TL Symbols", "Fira Code", "Cascadia Code", Menlo, Monaco, "Courier New", monospace';

/** One CSS custom property, read where the app declares them (theme.ts says why body). */
const cssVar = (name: string): string =>
  getComputedStyle(document.body).getPropertyValue(name).trim();

/** localStorage, which throws rather than answering in a locked-down browser. */
function stored(key: string): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

/**
 * A font size the roamed doc would accept.
 *
 * The same predicate as store/prefs.ts's `isValidFontSize`, which is private to
 * that module; the bounds themselves are imported, so there is one place to
 * change the range.
 */
function validFontSize(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isInteger(v) &&
    v >= FONT_SIZE_MIN &&
    v <= FONT_SIZE_MAX
  );
}

/**
 * The roamed terminal prefs as they stand right now, validated.
 *
 * Read from the persisted `tl:prefs:v1` document rather than from the prefs
 * STORE, because the store is created by App.tsx and passed down by prop, and
 * these values are only ever wanted once, at construction, which is the only
 * moment several of the options below can be set at all. `coercePrefs` is the
 * store's own validate-or-default, so a doc written by an older build or by
 * hand cannot put `cursorStyle: "wobble"` into xterm.
 *
 * The same two steps term.html takes at boot (`getPrefs`, :2952-2958):
 * normalize the doc, and where it carries no usable `fontSize`, fall back to
 * the device key the A-/A+ stepper has written since before the roamed doc
 * existed.
 *
 * THE FALLBACK IS NOT THE SAME READ, and the difference shows on a device whose
 * legacy key is out of range. term.html's `getFontSize` puts the key through
 * `clampFontSize` (:2671-2681), which rounds and clamps into 6..22, so a stored
 * 30 arrives as 22 and 9.6 as 10. Here anything `validFontSize` rejects is
 * discarded and the default stands. That is deliberate only in the sense that
 * it is what this app's own store already does: prefs.ts's private
 * `seedFontSize` (:413-418) is the same discard-or-default, and the roamed doc
 * this reads is the one that store writes. The BOUNDS are shared (prefs.ts
 * FONT_SIZE_MIN/MAX, term.html:2670).
 *
 * A LIVE pref change reaches term.html through the `__tlPrefsLive` bridge
 * (:9173-9188) and has no route in here yet, so a change made while this
 * terminal is mounted lands on its next mount.
 */
function bootPrefs(): Prefs {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(stored(PREFS_KEY) ?? "null");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  } catch {
    /* a corrupt doc reads as no doc, which is coercePrefs' all-defaults arm */
  }
  const prefs = coercePrefs(raw);
  if (validFontSize(raw.fontSize)) return prefs;
  const legacy = Number(stored(FONT_SIZE_KEY));
  return validFontSize(legacy) ? { ...prefs, fontSize: legacy } : prefs;
}

/**
 * The three postures of the compose mirror's field, `input.bar`
 * (term.html:2799-2807, validated at :2893).
 *
 *   off    no field at all, an explicit settings act.
 *   on     the painted bar, which costs the terminal its height.
 *   auto   the never-touched default. On a coarse pointer it resolves to the
 *          GHOST render (term.html:7377, :1887-1902): the field stays in the
 *          DOM, focusable and keyboard-summoning, but painted away and
 *          reserving no terminal space, so the terminal is the only visible
 *          input surface. That is Viktor's own call in the page (:7086, "we
 *          either mirror the terminal … or dont at all"). A second composer in
 *          front of Claude Code's own input box is the thing to avoid.
 */
type InputBarPosture = "auto" | "on" | "off";

/**
 * The posture as the roamed doc holds it, read straight out of `tl:prefs:v1`.
 *
 * NOT through `coercePrefs`, which drops `input.bar` deliberately: prefs.ts
 * types `tapFocus` alone and records that `input.bar` "stays an
 * untyped-but-preserved subkey until the mirror pass needs it", because a value
 * WRITTEN from this side would answer a per-device question the roamed doc is
 * meant to leave open. This is that pass, and reading is not writing, so the
 * subkey is read here with its own validator the way `bootPrefs` reads the
 * legacy font key. Nothing on this side writes it.
 *
 * Read ONCE per mount. term.html reconciles it live from `applyInputPrefs`
 * (:7483-7488) over the `tl-prefs` message, which is the un-ported
 * `__tlPrefsLive` bridge (:9173-9188), the same gap `bootPrefs` records for
 * the font size, so a posture change lands on this terminal's next mount.
 */
function bootInputBar(): InputBarPosture {
  let bar: unknown;
  try {
    const parsed: unknown = JSON.parse(stored(PREFS_KEY) ?? "null");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const input = (parsed as Record<string, unknown>).input;
      if (input && typeof input === "object" && !Array.isArray(input)) {
        bar = (input as Record<string, unknown>).bar;
      }
    }
  } catch {
    /* a corrupt doc reads as no doc, which is the 'auto' default */
  }
  return bar === "on" || bar === "off" ? bar : "auto";
}

/**
 * Is something else in the lobby holding the keyboard right now?
 *
 * The inline rename box, the composer, a palette input. `TerminalView` declines
 * its own auto-focus on this exact test (TerminalView.tsx:288-297) after the
 * steal tore the rename box down: that box ends the rename on blur, so a focus
 * arriving a frame later closed it the instant it appeared. A focused terminal
 * counts too, xterm's input proxy being a textarea, which is the answer wanted
 * when a second terminal mounts behind the one being typed into.
 */
function typingElsewhere(): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement as HTMLElement | null;
  if (!active) return false;
  return (
    active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable
  );
}

/** No cast: `FitEvent` is a discriminated union, so the two arms are built apart. */
const fitEvent = (type: FitEvent["type"], box: HostBox | null): FitEvent =>
  type === "shown" ? { type: "shown", box } : { type: "fit-wanted", box };

/**
 * What to say about a held or refused keystroke, or null to say nothing.
 *
 * The verdicts are held.ts's and the wording is term.html's (`offerHeldInput`,
 * :8204-8235), so the two builds explain the same event the same way. held.ts
 * assigns this job to the component precisely because "that key needs the
 * session" and "that is as much as this can hold" are different news.
 *
 * TWO DIVERGENCES, both stages rather than decisions.
 *
 * One: term.html toasts only on `closed`, because the held-key OVERLAY is
 * already drawing the keystrokes at the cursor (:8086-8203). That overlay is
 * pass 2, so until it exists an accepted keystroke would be silent, which is
 * the disappearing act held.ts exists to stop. Hence the same line for every
 * accepted verdict, and only while something is actually being held, because
 * attach.ts fires `onHeld(state, "held")` a second time when the hold is
 * REPLAYED (the first-output-frame arm of its `onmessage`, right after
 * `flushHeld`), where the state comes back empty and the input has just gone
 * out. Cited by symbol rather than by line, because that file is being worked
 * on alongside this one.
 *
 * Two: `refused:closed` deliberately says LESS than term.html's line. The
 * reason is at the case itself.
 */
function heldWord(
  held: HeldState,
  verdict: HeldVerdict,
): { message: string; kind: "info" | "error" } | null {
  switch (verdict) {
    case "held":
    case "popped":
    case "closed":
    case "reopened":
      return isHolding(held)
        ? { message: "Held — it goes in when the session is back", kind: "info" }
        : null;
    case "refused:key":
      return {
        message: "Not connected — Tab, arrows and control keys need the session",
        kind: "info",
      };
    case "refused:closed":
      // term.html:8221 promises "Backspace to edit it, Esc to discard". The
      // Backspace half is real here (held.ts answers `\x7f` on a committed
      // line with `reopened`); the Esc half still is not, and the missing piece
      // has moved. term.html binds Escape inside its
      // `attachCustomKeyEventHandler` (:8554-8564), which keys.ts now ports and
      // this component now performs. But that leg reads the HOLD, and no hold
      // reaches this component: attach.ts keeps the queue, offers it back only
      // through the `onHeld` callback above, and exposes no discard. So the
      // sentence stays cut back to what pressing a key here achieves. The
      // `discard-held` arm at the handler says what would make it whole.
      return {
        message: "Your line is held — Backspace to edit it",
        kind: "info",
      };
    case "refused:nothing-held":
      return { message: "Not connected — reconnect to edit this line", kind: "info" };
    case "refused:full":
      return {
        message: "Not connected — that is as much as this can hold",
        kind: "error",
      };
    case "refused:watching":
      // The nudge says this one, on its own shorter clock.
      return null;
    case "refused:no-session":
    case "refused:suspended":
      return {
        message: "Not connected — your input did not reach the session",
        kind: "error",
      };
  }
}

/**
 * The terminal, rendered by this app rather than by an iframe.
 *
 * WHY THIS EXISTS. `TerminalView` mounts `frontend/term.html` in a cross-document
 * iframe, so everything the shell wants to know about the terminal — is it
 * connected, what is it retrying, what did the user select — has to cross a
 * postMessage boundary one message type at a time, and everything term.html
 * wants from the shell (theme, prefs, keyboard) has to cross back. This mounts
 * xterm directly, so those become ordinary function calls.
 *
 * WHAT IT DOES. Attaches, reconnects, types, takes the focus at boot, pastes
 * through `term.paste` from the bridge and from the paste chord, reports the
 * mouse and buys plain-drag selection back from that reporting, scrolls from a
 * finger and paces a trackpad's pixels into discrete line wheels, decides the
 * whole of xterm's key-handler contract, fits only into a host that has a box,
 * reserves what a soft keyboard covers of that box and what its own compose bar
 * takes off it, mirrors the pty's input line into a field a phone keyboard can
 * autocorrect into, hardens xterm's helper textarea against predictive text,
 * tells the lobby when the pty rings or answers unwatched, and says why a
 * keystroke was refused or held.
 *
 * WHAT IT IS NOT YET. Pinch-to-zoom, web links, sixel and the held-key overlay
 * still belong to term.html, and two legs of what IS here are waiting on one of
 * those rather than on themselves: Escape cannot discard an offline hold while
 * nothing exposes one to discard, and the copy chord's recovery arm is dead
 * until something stashes a selection. Each says so at its own site. It is
 * behind a flag while that list stands, and because nobody has opened it on the
 * iPad.
 *
 * xterm arrives through a dynamic import so it lands in its own content-hashed
 * chunk that a deploy leaves alone unless xterm itself changed (330 KB, 83 KB
 * gzipped; see the note in vite.config.ts).
 */
export const TerminalNative: Component<{
  /** The positional `arg=` query, from lib/terminal-url.ts buildTerminalArgs. */
  args: string;
  /** Phase changes, for the shell's connection badge (ADR-0016). */
  onConn?: (report: TerminalReport) => void;
  /**
   * This client attached read-only and the SERVER agreed. Passed down so the
   * one input choke point in attach.ts can drop a watcher's keystrokes — the
   * page cannot grant itself write access, but it can stop pretending the keys
   * went somewhere.
   */
  watch?: () => boolean;
  /**
   * Hands the caller the two levers the ADR-0016 status model needs: `reconnect`
   * for the panel's Reconnect button, and `ask` for "what are you doing right
   * now", which is Run check and a session view coming back on screen above a
   * terminal that has been quietly open the whole time. The iframe branch
   * publishes the same pair as `retryConn` and `askConn`
   * (TerminalView.tsx:454-457).
   */
  onReady?: (control: { reconnect: () => void; ask: () => void }) => void;
  /**
   * FALSE for a secondary terminal. The window-level bridges below are named
   * globals, so two mounted terminals would fight over them and the soft keys,
   * paste and focus handback would start driving the wrong pty — the same
   * reason TerminalView takes this flag.
   *
   * It doubles as the ON SCREEN signal the fit guard needs, because at the one
   * call site it IS `onScreen()` (SessionView.tsx) and the lobby keeps every
   * visited session mounted and CSS-hidden. See the effect below.
   */
  ownsBridges?: boolean;
  /**
   * TRUE while this terminal is the thing ON SCREEN: the terminal view showing,
   * in a session slot that is not itself CSS-hidden behind another session.
   *
   * A DIFFERENT question from `ownsBridges`, which is `onScreen()` alone and
   * stays true while the text view shows over a terminal that is still mounted
   * and still attached. `terminal/attention.ts`'s `view` event is exactly the
   * negation of this flag, and the iframe branch passes the same expression as
   * TerminalView's `active` prop (SessionView.tsx).
   *
   * Read by the attention effect below, which fires on mount, so a session
   * that mounts off screen is told nobody is looking straight away.
   */
  active?: boolean;
  /**
   * This session wants the lobby's notice: the pty rang the bell, or output
   * arrived while nobody could see the terminal. Which of those is which, and
   * the one-shot that keeps ten frames behind a hidden view down to one piece
   * of news, is `terminal/attention.ts`.
   *
   * The lobby owns the tab title, the favicon and the [Terminal] segment's dot
   * (`notify/title.ts`, `notify/favicon.ts`, SessionView's `onAttention`), so a
   * terminal that painted any of them would fight them. It reports, and that is
   * all. WHICH session rang is the caller's to add: this component is handed
   * `args`, not a session name.
   *
   * Fed by `feedAttention` below from three events: xterm's `onBell`, every
   * output frame, and the tab's own visibility.
   */
  onAttention?: (kind: AttentionKind) => void;
}> = (props) => {
  let host: HTMLDivElement | undefined;
  let attachment: Attachment | null = null;
  let disposed = false;
  /** The fit guard's whole state: one flag, owed or not (fit.ts). */
  let fitState: FitState = NO_FIT_OWED;
  /** Installed once xterm is up; before that a view switch has nothing to fit. */
  let viewShown: (() => void) | null = null;
  /**
   * Everything the async mount body below has to hand back, run by the OUTER
   * `onCleanup` at the end of this component.
   *
   * NOT an `onCleanup` inside that body, which is where these calls sat until
   * the drag listeners arrived. By the time the two dynamic imports resolve
   * Solid's owner for this component is gone, so a cleanup registered there is
   * never run: that is the "cleanups created outside a createRoot" warning the
   * suite prints, and the measurement is that a `term.dispose()` registered
   * there is called zero times on unmount. Left there, an unmounted terminal
   * would keep its ResizeObserver, keep the theme global pointing at a dead
   * closure, and keep three document listeners swallowing every press in the
   * page on behalf of a terminal nobody can see.
   */
  let teardown: (() => void) | null = null;
  // term.html's two toast clocks, kept apart for the reason HELD_SAY_MS gives.
  let nudgedAt = 0;
  let saidAt = 0;

  /**
   * Is the primary pointer a finger? Read ONCE, where term.html reads it once
   * (`const isCoarsePointer`, :6350). Reading it live would let a 2-in-1
   * switching to its trackpad leave a keyboard reservation on screen with
   * nothing to clear it. mobile/pointer.ts is the app's own mirror of that
   * query.
   *
   * At construction rather than inside the async mount body, where it sat until
   * the compose mirror arrived: the mirror's field is created by the JSX below,
   * which runs before the two dynamic imports resolve, and the same answer
   * gates it (term.html builds the whole bar inside `if (isCoarsePointer)`).
   * One read, two readers.
   */
  const coarsePointer = isCoarsePointer();

  /**
   * THE COMPOSE MIRROR'S FIELD, and whether there is one.
   *
   * term.html's `want` (:7484): a posture other than 'off', and no device-local
   * dismissal. Inside the coarse-pointer block in that page, which is the gate
   * added here. A fine pointer keeps the inert `applyInputPrefs` stub, so
   * 'auto' never ghosts there (:7363-7364) and xterm's own hardened helper
   * textarea stays the only input surface.
   *
   * WHERE THE FIELD LIVES, which mirror.ts's `paste-intent` event says is the
   * thing that breaks if it lives in the wrong place: OUTSIDE the terminal
   * host. The host carries a CAPTURE-phase paste listener that preventDefaults
   * and stopPropagations every paste carrying text, so a field mounted inside
   * it would have its paste swallowed before `beforeinput` fired: no native
   * insertion for a single-line paste and no interception for a multiline one.
   * term.html appends its bar to `document.body` (:7130) and needs the same
   * escape at document level, spelled as an id check (:8892-8903).
   *
   * A JSX SIBLING and not a `document.body.appendChild`. The lobby keeps every
   * visited session mounted, so an imperative body append leaks one bar per
   * session that Solid does not own and cannot take down; a sibling is unmounted
   * with the component. It is `position: fixed` rather than a flex child of the
   * `.tl-view` it sits in, for two reasons that are both this app's layout
   * rather than a preference: `.tl-view` is `display: flex` in ROW direction
   * (app.css `.tl-view`), so an in-flow sibling would sit BESIDE the terminal;
   * and `.tl-views.tl-kb-inline` deliberately leaves the keyboard OUT of its
   * box (app.css, `body.has-soft-keys .tl-views.tl-kb-inline`), so a child
   * anchored to that box would sit behind the keyboard. Fixed puts the bar on
   * the same `--kb-offset + --safe-b + --sk-h` stack the soft-key row rides,
   * which is where term.html parks it too (:1826-1828).
   *
   * ONE BAR ON SCREEN, without a flag deciding it. `position: fixed` escapes
   * its ancestors' layout but not their `display: none`, and that is what the
   * lobby hides a mounted session with (`.tl-hidden`, and the same class on
   * this terminal's own `.tl-view` while the text view shows), so every other
   * mounted session's bar is not rendered at all and reads `offsetHeight` 0,
   * which is how term.html's own formulas read a hidden bar (:8450-8452). The
   * dock's second terminal is `TerminalView`, an iframe with its own bar
   * inside it, so it cannot stack with this one either.
   */
  const barPosture: InputBarPosture = coarsePointer ? bootInputBar() : "off";
  const barEngaged = barPosture !== "off" && stored(INPUT_BAR_HIDDEN_KEY) !== "1";
  /** The 'auto' render: engaged, focusable, painted away, reserving no rows. */
  const barGhost = barPosture === "auto";
  let composeBar: HTMLDivElement | undefined;
  let mirrorField: HTMLTextAreaElement | undefined;

  /**
   * Words, but only occasionally: a burst of typing is one event to the person,
   * not one per key. term.html's `heldSay` (:8191-8195), one message every
   * `HELD_SAY_MS` across every caller, which is why the mirror's `say` action
   * and the held-input lines share this clock rather than each keeping one. A
   * drop must not say two things at once.
   */
  const heldSay = (message: string, kind: "info" | "error"): void => {
    if (Date.now() - saidAt < HELD_SAY_MS) return;
    saidAt = Date.now();
    showToast(message, kind);
  };

  /* ------------------------------------------------------------------ *
   * ATTENTION: the two things this terminal knows that could be news.
   * ------------------------------------------------------------------ */

  /**
   * attention.ts's whole state, held here because the module is pure.
   *
   * At component scope rather than in the mount body, because the `view` effect
   * below fires on mount and that first event is the native counterpart of the
   * lobby re-posting `tl-view` on every attach: it is what tells a session
   * mounted OFF screen that nobody is looking, and it must not wait on two
   * dynamic imports. `initialAttention()` takes no seed and wants none.
   */
  let attention: AttentionState = initialAttention();

  /**
   * One attention event, decided and then handed up.
   *
   * The component writes no title, no favicon and no dot: those belong to
   * `notify/title.ts`, `notify/favicon.ts` and SessionView's `onAttention`, and
   * a terminal that painted its own would fight them. WHICH session rang is the
   * caller's to add, since this component is handed `args`, not a session name.
   */
  const feedAttention = (event: AttentionEvent): void => {
    const r = reduceAttention(attention, event);
    attention = r.state;
    for (const action of r.actions) props.onAttention?.(action.kind);
  };

  /**
   * THE TERMINAL CAME ON OR OFF SCREEN (attention.ts's `view`).
   *
   * `!active`, which is `!(mode() === "terminal" && onScreen())` at the call
   * site: the text view showing over the terminal, and this session's whole
   * slot being CSS-hidden behind another session. Both halves carry weight, and
   * `document.hidden` rides along because the re-arm this runs reads it LIVE in
   * the page (term.html:5744, :5754). A stored flag would be a task behind,
   * since the browser flips the flag and QUEUES the event.
   *
   * A missing prop reads as hidden, which errs toward reporting rather than
   * toward silence. Every call site passes it.
   */
  createEffect(() => {
    const viewHidden = props.active !== true;
    feedAttention({ type: "view", viewHidden, tabHidden: document.hidden });
  });

  /** The ladder's phase in the vocabulary the status model speaks. */
  const report = (phase: LadderState["phase"], attempt: number): TerminalReport => {
    switch (phase) {
      case "open":
        return { state: "open", attempt: 0 };
      case "suspended":
        return { state: "suspended", attempt: 0 };
      case "ended":
        return { state: "closed", attempt: 0 };
      default:
        // The ladder has no `offline` phase — it carries `online` as a flag and
        // keeps waiting — but term.html reports offline as its own state, and
        // the badge says "Offline" rather than "Reconnecting" for it. Reading
        // the browser here keeps that distinction without adding a phase.
        return typeof navigator !== "undefined" && navigator.onLine === false
          ? { state: "offline", attempt }
          : { state: "connecting", attempt };
    }
  };

  /**
   * A keystroke that was held or refused, made visible.
   *
   * Without this the two cheapest failures are silent: a read-only watcher's
   * keys are dropped at the choke point (wire.ts `decideInput`) into a terminal
   * that looks alive, and a keystroke into a dead socket is held for replay
   * with nothing on screen to say so.
   */
  const onHeld = (held: HeldState, verdict: HeldVerdict): void => {
    if (verdict === "refused:watching") {
      // Explain the silence without nagging: at most one per WATCH_NUDGE_MS,
      // however many keys they hit (term.html:8302-8313).
      if (Date.now() - nudgedAt < WATCH_NUDGE_MS) return;
      nudgedAt = Date.now();
      // The curly apostrophe is term.html's (:8310). Byte-for-byte, so the two
      // builds put the same sentence on screen rather than nearly the same one.
      showToast("Watching — this device can’t type into the session", "info", 2500);
      return;
    }
    const word = heldWord(held, verdict);
    if (!word) return;
    heldSay(word.message, word.kind);
  };

  /**
   * ON SCREEN, which is the earlier of the fit guard's two chances to settle an
   * owed fit (fit.ts, the `shown` event).
   *
   * `ownsBridges` is the signal because at the one call site it is `onScreen()`,
   * the session's own visibility rather than the terminal view's, and it is
   * passed already. Coarser than the real question, and safe by construction: a
   * `shown` whose measurement is still 0x0 KEEPS the debt rather than fitting,
   * which is the race fit.ts describes between the visibility signal and the
   * class flip. The narrower transition, text view to terminal view inside a
   * visible session, arrives on the ResizeObserver instead, because the host
   * regains a box there.
   */
  createEffect(() => {
    const onScreen = props.ownsBridges !== false;
    if (!onScreen) return;
    viewShown?.();
  });

  onMount(() => {
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !host) return;

      const prefs = bootPrefs();
      const term = new Terminal({
        // EVERY option here is one term.html passes (:5006-5074), and each is
        // either a user pref or a value that page argues for at the site.
        // Passed at construction because that is where the list is complete,
        // not because it has to be: xterm's only init-only options are `cols`
        // and `rows` (`ITerminalInitOnlyOptions`, xterm.d.ts:328-342), and
        // every option below is in `ITerminalOptions`, so `term.options` can
        // reassign it later.
        allowProposedApi: true,
        cursorBlink: prefs.cursorBlink,
        cursorStyle: prefs.cursorStyle,
        // An unfocused terminal draws a hollow cursor: the standard
        // "keystrokes are going somewhere else" cue.
        cursorInactiveStyle: "outline",
        fontFamily: cssVar("--font-mono") || MONO_STACK_FALLBACK,
        fontSize: prefs.fontSize,
        lineHeight: prefs.lineHeight,
        letterSpacing: prefs.letterSpacing,
        // Pinned so no browser synthesizes a faux bold now that real webfonts
        // are in play. With only the 400/700 faces vendored, CSS resolves 600
        // upward to the Bold face, so the choice only shows on a fallback
        // stack. It roams like every other pref regardless (term.html:5019-5026).
        fontWeightBold: prefs.fontWeightBold,
        theme: toXtermTheme(cssVar),
        // Nudge foreground colors toward WCAG AA against each cell's
        // background, as VS Code does. xterm leaves box and block glyphs alone,
        // so TUI borders keep exact theme colors, and holds dim text to half
        // ratio so it stays visibly dim.
        minimumContrastRatio: 4.5,
        // The Mac leg of plain-drag selection, and the reason the interceptor
        // below can work at all: xterm force-selects on
        // `isMac ? e.altKey && macOptionClickForcesSelection : e.shiftKey`
        // (`SelectionService.shouldForceSelection`), and this option defaults
        // to false, so without it every Mac clone is just another reported
        // click. term.html:5041 calls it constructor-only; it is not, being an
        // `ITerminalOptions` field xterm reads off `rawOptions` at click time.
        macOptionClickForcesSelection: true,
        // Off, against xterm's default: a real Option-drag's release otherwise
        // moves the cursor by spamming arrow keys into the app and clears the
        // selection just made. Click-to-move-cursor is never wanted in a tmux
        // or Claude pane.
        altClickMovesCursor: false,
        // Ten times xterm's default of 1000. tmux attaches on the ALTERNATE
        // screen, so this buffer is inert while attached and deep history is
        // tmux copy-mode's job; it matters only if the alt screen is ever
        // disabled (term.html:5054, argued at :5048-5053).
        scrollback: 10000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);

      /**
       * Re-rasterize once the webfonts have actually arrived.
       *
       * xterm caches every glyph it has drawn, so the atlas it builds at open()
       * is built from whatever font was resolved at that instant. The mono
       * stack's faces are declared `font-display: block` in theme/theme.css and
       * fetched over the network, so a first paint can measure and cache the
       * fallback and then keep it, which is how a symbol that DOES have a glyph
       * in "TL Symbols" still shows as a box. term.html clears the atlas on
       * `fonts.loadingdone` for the same reason (:5658-5665, and again at
       * :5797 after adding the symbol face).
       *
       * One shot, on the promise rather than the event: `document.fonts.ready`
       * has already settled by the time a later mount runs, where a
       * `loadingdone` listener added then would wait for a load that is not
       * coming. The full webfont race, which measures the link and drops to a
       * system stack on a bad one, is not ported yet.
       */
      void document.fonts?.ready?.then(() => {
        if (disposed) return;
        term.clearTextureAtlas?.();
      });

      /**
       * xterm mounts an offscreen <textarea> as its input proxy, and on a touch
       * device the soft keyboard types into THAT. Predictive text otherwise
       * commits suggestions straight into terminal input (xterm #2403, #3600),
       * so the field is hardened exactly as term.html hardens it (:6339-6347):
       * `type=password` is what suppresses Gboard's predictions, the four
       * off-switches turn off the same machinery by other names, and 16px keeps
       * iOS Safari from zooming the page when the field takes focus.
       *
       * Scoped to THIS terminal's host, where term.html could use a document
       * query: the lobby mounts a second terminal in the dock, and a document
       * query would harden the first one twice and the other never. xterm 6
       * sets four of these itself; they are set here anyway, because that is an
       * upstream implementation detail and this is the behaviour we need.
       */
      const hardenInput = (): boolean => {
        const ta = host?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
        if (!ta) return false;
        ta.setAttribute("autocorrect", "off");
        ta.setAttribute("autocapitalize", "off");
        ta.setAttribute("autocomplete", "off");
        ta.setAttribute("spellcheck", "false");
        ta.setAttribute("type", "password");
        ta.setAttribute("aria-label", "terminal input");
        ta.style.fontSize = "16px";
        return true;
      };
      // xterm 6 creates the textarea inside open(), so this normally lands at
      // once. The retry is for the case where it does not: an unhardened field
      // is a keyboard that edits the pty behind the user's back, and one frame
      // later is still before anyone can type into it.
      if (!hardenInput() && typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => {
          if (!disposed) hardenInput();
        });
      }

      /**
       * Is this a Mac, by the ONLY test that matters here: the one xterm makes.
       *
       * `SelectionService.shouldForceSelection` is
       * `isMac ? e.altKey && macOptionClickForcesSelection : e.shiftKey`, and
       * xterm's own `isMac` is
       * `["Macintosh","MacIntel","MacPPC","Mac68K"].includes(navigator.platform)`
       * (@xterm/xterm/lib/xterm.js). So the clone the interceptor dispatches
       * has to carry the modifier THAT list picks, and a detector that
       * disagreed with it would swallow presses and force nothing. term.html
       * uses the identical include list (:5817). Deliberately not
       * `keybindings/engine.ts`'s private `detectMac()`, which tries
       * `userAgentData.platform` first and matches /mac/i: a fine answer for a
       * keyboard label, and a different question from this one.
       */
      const macPlatform =
        typeof navigator !== "undefined" &&
        ["Macintosh", "MacIntel", "MacPPC", "Mac68K"].includes(navigator.platform);

      /** The host's box, measured NOW, which is what fit.ts asks for. */
      const measure = (): HostBox | null =>
        host ? { width: host.clientWidth, height: host.clientHeight } : null;

      /**
       * Ask the guard, then carry out its verdict. The two side effects a
       * `fit` owes are fit.ts's list: the addon, then the pty.
       *
       * Answers whether the guard let a fit through, which the boot focus below
       * reads as "this host has a real box".
       */
      const safeFit = (type: FitEvent["type"]): boolean => {
        const verdict = reduceFit(fitState, fitEvent(type, measure()));
        fitState = verdict.state;
        if (verdict.action !== "fit") return false;
        try {
          fit.fit();
        } catch (e) {
          // The debt is already cleared, so a throw is not handed back. The
          // next resize or view switch settles it. term.html has five
          // `safeFit()` call sites and treats a throw three different ways:
          // :8479 and :9188 log and move on, :8491 swallows it with an empty
          // catch, and the two boot-time ones (:5614, :5664) do not catch at
          // all. One `catch` here, at the one funnel, matches the majority and
          // is the only arm that keeps the boot fit from taking the mount with
          // it.
          console.warn("fit failed:", e);
        }
        // xterm's own onResize tells the pty in term.html (:8372-8377), which
        // fires only when the grid actually moved; pairing it with the fit is a
        // spare frame rather than a wrong one. Nothing goes out before the
        // socket exists: the boot size rides the handshake instead.
        attachment?.resize();
        return true;
      };

      /**
       * Every fit trigger funnels through here, and the debounce is why.
       *
       * A fit emits a tmux resize, and the soft keyboard animating over ~250ms
       * or a rotate fires a burst of notifications; coalescing them into one
       * fit is what stops the "glitchy resize" on mobile (term.html:8390-8393).
       * The box is measured INSIDE the callback, never when the trigger fired,
       * because a box cached at trigger time can be stale by the time the fit
       * runs and a stale non-zero box is exactly the zero-size fit the guard
       * exists to refuse.
       */
      let pending: FitEvent["type"] | null = null;
      let fitTimer: ReturnType<typeof setTimeout> | undefined;
      const refit = (type: FitEvent["type"]): void => {
        // A `fit-wanted` outranks a `shown` while both are waiting: it is the
        // one that records a debt when the box is zero, and dropping that is
        // how a skipped fit stops being replayed at all.
        if (pending !== "fit-wanted") pending = type;
        if (fitTimer !== undefined) clearTimeout(fitTimer);
        fitTimer = setTimeout(() => {
          fitTimer = undefined;
          const type = pending ?? "fit-wanted";
          pending = null;
          // The debounce outlives an unmount by up to REFIT_DEBOUNCE_MS, and
          // there is nothing left to fit or to tell by then.
          if (disposed) return;
          safeFit(type);
        }, REFIT_DEBOUNCE_MS);
      };
      viewShown = () => refit("shown");

      /* ---------------------------------------------------------------- *
       * THE SOFT KEYBOARD'S RESERVE, decided by viewport.ts.
       *
       * Pass 1 wired the RECEIVING half inline: the `__tlKeyboardOffset` bridge
       * took the height the shell measured, checked term.html's two gates and
       * wrote `calc(100% - Npx)`. What the module adds is the two things that
       * arithmetic could not express, both from its header: a terminal that
       * READS the viewport for itself, because the shell forwards on CHANGE
       * only (mobile/viewport.ts) and a terminal mounting into an already-open
       * keyboard is therefore never told; and `max(own, forwarded)` rather than
       * the forwarded height alone, because natively both readings describe the
       * SAME keyboard and subtracting both leaves a 60px terminal.
       * ---------------------------------------------------------------- */

      let viewportState: ViewportState = NO_KEYBOARD_RESERVE;

      /**
       * The world as of THIS trigger, read fresh. Never cached when the trigger
       * fired: a geometry read then can be stale by the time the decision runs,
       * which is the same rule fit.ts states for its box.
       *
       * The `?? 0` on `offsetTop` is load-bearing rather than tidy: without it
       * the expression is `number | undefined` under `strict: true` and, if it
       * compiled, `Number.isFinite(undefined)` would make every reading
       * unmeasurable and reserve nothing.
       */
      const viewportFacts = (): ViewportFacts => ({
        layoutHeight: window.innerHeight,
        visualHeight: window.visualViewport?.height ?? null,
        offsetTop: window.visualViewport?.offsetTop ?? 0,
        coarsePointer,
      });

      /**
       * The compose bar's live height, which is term.html's `cbH` (:8461) and
       * the term viewport.ts does not carry.
       *
       * THE CONFLICT THIS SETTLES. viewport.ts's header said "nothing sits over
       * the terminal's box, so there is nothing to subtract", which was true of
       * this tree until the bar above it mounted (that line now points here).
       * term.html measures the
       * bar's own `offsetHeight` at :8461, takes it off the terminal at :8467
       * and re-runs the whole calculation when the bar's height changes
       * (`growAndRefit`, :7156-7165). So the bar's height reaches the decision
       * here, as a second term on the same style write, and `growBar` below is
       * the trigger for a change in it.
       *
       * A GHOST BAR IS HEIGHT 0, which is term.html's own exception at :8461
       * (`!cb.classList.contains('ghost')`) and the whole point of that render:
       * the terminal RECLAIMS the bar's space. Its field keeps a real
       * offsetHeight, because a zero-size field can fail to summon the iOS
       * keyboard, so the read has to be about the posture, not the pixels.
       */
      const barReservePx = (): number =>
        barGhost || !composeBar ? 0 : composeBar.offsetHeight;

      /** The cbH term currently ON the host, so a bar-height change is visible. */
      let appliedBarPx = 0;

      /**
       * One viewport trigger, decided and then performed. The answer is whether
       * a caller took the message, which is what the `tl-kb` bridge returns.
       *
       * `host-height` writes and fits, `nothing` writes nothing and fits
       * anyway, `ignored` does neither: viewport.ts's owes list, and the third
       * answer exists because term.html keeps the `tl-kb` arm's `refit()`
       * INSIDE the same finite gate as everything else it does (:9418, :9421)
       * while its four viewport listeners refit outside both of
       * `syncViewport`'s gates (:8482-8486).
       *
       * THE BAR'S TERM RIDES THE SAME TWO GATES, because term.html's height
       * write is one expression and cbH is inside it: `if (isCoarsePointer)` at
       * :8441, and the `if (!window.visualViewport) return` at :8428 above it.
       * So the component reads the same two facts the module reads. Not a
       * second decision, the same one: a bar-height change on a machine behind
       * either gate writes nothing, exactly as the page writes nothing there.
       *
       * `fit: false` is for the ONE trigger term.html follows with an immediate
       * `safeFit()` instead of a debounced `refit()`: the boot seed, where
       * :8490 and :8491 are consecutive lines. Asking for the debounce there as
       * well would put a second fit, and so a second tmux resize, 120ms into
       * every mount.
       */
      const feedViewport = (
        event: ViewportEvent,
        opts: { fit?: boolean } = {},
      ): boolean => {
        const r = reduceViewport(viewportState, event);
        viewportState = r.state;
        if (r.action.kind === "ignored") return false;
        const gatesOpen = event.facts.visualHeight !== null && event.facts.coarsePointer;
        const barPx = gatesOpen ? barReservePx() : 0;
        if (r.action.kind === "host-height" || barPx !== appliedBarPx) {
          appliedBarPx = barPx;
          // `hostHeightStyle` is the one place that knows the height is
          // RELATIVE: the container has the toolbar and the safe area out of it
          // already and the keyboard still in, so the reserve is a shrink off
          // it, and 0 hands the box back to the stylesheet's `height: 100%`.
          if (host) host.style.height = hostHeightStyle(viewportState.appliedShrink + barPx);
        }
        // Debounced, because the keyboard animates over ~250ms and fires a
        // burst, and each fit emits a tmux resize (term.html:8390-8393).
        if (opts.fit !== false) refit("fit-wanted");
        return true;
      };

      // THE SEED, which is the hole item 1 of viewport.ts's header describes and
      // the shipped page has as well: `onKeyboard` fires only when the height
      // the shell measured DIFFERS from the last one it sent
      // (mobile/viewport.ts), so a session opened while the keyboard is already
      // up is never told and its bottom rows, the prompt among them, sit behind
      // the keyboard until the keyboard next moves. Before the boot fit, where
      // term.html seeds it (`syncViewport()` at :8490, then `safeFit()`), so
      // the fit measures the box the reserve leaves and is the one below.
      feedViewport({ type: "observed", facts: viewportFacts() }, { fit: false });

      // The boot fit runs straight away, as it does in the page (:5613-5614).
      // A host with no box yet owes one, and the ResizeObserver below or the
      // view coming back on screen settles it.
      const bootFitted = safeFit("fit-wanted");

      // THE BOOT FOCUS. term.html takes it here, immediately after the same
      // fit, and says why at :5615-5616: nothing else focuses the terminal on
      // load, and without it keystrokes on desktop are dead until the user
      // clicks. It matters more now than it did there, because
      // `cursorInactiveStyle: 'outline'` above draws an unfocused terminal with
      // a hollow cursor.
      //
      // GATED, where term.html focuses unconditionally at :5617, and the gate
      // is the divergence rather than an implementation detail. term.html was
      // one page per terminal, always the thing in front of the user. This app
      // keeps every visited session mounted and CSS-hides the rest
      // (store/keepalive.ts, App.tsx:835-842), and inside a visible session it
      // keeps this terminal mounted behind the TEXT view as well
      // (SessionView.tsx:937). Either way the host is `display: none`
      // (app.css:1121-1123), so it measures 0x0 and the fit above refuses it.
      // That makes "the boot fit found a box" the same question as "is this
      // terminal on screen", answered by measuring rather than by guessing.
      //
      // `ownsBridges` is NOT that question: SessionView deliberately keeps it
      // true while the text view shows, because that is the pty the composer's
      // send-to-terminal means (SessionView.tsx:949-952), and text is the
      // default view on a coarse pointer. Focusing on it would take the soft
      // keyboard off the composer.
      //
      // The second gate is the shipped terminal's own: TerminalView declines
      // its auto-focus while a lobby text field holds the keyboard
      // (TerminalView.tsx:280-305), for a reason it records at the site. This
      // is the same check, so the two branches steal focus in the same cases.
      //
      // Nothing re-focuses from here afterwards. A terminal that booted hidden
      // is focused by a click, or by `__tlFocusTerminal`
      // (keybindings/refocus.ts) when an overlay hands the keyboard back.
      // TerminalView also focuses when the TERMINAL VIEW becomes the active
      // one (an effect on `props.active`, TerminalView.tsx:307-311), and this
      // branch does not, so a mode switch from text to terminal still leaves
      // this unfocused. NOT for want of the prop: SessionView passes the same
      // `active={mode() === "terminal" && onScreen()}` to both branches
      // (SessionView.tsx:919 and :966), and this component's only reader of it
      // is the attention module's `view` gate (`viewHidden`). Closing the gap
      // is an effect here, not a prop upstream.
      if (bootFitted && !typingElsewhere()) term.focus();

      /**
       * THIS terminal's screen node. Never a document query: see `worldAt` and
       * `screenHeight` below, which both read it.
       */
      const screenOf = (): HTMLElement | null =>
        host?.querySelector<HTMLElement>(".xterm-screen") ?? null;

      /**
       * WHERE A TAP ON THE TERMINAL PUTS THE CARET. term.html's `tapFocus`
       * (:7459-7462), which is the whole of that assignment:
       * `if (composeVisible && getPrefs().input.tapFocus === 'field')
       * composeInput.focus(); else term.focus();`
       *
       * TWO CALLERS, and both were `term.focus()` until this pass: touchscroll's
       * `focus` action (the lift of a tap) and dragselect's (the synthesized
       * mousedown a tap also produces). The page names that double-fire and
       * calls it harmless, because it is two `.focus()` calls on one element.
       *
       * `mirrorField` being mounted IS the page's `composeVisible`: that flag
       * means the field is ENGAGED, true for the ghost render as much as the
       * painted bar (:7356-7359), and this component only mounts the field on
       * the postures that engage it. Without this, a tap with the mirror mounted
       * would focus xterm's HARDENED helper textarea (`type=password`,
       * autocorrect off) and leave the mirror unfocusable, which removes the
       * entire feature: that field is the only route a phone has to autocorrect,
       * dictation or swipe typing.
       *
       * The pref is read per tap, where the page reads `getPrefs()` per tap.
       * `readPersistedPrefs` measured 6.2 us, and a tap is not a hot path.
       *
       * A THIRD FOCUS SITE IS LEFT AS IT WAS: `__tlFocusTerminal`, which is the
       * handback after a lobby overlay closes (keybindings/refocus.ts), still
       * calls `term.focus()`. term.html's second focus router,
       * `focusActiveInput` (:7437-7443), re-arms the compose field only when it
       * was ALREADY the focused input, and its caller is that page's own
       * soft-key row rather than anything like the command palette, which the
       * page does not have. So there is no line to port; what a person sees is
       * that dismissing the palette puts the keyboard back in the terminal
       * rather than in the field they were typing in.
       */
      const tapFocus = (): void => {
        if (mirrorField && readPersistedPrefs().input.tapFocus === "field") {
          mirrorField.focus();
          return;
        }
        term.focus();
      };

      /* ---------------------------------------------------------------- *
       * SCROLLING: a finger's drag, and a trackpad's pixel stream.
       *
       * Two ports of two term.html ranges (:6056-6171 and :6172-6274) that
       * share one emission primitive, one per-frame cap and one reading of the
       * screen box. `emit.ts` is that shared middle, and the halves of it that
       * touch the DOM are here: the `WheelEvent` constructor and the
       * `getBoundingClientRect`.
       *
       * WHY SYNTHETIC WHEELS AT ALL, because the whole mechanism reads as a
       * workaround until you know: xterm damps a sub-50px pixel wheel to 0.3x
       * and, in mouse-tracking mode, forwards at most ONE report per DOM wheel
       * event with the magnitude discarded. So a finger's px and a trackpad's px
       * both have to come out as k separate `deltaMode: 1` wheels of deltaY +-1,
       * which are undamped and one row exact. That is what puts tmux into
       * copy-mode and lets Claude Code scroll its own view.
       * ---------------------------------------------------------------- */

      /**
       * The `clientY` the next synthetic wheels carry, per terminal
       * (term.html's `scrollLastEmitY`, :6087).
       *
       * ONE variable for BOTH scrollers, which is the coupling emit.ts exists
       * to keep: the page has one `emitLineWheel` reading one `scrollLastEmitY`
       * (:6111), the touch path is its only writer (:6522), and the trackpad
       * pacer only reads it. So a trackpad wheel carries the last y a finger
       * reached, and on a machine where no finger ever did it carries 100 for
       * the life of the terminal. xterm derives the mouse report's ROW from
       * this coordinate against the screen box, so giving the trackpad path the
       * wheel's own clientY instead would move a report from one tmux pane to
       * another on a split window.
       */
      let point: EmitPoint = NO_TOUCH_EMIT;

      /**
       * TRUE only for the length of our own synthetic wheel dispatch, and read
       * by `cancelCoast` below. `mirrorEmitting` is the same shape for the same
       * kind of reason.
       *
       * WHY IT EXISTS. With mouse reporting on, a dispatched wheel comes back
       * as pty-bound input INSIDE the dispatch, and a pty-bound byte cancels a
       * coast. xterm's `bindMouse` consults the custom wheel handler, gets true
       * for the untrusted synthetic, and `coreMouseService.triggerMouseEvent`
       * sends the report through `_coreService.triggerDataEvent` rather than
       * `triggerBinaryEvent`, because only DEFAULT encoding is binary and
       * DECSET 1006 selects SGR. So `term.onData` fires SYNCHRONOUSLY inside
       * `dispatchEvent`, and both of the interrupt sites downstream of it (the
       * `cancel-momentum` action, then `send`) would end the coast that emitted
       * the wheel. Measured against the installed @xterm/xterm 6.0.0: one
       * untrusted `deltaMode: 1` wheel after `\x1b[?1000h\x1b[?1006h` yields
       * `onData ["\x1b[<64;…M"]` and no `onBinary`.
       *
       * WHY term.html DOES NOT NEED IT, which is the whole argument for putting
       * the exclusion here rather than in touchscroll.ts. The page's
       * `cancelScrollMomentum` clears `momentumRAF` alone (:6129-6130); the
       * coast's velocity, distance and anchor are `let`s inside
       * `startScrollMomentum`, which it never touches, and `step` re-arms
       * `momentumRAF` on the line after `feedScroll` (:6167). Re-entered from
       * inside `step`, the cancel is therefore a NO-OP. The port moved that
       * motion state into `TouchScrollState.coast`, so the module's `interrupt`
       * destroys what the page leaves alone, and a pure reducer cannot see the
       * re-entrancy that makes the difference. The component can, exactly as it
       * already can for `onHostWheel`'s `isTrusted` test, which is the same
       * exclusion arriving by the other route.
       */
      let emittingWheel = false;

      /**
       * The ONE emit primitive both scrollers share (term.html's
       * `emitLineWheel`, :6105-6113).
       *
       * On the xterm ROOT (:6107), and one `dispatchEvent` per wheel: in
       * mouse-tracking mode xterm forwards one report per DOM event whatever
       * the magnitude, so collapsing k wheels into one `deltaY: k` would be one
       * report where k separate events are k. The `term.element` test is the
       * page's own guard at :6106.
       */
      const dispatchWheels = (wheels: readonly LineWheel[]): void => {
        // Saved and restored rather than set and cleared, so a nested dispatch
        // could not hand the outer one back an unguarded scope. Nothing nests
        // today: an untrusted wheel leaves `wheel.ts`'s `onWheel` on its first
        // line with no actions, so the pacer cannot re-emit for one of ours.
        const outer = emittingWheel;
        emittingWheel = true;
        try {
          for (const w of wheels) {
            term.element?.dispatchEvent(new WheelEvent("wheel", w));
          }
        } finally {
          emittingWheel = outer;
        }
      };

      /**
       * The screen box height, measured NOW, or null when there is no screen
       * element (term.html:6095, :6099).
       *
       * Behind a callback rather than a measurement so `screenGeometry` can
       * decline to call it: `getBoundingClientRect` flushes layout against a
       * grid xterm is writing into, and the touch path's owes list forbids
       * paying for that on a touchmove for a number only the lift reads.
       */
      const screenHeight = (): number | null => {
        const scr = screenOf();
        return scr ? scr.getBoundingClientRect().height : null;
      };

      /**
       * WHY THE PREF READ IS EAGER WHERE THE BOX READ IS LAZY, since both
       * modules say "every field FRESH at the moment of the event" and one of
       * the two is measured on demand.
       *
       * `touchScrollWorld` and `wheelWorld` spread `rest` FIRST, which is what
       * keeps the two box getters unshadowed, and a spread evaluates any getter
       * it copies. So the pref fields are read once per event whether or not a
       * reducer asks for them. That is a cost and not a behaviour change, and
       * the two costs are not comparable: the parse and the coerce inside
       * `readPersistedPrefs` measured 6.2 us per call (prefs.ts, which also says
       * why the `getItem` half is left unmeasured), while a box read forces a
       * layout on the hot path. Where the page reads the doc only inside
       * `feedScroll` (:6119) and `wheelSmoothOn` (:6238), this reads it on a
       * pre-threshold touchmove and on a modified wheel too.
       *
       * ONE TOUCHMOVE IS 1 + k READS, not one, where k is the rows it emits.
       * The extra one per row is `wheelWorldNow` below: xterm consults the
       * custom wheel handler for every wheel on `term.element`, our own
       * synthetic ones included, and `performWheel` evaluates that world as an
       * ARGUMENT, so the read happens before `reduce` can look at `isTrusted`
       * and pass the event straight back (wheel.ts, `onWheel`'s first line).
       * The box stays lazy on that path, since that early return reads no
       * geometry. At 120 Hz and two rows per touchmove, 1 + k is 3 reads an
       * event and 2.2 ms per second of dragging; the earlier figure of 0.7 ms
       * counted one read per touchmove and no dispatch. It was 1 + 3k until the
       * coast self-cancel was fixed, because the report each wheel produced ran
       * two more worlds through the interrupt path, and dropping `cancelCoast`
       * would put those back.
       *
       * A PULL and not the prefs STORE, deliberately: the store is created by
       * App.tsx and never reaches this component, and its signal would miss a
       * change made in the vanilla settings panel, which writes the same
       * localStorage document on the same origin. `readPersistedPrefs`' own
       * header carries the rest of that reasoning.
       */
      const touchWorld = (): TouchScrollWorld => {
        const prefs = readPersistedPrefs();
        return touchScrollWorld(screenGeometry(screenHeight, term.rows), {
          scrollSpeed: prefs.gestures.scrollSpeedV2,
          momentum: prefs.gestures.scrollMomentum,
          mounted: !!term.element,
        });
      };

      /** The whole recognizer's state, held here because the module is pure. */
      let touchState: TouchScrollState = NO_TOUCH_SCROLL;
      /** The coast's outstanding `requestAnimationFrame`, or null. */
      let coastFrame: number | null = null;

      /**
       * One touch event or coast frame, decided and then performed.
       *
       * The `point` write is unconditional and comes from the STATE rather than
       * from a dispatched wheel, because :6522 assigns on every qualifying
       * touchmove including one that banks its pixels and emits nothing.
       * Reading it off an action would leave a trackpad wheel carrying a y the
       * finger has already left.
       */
      const feedTouch = (event: TouchScrollEvent): void => {
        const r = reduceTouchScroll(touchState, event, touchWorld());
        touchState = r.state;
        point = noteTouchEmit(point, r.state.emitY);
        for (const action of r.actions) {
          switch (action.kind) {
            case "wheel":
              dispatchWheels(wheelsFor(action, point));
              break;
            case "focus":
              // term.html's `tapFocus` (:5815, reassigned at :7459-7462), which
              // is where the mirror field takes a tap over xterm's hardened
              // helper textarea. dragselect.ts's `focus` action is the same
              // call, and the two moved together.
              tapFocus();
              break;
            default: {
              const unhandled: never = action;
              void unhandled;
            }
          }
        }
        // The coast, which is the one thing the module cannot do for itself:
        // exactly one frame outstanding for as long as `coasting`, cancelled
        // the moment it goes false (term.html:6167-6169, and the cancel at
        // :6130).
        if (r.coasting) {
          if (coastFrame === null) coastFrame = requestAnimationFrame(onCoastFrame);
        } else if (coastFrame !== null) {
          cancelAnimationFrame(coastFrame);
          coastFrame = null;
        }
      };

      /**
       * One coast tick, carrying rAF's OWN timestamp.
       *
       * That timestamp has to be on the same clock as the `th` the lift froze
       * into `Coast.at`, because the coast measures one against the other:
       * `performance.now()` is that clock and a rAF timestamp shares its time
       * origin, where `Date.now()` shares neither. A function declaration
       * rather than a const, so `feedTouch` above can name it.
       */
      function onCoastFrame(now: number): void {
        coastFrame = null;
        if (disposed) return;
        feedTouch({ type: "frame", now });
      }

      /**
       * THE ONE DOOR every `cancelScrollMomentum` goes through, so the
       * self-cancel exclusion cannot be missed by a new interrupt path.
       * touchscroll.ts's owes list names the page's four: a real wheel
       * (:6281), every pty-bound byte at the shared `sendInput` choke point
       * (:8269) and again at `term.onData` (:8341), a soft key (:6823, which
       * natively arrives through the choke point), and a reattach (:10294).
       *
       * The guard decides nothing on two of the routes that reach here:
       * `onHostWheel` cannot see a TRUSTED wheel inside our own dispatch, and a
       * socket callback cannot arrive inside one either. It decides everything
       * on `send` and the onData hook, which are the two a mouse report reaches
       * synchronously.
       *
       * NOT the teardown's interrupt, which stays a direct feed: that one gives
       * up an outstanding frame at unmount and must run whatever else is in
       * flight.
       */
      const cancelCoast = (): void => {
        if (emittingWheel) return;
        feedTouch({ type: "interrupt" });
      };

      /**
       * TWO CLOCKS PER TOUCH EVENT, and they are not interchangeable.
       *
       * `t` is `e.timeStamp`, the event's CREATION stamp: true finger timing,
       * which survives coalesced or late delivery on real iOS, where WKWebView
       * routinely puts more than 80ms between the last touchmove and the lift.
       * `th` is `performance.now()` read while HANDLING it, which stays sane for
       * synthetic events whose creation stamps batch unreliably. The velocity
       * ring uses `t`; the lift compares the gap on BOTH and takes the smaller
       * (:6545-6547), which is the flick-favourable reading in either world
       * while a genuine hold is long on both. term.html says all of this at
       * :6509-6519. Passing one clock for both compiles and no test notices,
       * and it costs the flick whichever way the delivery went wrong.
       *
       * `y` is read off `touches[0]` for both events the module gives it to, and
       * both ignore it unless there is exactly one touch: a touchstart with two
       * fingers disarms the drag (:6498) and a touchmove with two returns
       * (:6503). So the fallback is only ever fed to a branch that drops it.
       */
      const onTouchStart = (e: TouchEvent): void =>
        feedTouch({
          type: "touchstart",
          touches: e.touches.length,
          y: e.touches[0]?.clientY ?? 0,
        });
      const onTouchMove = (e: TouchEvent): void =>
        feedTouch({
          type: "touchmove",
          touches: e.touches.length,
          y: e.touches[0]?.clientY ?? 0,
          t: e.timeStamp,
          th: performance.now(),
        });
      const onTouchEnd = (e: TouchEvent): void =>
        feedTouch({ type: "touchend", t: e.timeStamp, th: performance.now() });
      const onTouchCancel = (): void => feedTouch({ type: "touchcancel" });

      /**
       * THE GATE, which decides whether any of the touch half exists.
       *
       * term.html's whole recognizer, all three listeners included, sits inside
       * `if (isCoarsePointer)` (:6478), read ONCE at :6350, which is
       * `coarsePointer` above, read once for the reason the page reads it once.
       * The hardware this protects is a touchscreen laptop or a 2-in-1: there
       * the page attaches nothing and a finger gets the browser's native
       * scroll, while a wiring that skipped the gate would ALSO feed one LINE
       * wheel per row to the pty and put tmux into copy-mode under the person's
       * finger. These listeners cannot replace the native scroll either, only
       * add to it, because they are passive and have no `preventDefault` to
       * offer.
       *
       * PASSIVE is not a detail. A standing non-passive touch listener taxes
       * the latency of every scroll on the page (term.html measured it at
       * :6382-6388), and nothing here ever wants to cancel a touch. The pinch
       * recognizer does need one, which is why the page's multi-touch registry
       * attaches its non-passive touchmove (:6415-6416) only from
       * `if (e.touches.length >= 2)` (:6426); that is font.ts and not this.
       *
       * `touchcancel` is ours and the page has none. What term.html does on a
       * cancelled touch is nothing: the drag stays armed with a stale `startY`
       * until the next touchstart resets it, which is invisible because no
       * further move can arrive for a cancelled touch. Folding it in means the
       * module never sits holding half a gesture, and a cancel cannot be
       * followed by a coast.
       */
      if (coarsePointer) {
        host.addEventListener("touchstart", onTouchStart, { passive: true });
        host.addEventListener("touchmove", onTouchMove, { passive: true });
        host.addEventListener("touchend", onTouchEnd, { passive: true });
        host.addEventListener("touchcancel", onTouchCancel, { passive: true });
      }

      /**
       * A REAL wheel hard-cancels a coast (term.html:6278-6281).
       *
       * On the HOST element and at capture, where the page puts it, so it sees
       * only wheels over this terminal. `isTrusted` is the whole test: our own
       * synthetic coast ticks are untrusted and would otherwise cancel the
       * coast they are part of, and they DO reach this listener, since they are
       * dispatched on `term.element` with `bubbles: true` and capture on an
       * ancestor runs first. Registered whatever the pointer type, as the page
       * registers it (:6278 sits outside the coarse-pointer block), and on a
       * machine with no touch listeners there is never a coast for it to end.
       *
       * The page's listener does a second job in the same callback, the wheel
       * pixels that dismiss a highlight (`WHEEL_CLEAR_PX`, :6292). That is
       * selection.ts's and is not ported, so this half stands alone.
       */
      const onHostWheel = (e: WheelEvent): void => {
        if (e.isTrusted) cancelCoast();
      };
      host.addEventListener("wheel", onHostWheel, { passive: true, capture: true });

      /** The trackpad pacer's state: px owed, and whether a frame is out. */
      let wheelState: WheelState = NO_WHEEL;
      /** The pacer's outstanding `requestAnimationFrame`, or null. */
      let wheelFrame: number | null = null;

      /**
       * `isSmoothOn` is both halves of term.html's `wheelSmoothOn()`
       * (:6203-6205), read fresh on every wheel because the page reads it fresh
       * on every wheel (:6238): the `tl-gestures` master kill, which a person
       * sets by hand to rescue a device, and the roamed `gestures.wheelSmooth`.
       */
      const wheelWorldNow = (): WheelWorld => {
        const prefs = readPersistedPrefs();
        return wheelWorld(screenGeometry(screenHeight, term.rows), {
          speed: prefs.gestures.wheelSpeed,
          smoothOn: isSmoothOn({
            gesturesEnabled: gesturesEnabled(),
            wheelSmooth: prefs.gestures.wheelSmooth,
          }),
          mounted: !!term.element,
        });
      };

      /**
       * One wheel, frame or detach, decided and then performed. The answer is
       * what xterm's custom wheel handler returns.
       */
      const performWheel = (event: SmoothWheelEvent): boolean => {
        const r = reduceWheel(wheelState, event, wheelWorldNow());
        wheelState = r.state;
        for (const action of r.actions) {
          switch (action.kind) {
            case "emit":
              // The same primitive as the touch path, and the same reason for
              // separate dispatches. These carry `point`, which is the touch
              // path's last y or 100.
              dispatchWheels(wheelsFor(action, point));
              break;
            case "schedule-frame":
              // UNCONDITIONAL, never gated on `pumping`: the frame case
              // re-arms and comes back with `pumping` true because more travel
              // is owed (:6224), so a guard on that flag would drop every
              // re-arm and stall a burst bigger than one frame. The module
              // keeps the one-outstanding invariant instead (:6257 arms only
              // when nothing is out).
              wheelFrame = requestAnimationFrame(onWheelFrame);
              break;
            case "cancel-frame":
              if (wheelFrame !== null) cancelAnimationFrame(wheelFrame);
              wheelFrame = null;
              break;
            default: {
              const unhandled: never = action;
              void unhandled;
            }
          }
        }
        return r.passToXterm;
      };

      /** term.html's `pumpWheel` (:6212), which tests nothing: only this asks. */
      function onWheelFrame(): void {
        wheelFrame = null;
        if (disposed) return;
        performWheel({ type: "frame" });
      }

      /**
       * xterm's SANCTIONED hook, which runs before the damp and the cap
       * (term.html:6188-6192, :6267). It stays attached for the terminal's
       * whole life where the page attaches and detaches it from the pref path
       * (:6264-6273), and that is safe because a `smoothOn: false` world passes
       * every wheel straight through to the same raw xterm path.
       *
       * What the always-attached shape gives up is the OTHER two things the
       * page's detach does (:6269-6271): zero the accumulator and cancel the
       * pending frame. Both ride the module's `detached` event, and the only
       * route a live pref change has into a mounted terminal is `__tlPrefsLive`
       * (:9173-9188), which is not ported, the same gap `bootPrefs` records
       * for the font size. So a frame already scheduled when the pref goes off
       * still drains, once, where term.html cancels it. Whoever ports that
       * bridge owes this a `performWheel({ type: "detached" })`.
       */
      term.attachCustomWheelEventHandler((e: WheelEvent): boolean =>
        performWheel({ type: "wheel", wheel: e }),
      );

      attachment = attach({
        base: "",
        args: props.args,
        write: (bytes) => {
          // ONE ATTENTION EVENT PER OUTPUT FRAME, and attach.ts calls this for
          // output frames alone (a title or prefs frame arrives once per
          // connect and is not news). `document.hidden` is read HERE rather
          // than stored, because the browser flips that flag and QUEUES the
          // visibilitychange event: a frame processed inside that window is
          // judged on the old value by a stored one, and then stays silent for
          // the rest of the hidden period.
          //
          // BEFORE the write, where the page has it (`noteHiddenOutput()` at
          // :10388, `term.write` at :10391-10392), so a BEL inside this same
          // frame reaches `onBell` after the output signal and the two arrive
          // in that order.
          feedAttention({ type: "output", tabHidden: document.hidden });
          term.write(bytes);
        },
        size: () => ({ cols: term.cols, rows: term.rows }),
        // A (re)attach starts a fresh pty input line, so the mirror's diff
        // baseline is stale and drops, and it hard-cancels a coast. Both are
        // term.html's, in this order, inside the socket's own `onopen`:
        // `mirrorLineReset()` at :10293 then `cancelScrollMomentum()` at
        // :10294. The order is load-bearing for the offline-Enter flow: the
        // reset lands before the hold is replayed 49 lines later (:10342), so
        // the pty comes back holding a line whose baseline says empty, which is
        // the state mirror.ts's `backspace-at-empty` exists for.
        //
        // ON `onAttach` AND NOT ON `onPhase("open")`, which is where this was
        // and which is not once per attach. attach.ts says the two routes that
        // re-fire it; the mirror reset is the half that cannot take them,
        // because it is a write to the field a person may be mid-word in and
        // mirror.ts:56-63 says a live QuickType or Gboard suggestion goes with
        // it. A session view coming back on screen asks, so the frequent
        // trigger is ordinary navigation.
        //
        // The other half of term.html's line, a SESSION SWITCH, needs nothing
        // here: the lobby mounts one terminal per session and keeps them apart,
        // so the coast a switch would have to cancel belongs to a different
        // instance.
        onAttach: () => {
          feedMirror({ type: "out-of-band", value: mirrorField?.value ?? "" });
          cancelCoast();
        },
        onPhase: (phase, attempt) => {
          props.onConn?.(report(phase, attempt));
        },
        watch: () => props.watch?.() === true,
        onHeld,
      });
      const a = attachment;

      /**
       * THE INPUT CHOKE POINT, which is what term.html's `sendInput` is
       * (:8263) and why the coast cancel sits inside it at :8269 rather than on
       * each input path: "a pty-bound byte hard-cancels a flick coast, WHATEVER
       * path produced it".
       *
       * Every pty-bound STRING in this component goes through here: the
       * keyboard below, the word-jump sequences, a replayed status-row click,
       * and everything upstream that reaches `__tlSendToTerminal`. That last
       * one is why touchscroll's fourth interrupt site collapses into this one:
       * natively the soft keys go through SessionView's `sendBytesToPty` to
       * that bridge, where term.html's toolbar called `cancelScrollMomentum()`
       * for itself at :6823 before reaching `sendInput`.
       *
       * NOT `sendBinary`: term.html's own `term.onBinary` hook (:8361-8370)
       * cancels nothing and reaches `ws.send` without passing `sendInput` at
       * all, because a mouse report is not something a person typed.
       *
       * A MOUSE REPORT DOES REACH HERE ANYWAY, and that is why the cancel goes
       * through `cancelCoast`. SGR encoding puts the report on `onData` rather
       * than `onBinary` (`emittingWheel` has the measurement), so a coast's own
       * wheel arrives at this choke point as a pty-bound string. The bytes still
       * go out; only the coast cancel is excluded, twice over, since the onData
       * hook raises its own interrupt for the same report.
       */
      const send = (data: string): void => {
        cancelCoast();
        a.send(data);
      };

      /**
       * The soft toolbar's armed modifiers, which is the only state either key
       * reducer carries.
       *
       * NULL, which is term.html's DESKTOP case and a real value rather than a
       * placeholder: the page declares `softMods = null` (:6355, "only
       * populated on touch devices") and builds it inside the coarse-pointer
       * block (:6558), and its onData wrapper is gated on it being there
       * (:8343). Here it is null on every device for a different reason, and
       * that reason is a gap: this app's modifier machine lives in
       * `SoftKeys.tsx`, which holds its own `mods` signal, applies `applyMods`
       * to its OWN pre-baked bytes and consumes them there. So a letter typed
       * on the SYSTEM soft keyboard while Ctrl is armed is not remapped, where
       * term.html remaps it here on the way out of xterm, which is the only
       * place it can be, the key being ordinary `onData` text. Closing that
       * needs the toolbar's `SoftMods` to reach this component; the reducer's
       * answer is already stored back below and in `pasteText`, so the arrival
       * of a real value is the whole of what is left.
       */
      let keyState: KeyState = { mods: null };

      /**
       * Spend an armed modifier, term.html's no-arg `consumeSoftMods()` (:8973,
       * :8978).
       *
       * ONE place, because the port's `consumeSoftMods` is PURE
       * (`mobile/softmods.ts`, `SoftMods -> SoftMods`) where the page's mutates
       * a page global, and both callers own the same `keyState.mods`: a paste
       * (whose first character is the ESC of `ESC [200~` under bracketed paste)
       * and the mirror's multiline-paste branch. Following either module's list
       * literally, with each storing its own answer, is how the armed modifier
       * ends up never spent. It consumes rather than clears, so a LATCHED
       * modifier still remaps the first pasted character; that asymmetry is
       * term.html's. A no-op while `mods` is null, which is every device today
       * for the reason given where that state is declared.
       */
      const disarmSoftMods = (): void => {
        if (keyState.mods) keyState = { mods: consumeSoftMods(keyState.mods) };
      };

      /* ---------------------------------------------------------------- *
       * THE COMPOSE MIRROR: the field the DOM half of mirror.ts acts on.
       *
       * The module diffs the field's value against the pty's input line as it
       * shaped it and hands back the byte delta. This is the field, the flags
       * and the three listeners; every decision is over there.
       * ---------------------------------------------------------------- */

      /** The pty's input line as this mirror shaped it (term.html's `lastValue`). */
      let mirrorState: MirrorState = EMPTY_MIRROR;
      /**
       * These bytes are the mirror's own, so the onData hook must not read
       * their echo as an out-of-band reset. term.html's `mirrorEmitting`
       * (:6375, set around its `term.input` call at :7234-7235).
       */
      let mirrorEmitting = false;
      /**
       * A `set-field` write must not come back as an `edited` event.
       * term.html's `suppress` (:7188, :7269-7271): the DOM fires no `input`
       * for a programmatic `.value` assignment, but the flag is what makes that
       * true of every path rather than of the ones we happen to know about.
       */
      let suppressField = false;
      /**
       * The field's three listeners, taken off in `teardown`.
       *
       * Solid unmounts the element with the component, so this is the same
       * belt-and-braces the host's own listeners get: one teardown, and nothing
       * left holding a disposed terminal.
       */
      let releaseField: (() => void) | null = null;

      /**
       * Autogrow to 5 lines, and refit when the bar's height moved.
       * term.html's `autoGrowCompose` + `growAndRefit` (:7143-7164).
       *
       * Every height derives from the computed style, as it does there, so a
       * CSS change cannot desync the clamp. The 21px line-height fallback is
       * the page's own (:7149).
       *
       * The refit goes through the viewport decision rather than to `refit`
       * alone, because the bar's height is a TERM of the host's height
       * (`barReservePx`): a line added to the field takes a row off the
       * terminal, and term.html reaches the same recalculation the long way
       * round, `growAndRefit` -> `refit()` -> its rAF -> `syncViewport()`
       * (:8472-8476). Only on a CHANGE, which is the page's own test at :7163:
       * a typing burst costs one fit, never one per keystroke.
       */
      const growBar = (): void => {
        const field = mirrorField;
        if (!field || !composeBar) return;
        const before = composeBar.offsetHeight;
        const cs = getComputedStyle(field);
        const border =
          (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
        const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
        const line = parseFloat(cs.lineHeight) || 21;
        const maxH = Math.ceil(5 * line + pad + border);
        field.style.height = "auto";
        const want = field.scrollHeight + border; // border-box height
        field.style.height = `${Math.min(want, maxH)}px`;
        field.style.overflowY = want > maxH ? "auto" : "hidden";
        if (composeBar.offsetHeight !== before) {
          feedViewport({ type: "observed", facts: viewportFacts() });
        }
      };

      /**
       * One mirror event, decided and then performed.
       *
       * The event rides along for `swallow-edit`, which is a `preventDefault`
       * on the `beforeinput` and cannot come off the return value.
       */
      const feedMirror = (event: MirrorEvent, dom?: Event): void => {
        const r = reduceMirror(mirrorState, event, {
          // `ws && ws.readyState === WebSocket.OPEN`, read at the moment of the
          // edit. attach.ts owns the socket and exposes no readyState, so the
          // ladder's phase is the reading available, and the two agree except
          // for one task: a socket that has just closed still reads `open` here
          // until its `onclose` is delivered, where the page reads the flag the
          // browser has already flipped. In that window the submit clears the
          // field while attach.ts holds the bytes. The hold carries both the
          // delta and the `\r`, so the line runs on reconnect rather than being
          // lost, which is the state `backspace-at-empty` exists for.
          connected: a.state().phase === "open",
        });
        mirrorState = r.state;
        for (const action of r.actions) {
          switch (action.kind) {
            case "send":
              // `term.input(bytes, true)` and NOT the choke point, because the
              // mirror's whole route is xterm's own onData -> the soft-modifier
              // remap -> `send` -> the socket. No new socket path
              // (term.html:7232-7236). Marked as ours for the length of the
              // call, which is synchronous: `term.input` fires onData before it
              // returns, and the `finally` is what keeps a throw from leaving
              // the flag stuck true and the baseline permanently stale.
              mirrorEmitting = true;
              try {
                term.input(action.bytes, true);
              } finally {
                mirrorEmitting = false;
              }
              break;
            case "paste":
              // NOT marked as ours: this paste's onData traffic is what resets
              // the baseline, and marking it would swallow that
              // (term.html:7309-7310). Not through `pasteText` either, which
              // would spend the arm a second time; the module lists the disarm
              // as its own action, immediately before this one.
              term.paste(action.text);
              break;
            case "disarm-soft-mods":
              disarmSoftMods();
              break;
            case "swallow-edit":
              // So the block never enters the one-line field (:7316).
              dom?.preventDefault();
              break;
            case "set-field": {
              const field = mirrorField;
              if (!field) break;
              suppressField = true;
              field.value = action.value;
              suppressField = false;
              // A programmatic assignment fires no `input`, so the autogrow
              // listener never runs for it and the bar keeps the height of a
              // line that is gone. term.html calls `growAndRefit` by hand at
              // :7273 and :7296 for exactly this.
              growBar();
              break;
            }
            case "say":
              // The held-input clock, shared so a drop does not say two things
              // at once (term.html's `heldSay`, :8191-8195).
              heldSay(action.message, "info");
              break;
            default: {
              const unhandled: never = action;
              void unhandled;
            }
          }
        }
      };

      if (mirrorField) {
        const field = mirrorField;
        // The height first and the diff second, which is term.html's order:
        // `growAndRefit` is registered on `input` at :7165 and the mirror
        // engine's own listener at :7276.
        const onFieldInput = (): void => {
          if (suppressField) return;
          growBar();
          feedMirror({
            type: "edited",
            value: field.value,
            // `selectionStart`, which the differ never reads: keying the diff
            // on the caret would only pay off with pty cursor tracking, and
            // there is none (mirror.ts's V1 constraints). Carried so that stays
            // checkable.
            caret: field.selectionStart,
          });
        };
        // `insertFromPaste` ONLY, and `e.data` as it stands: a single-line paste
        // falls through, inserts natively and streams like typing, which is
        // what keeps the field showing the line (:7306-7320).
        const onFieldBeforeInput = (e: InputEvent): void => {
          if (e.inputType !== "insertFromPaste") return;
          feedMirror({ type: "paste-intent", data: e.data ?? "" }, e);
        };
        // Backspace against an EMPTY field erases pty-side text the mirror does
        // not hold, which is what an out-of-band reset leaves behind
        // (:7321-7327). `isComposing` because an IME owns its own backspaces.
        const onFieldKeyDown = (e: KeyboardEvent): void => {
          if (e.key !== "Backspace") return;
          feedMirror({
            type: "backspace-at-empty",
            value: field.value,
            composing: e.isComposing,
          });
        };
        field.addEventListener("input", onFieldInput);
        field.addEventListener("beforeinput", onFieldBeforeInput);
        field.addEventListener("keydown", onFieldKeyDown);
        releaseField = () => {
          field.removeEventListener("input", onFieldInput);
          field.removeEventListener("beforeinput", onFieldBeforeInput);
          field.removeEventListener("keydown", onFieldKeyDown);
        };
        // The field starts at the height of one line, measured rather than
        // assumed, as `setComposeVisible` grows it on the way in (:7380).
        growBar();
      }

      /**
       * The whole `term.onData` wrapper (term.html:8340-8360): two
       * unconditional calls at its head, then the armed-modifier remap.
       *
       * The two head calls run for an empty chunk too, because both sit ABOVE
       * the `if (softMods && data)` gate (:8343), and only the REMAP is gated:
       * xterm emits an empty chunk on some composition paths, and burning an
       * arm on one would drop the modifier before the character it was armed
       * for arrived.
       */
      term.onData((data) => {
        const r = reduceData(keyState, data, {
          // TRUE only for the length of the mirror's own `term.input` call,
          // which is where term.html reads this too (:8342 against the flag it
          // sets at :7234-7235). Answering false mid-emit clears the field the
          // person is typing in; answering true for a keystroke leaves the
          // baseline stale.
          mirrorEmitting,
        });
        keyState = r.state;
        for (const action of r.actions) {
          switch (action.kind) {
            case "cancel-momentum":
              // Deliberately redundant with `send` above, as it is in the page:
              // :8341 cancels here AND :8269 cancels at the choke point, whose
              // comment calls the scattered per-path cancels belt-and-braces.
              // An interrupt with no coast in flight decides nothing.
              //
              // Through `cancelCoast`, because this hook is also where a mouse
              // report lands under SGR encoding, so a coast's own wheel reaches
              // it. It is the first of the two interrupts one report raises.
              cancelCoast();
              break;
            case "mirror-out-of-band":
              // `mirrorLineReset` (:8342): bytes reached the pty by a route the
              // mirror did not emit, so its baseline is a lie and the field
              // drops with it. This hook is ordinary typing in xterm's own
              // helper textarea; the other eight of term.html's nine sites come
              // in through `__tlSendToTerminal` and a fresh attach.
              //
              // The field's CURRENT value goes with it, because the module's
              // early-out reads it: raw typing fires this once per keystroke,
              // and re-clearing an already-empty field would force a re-measure
              // and a tmux refit on every one (:7268). With no field mounted
              // this reduces to nothing, which is the same inert stub the page
              // keeps on a fine pointer (:6376, replaced only at :7267).
              feedMirror({ type: "out-of-band", value: mirrorField?.value ?? "" });
              break;
            case "send":
              send(action.data);
              break;
            default: {
              const unhandled: never = action;
              void unhandled;
            }
          }
        }
      });
      /**
       * THE BELL, reported UNCONDITIONALLY. `term.onBell(() =>
       * signalAttention('bell'))` (term.html:5772), one event per ring, and
       * there is no visibility test on that path anywhere in the page.
       *
       * The "you are already looking at it" rule is real and belongs one layer
       * up, where it is WIDER: `notify/attention.ts` latches only while `away`,
       * which is `document.hidden || !document.hasFocus()`, so a visible but
       * unfocused tab (the lobby on a second monitor) is away to the lobby and
       * on screen to this terminal. Gating here would silence exactly the case
       * the lobby latches for. The page sets no `bellStyle` and makes no sound,
       * so there is nothing else on this path to port.
       */
      term.onBell(() => feedAttention({ type: "bell" }));

      /**
       * THE TAB'S OWN VISIBILITY, in BOTH directions (term.html:5773-5776).
       *
       * Its only job is the re-arm: becoming hidden can open a new period just
       * as much as becoming visible closes one, because a one-shot spent while
       * only the VIEW was hidden was dropped on arrival by the lobby's `away`
       * test and must not silence the first real output of the away period that
       * follows. New work rather than a line added to an existing listener.
       *
       * Registered here rather than at component scope on purpose: the re-arm
       * returns early on nothing being latched, and nothing can be latched
       * before there is a terminal writing output, so the two dynamic imports
       * cost it nothing. The page's other half of this listener, stripping its
       * own '● ' title prefix (:5777-5780), is the branch for a page with no
       * lobby to tell, and there is no native terminal outside the lobby.
       */
      const onVisibility = (): void =>
        feedAttention({ type: "tab", tabHidden: document.hidden });
      document.addEventListener("visibilitychange", onVisibility);

      // MOUSE REPORTS, and anything else xterm hands over as bytes-in-a-string:
      // tmux mouse mode and Claude Code's own TUI get no click, drag or wheel
      // without this. Its own path because the framing differs and the watch
      // gate does not apply (term.html:8359-8370, wire.ts `encodeBinaryInput`).
      term.onBinary((data) => a.sendBinary(data));

      /* ---------------------------------------------------------------- *
       * PLAIN-DRAG SELECTION, bought back from the line above.
       *
       * Turning `onBinary` on is what puts the terminal into mouse reporting,
       * and xterm then treats a plain left drag as something to report instead
       * of something to select with. term.html:5921-6055 exists to get
       * selection back, and dragselect.ts is that port: pointer facts in,
       * a list of actions out. This half is the DOM the actions act on.
       * ---------------------------------------------------------------- */

      /**
       * The whole gesture, held by the module rather than by this file.
       *
       * term.html arms a pair of per-gesture closures on each press it holds
       * back and removes them on travel or release (:6001-6002, :6033-6034,
       * :5953-5956). The module keeps that in `pending`/`drag`, so what is
       * installed here is three permanent listeners and nothing else.
       */
      let gesture: DragSelectState = NO_GESTURE;
      /**
       * The node a clone was dispatched on, and so the node `finalize-drag`
       * must send its synthetic mouseup to. term.html carries it on `cloneDrag`
       * (:5951) and clears it with the drag (:5923, :5954); a pure reducer has
       * no element, so the field lives here on the same lifetime.
       */
      let cloneTarget: EventTarget | null = null;
      /** The node of the press the module is holding back. See `perform`. */
      let pressTarget: EventTarget | null = null;
      /**
       * The copy-recovery stash, so a dismissal can do what term.html's
       * `clearSelectionBecause` does (:5892-5902) through the module that owns
       * the rule.
       *
       * Nothing feeds it a `selection` event yet, because copy is pass 2, so
       * today it only ever holds null. The dismissal is routed through
       * `reduceStash` anyway: the guard that a dismissal with nothing
       * highlighted must NOT kill a pending copy (:5893) belongs in one place,
       * and this is the call that is already right when copy arrives.
       */
      let stash: SelectionStash | null = null;

      /**
       * term.html's `clearSelectionBecause` (:5892-5897), and the ONE place
       * either caller passes through.
       *
       * TWO callers, and they are the reason this is a function rather than a
       * case in each action loop: the drag interceptor dismisses a highlight it
       * is replacing (dragselect.ts's `clear-selection`) and Escape dismisses
       * one deliberately (keys.ts's, term.html:8566). Both write the SAME
       * `stash`, and two loops each running their own `reduceStash` would fork
       * the recovery stash, the ADR-0003 failure class reached from the side
       * where a dismissed selection stays copyable and the next Ctrl+C copies
       * instead of interrupting.
       *
       * THE ORDER IS THE CONTRACT. `term.hasSelection()` is read FIRST, because
       * :5893 returns early when nothing is highlighted and that read is what
       * selection.ts's `reduceStash` is given as `dismissed`. Clearing before
       * it reports `hasSelection: false`, the stash survives its own dismissal,
       * and Ctrl+C copies recovered text where the user expects SIGINT.
       *
       * AND THE EARLY RETURN COVERS THREE THINGS, not one. `if
       * (!term.hasSelection()) return;` (:5893) sits above the stash kill
       * (:5894), the telemetry (:5896) and `term.clearSelection()` (:5897), so
       * a dismissal with nothing highlighted files no incident and clears
       * nothing. The stash third is delegated to `reduceStash`, which is why
       * the call stays unconditional and reads the same value; the other two
       * are the component's, so the return is here. It is REACHABLE:
       * dragselect.ts's `clear-selection` rides `e.detail > 1` alone (:409),
       * and `if (!term.hasSelection() || e.detail > 1)` at :6010-6011 is
       * term.html's own proof that a double press with nothing selected gets
       * here. Filing it anyway double-counts the deliberate-dismissal bucket
       * ADR-0003 telemetry measures, and diagnostics default on.
       *
       * ONE LINE OF :5892-5897 IS NOT PORTED, deliberately and with a place to
       * put it: `lastExplainedClear = { why, t: performance.now() }` (:5895).
       * Its only reader is the selection-lifecycle watcher (:6303-6323), which
       * calls a clear UNEXPLAINED unless an explained one was stamped within
       * 200ms (:6316-6317). That watcher is not ported, so the stamp would be
       * state nobody reads; when it lands it must be written HERE, because this
       * is the one place both explained dismissals pass. Porting the watcher
       * without the stamp files every deliberate Escape under the bucket
       * ADR-0003 keeps for repaint-clears nobody asked for.
       *
       * `tel` is `tlDiagnostics.incident` (:5868-5870), which is `diag()` here.
       * The `?seldebug` console line and toast (:5898-5901) have no equivalent
       * in this app.
       */
      const clearSelectionBecause = (reason: string): void => {
        // One read, as the page makes one (:5893), and the same value answers
        // both halves.
        const highlighted = term.hasSelection();
        stash = reduceStash(
          stash,
          { type: "dismissed", hasSelection: highlighted },
          performance.now(),
        );
        if (!highlighted) return;
        diag().incident("sel-cleared", { "tl.reason": reason });
        term.clearSelection();
      };

      /**
       * Everything the interceptor reads from outside itself, for THIS event.
       *
       * `insideScreen` is scoped to this terminal's own host, where term.html
       * can afford `document.querySelector('.xterm-screen')` (:5961) because a
       * framed page holds exactly one terminal. The lobby keeps every visited
       * session mounted (App.tsx:835-842) and the dock can hold a second
       * terminal, so one press reaches every instance's document listener, and
       * a document query would have all of them swallow it and clone it. The
       * `instanceof Node` test in front of `contains` is term.html's (:5962).
       *
       * `screen` is a getter, measured at most once and only if read. The
       * module reads it on a press and nowhere else, mousemove fires
       * continuously, and `getBoundingClientRect` flushes layout against a grid
       * xterm is writing into. term.html measures in the mousedown for the same
       * reason (:5963), and a getter keeps the value as fresh as a field would
       * be without paying for it on every motion.
       */
      const worldAt = (target: EventTarget | null): DragSelectWorld => {
        const scr = screenOf();
        let box: ScreenBox | null | undefined;
        return {
          now: Date.now(),
          isMac: macPlatform,
          insideScreen: !!scr && target instanceof Node && scr.contains(target),
          hasSelection: term.hasSelection(),
          get screen(): ScreenBox | null {
            if (box === undefined) {
              const r = scr?.getBoundingClientRect();
              box = r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
            }
            return box;
          },
          rows: term.rows,
          cols: term.cols,
          mouseTracking: term.modes.mouseTrackingMode,
        };
      };

      /**
       * Carry out one reduction, in the order the module listed its actions.
       *
       * `cloneOn` is where a `force-selection` dispatches, and it is a
       * parameter because the answer differs by event: a press clones itself,
       * while a travel clones the press that was being held back (term.html
       * dispatches `start0`/`start`, :5980, :6026), whose node this file kept.
       */
      const perform = (
        r: DragSelectReduction,
        e: MouseEvent,
        cloneOn: EventTarget | null,
      ): void => {
        gesture = r.state;
        for (const action of r.actions) {
          switch (action.kind) {
            case "swallow-press":
              // Both calls, at one site in the page (:5966-5967). The listeners
              // below have to be document-capture for the first of them to do
              // anything: xterm's own handler sits on the screen element, a
              // descendant, so nothing later in the tree gets a chance
              // otherwise. It also ends the event for any terminal mounted
              // AFTER this one, which is only ever a terminal the press was not
              // inside.
              e.stopImmediatePropagation();
              e.preventDefault();
              break;
            case "swallow-motion":
              // stopImmediatePropagation alone here, no preventDefault (:6053).
              e.stopImmediatePropagation();
              break;
            case "force-selection": {
              const target = cloneOn ?? screenOf();
              if (!target) break;
              cloneTarget = target;
              // The clone re-enters the mousedown listener below as an
              // UNTRUSTED press, which the module passes through with the very
              // state object it was handed, so the assignment at the top of
              // this function is idempotent and the rest of this loop still
              // runs. That is term.html's order as well: clone, then focus
              // (:6012-6013).
              target.dispatchEvent(
                new MouseEvent("mousedown", { ...action.clone, view: window }),
              );
              break;
            }
            case "finalize-drag": {
              // term.html:5921-5930: the remembered node, else the screen, else
              // nothing at all. The synthetic mouseup re-enters the mouseup
              // listener below, where the module has already cleared the drag.
              const target = cloneTarget ?? screenOf();
              if (!target) break;
              target.dispatchEvent(
                new MouseEvent("mouseup", {
                  bubbles: true,
                  cancelable: true,
                  composed: true,
                  view: window,
                  clientX: action.at.clientX,
                  clientY: action.at.clientY,
                  button: 0,
                  buttons: 0,
                }),
              );
              break;
            }
            case "clear-selection":
              // The shared `clearSelectionBecause` above, which is where the
              // order and the one un-ported line are argued. keys.ts's Escape
              // leg calls the same function against the same stash.
              clearSelectionBecause(action.reason);
              break;
            case "focus":
              // term.html's `tapFocus` (:5815, reassigned at :7459-7462).
              // touchscroll.ts's `focus` action is the same call. On a fine
              // pointer no field is mounted, so this is still `term.focus()`
              // there, which is what the page's un-reassigned arrow does.
              tapFocus();
              break;
            case "replay-status-click":
              // The choke point, NOT `a.sendBinary`: term.html replays through
              // `sendInput` (:5994-5995), which carries the read-only guard, so
              // a watcher's status-row click is refused and explained rather
              // than written into a session they cannot type into.
              for (const bytes of action.sends) send(bytes);
              break;
            default: {
              const unhandled: never = action;
              void unhandled;
            }
          }
        }
        // `cloneTarget` means nothing once the drag is over, and the module
        // clears `drag` on both of its endings, as term.html clears the whole
        // of `cloneDrag` (:5923, :5954).
        if (gesture.drag === null) cloneTarget = null;
      };

      const onPress = (e: MouseEvent): void => {
        const r = reduceGesture(gesture, { type: "press", press: e }, worldAt(e.target));
        // Remembered only while the module is holding THIS press, so a press it
        // passed through (a right button, a modifier chord, our own clone)
        // cannot move the node a later travel will clone from.
        if (r.state.pending?.press === e) pressTarget = e.target;
        perform(r, e, e.target);
      };
      const onMotion = (e: MouseEvent): void => {
        const ev = { type: "motion", motion: e } as const;
        perform(reduceGesture(gesture, ev, worldAt(e.target)), e, pressTarget);
      };
      const onRelease = (e: MouseEvent): void => {
        const ev = { type: "release", release: e } as const;
        perform(reduceGesture(gesture, ev, worldAt(e.target)), e, null);
      };
      // Permanent and at CAPTURE, all three. Not passive: mousedown is not
      // passive by default, and passing the option would make the
      // preventDefault above a no-op.
      document.addEventListener("mousedown", onPress, true);
      document.addEventListener("mousemove", onMotion, true);
      document.addEventListener("mouseup", onRelease, true);

      /* ---------------------------------------------------------------- *
       * THE KEYBOARD: the one handler xterm stores, the onData hook's remap,
       * and the paste route both of them share.
       * ---------------------------------------------------------------- */

      /**
       * Text into this terminal, however it arrived. The Paste button, the
       * soft keys and the palette reach `__tlPasteToTerminal` below, which
       * SessionView hands the clipboard text the LOBBY read
       * (SessionView.tsx:543-550); a Ctrl/Cmd-V or a long-press Paste reaches
       * the event listener under it.
       *
       * term.paste, NOT a raw send: it wraps the text in bracketed paste when
       * the app asked for it and normalizes \r\n, so a multiline paste stops
       * executing line by line in a shell (term.html:9404-9409). It reaches
       * the pty through xterm's own onData, which is the same choke point a
       * keystroke takes, so watch mode still drops it.
       *
       * THE CONSUME IS PART OF THE ROUTE, and this is why it is not a line
       * anyone should tidy away. `term.paste()` ends in
       * `coreService.triggerDataEvent`, so pasted text arrives at the onData
       * hook above like a keystroke, and with bracketed paste on its first
       * character is the ESC of `ESC [200~`. An armed Ctrl would be spent on
       * that ESC for no visible effect; an armed Alt would prepend a SECOND
       * ESC and corrupt the bracket sequence itself. term.html avoids both by
       * calling `consumeSoftMods()` immediately before its two `term.paste`
       * calls (:8973, :8978), which is `disarmSoftMods` above: one spender,
       * shared with the mirror's own multiline-paste branch.
       *
       * Empty text is dropped rather than pasted, as the page drops it
       * (:8933), but the answer is still true: a terminal took the paste, and
       * false means there was no terminal to take it. The consume is INSIDE
       * that test, where all three of the page's are (:8942 under the `if
       * (text)` at :8933, and :8973 and :8978 each guarded the same way): an
       * empty paste reaches no character to remap, so spending an arm on it
       * would drop the modifier before the paste it was armed for.
       */
      const pasteText = (text: string): boolean => {
        if (!text) return true;
        disarmSoftMods();
        term.paste(text);
        return true;
      };

      /**
       * Carry out one key decision (keys.ts), in the order it listed its
       * actions.
       *
       * The event rides along because two legs ask for `preventDefault` and
       * neither gets it from the return value: answering false short-circuits
       * xterm BEFORE its own `cancel(ev)`, so false alone suppresses no browser
       * default. That is what makes the F12 leg work and why the two legs that
       * DO want a default suppressed ask for it explicitly.
       */
      const performKey = (r: KeyReduction, e: KeyboardEvent): void => {
        for (const action of r.actions) {
          switch (action.kind) {
            case "send":
              // The choke point, which is what term.html's word-jump leg calls
              // (`sendInput`, :8550), so a watcher's Option+Arrow is refused
              // and explained like every other key.
              send(action.data);
              break;
            case "prevent-default":
              e.preventDefault();
              break;
            case "clear-selection":
              clearSelectionBecause(action.reason);
              break;
            case "copy": {
              // term.html reaches `navigator.clipboard.writeText` unguarded
              // (:8570, :8579). That throws where the API is absent, which is
              // any non-secure context, and a throw inside xterm's key handler
              // takes the keystroke with it. The refusal toast is the same news
              // the `.catch` would have given, so the guard changes what a
              // person sees from nothing to that.
              const clipboard: Clipboard | undefined = navigator.clipboard;
              const refuse = (): void => {
                showToast(action.failureToast, action.failureToastKind, action.failureTimeoutMs);
              };
              if (!clipboard) refuse();
              else {
                void clipboard
                  .writeText(action.text)
                  .then(() => showToast(action.toast, action.toastKind, action.timeoutMs))
                  .catch(refuse);
              }
              // OUTSIDE that chain, where :8582 is a plain statement following
              // the `.then`/`.catch` opened at :8579: it runs whether the write
              // resolves or is refused, and moving it inside would lose the
              // count exactly where the write was blocked, which is the case
              // the failure toast exists for. The attribute is `len` and not
              // `tl.len` because that is the name the page passes; its
              // `sel-cleared` call uses the prefixed form and this one does
              // not.
              //
              // UNREACHABLE TODAY, and the reason is one wiring away: `recovered`
              // is only ever true when the stash holds text, and nothing feeds
              // `stash` a `selection` event. term.html stashes inside the
              // selection-lifecycle watcher (:6311, in :6303-6323), which the
              // design doc groups with the rest of the selection and copy
              // wiring. Porting only its stash line would leave its UNEXPLAINED
              // telemetry, and the 200ms stamp `clearSelectionBecause` owes it,
              // split across two stages.
              if (action.recovered) diag().incident("copy-recovered", { len: action.text.length });
              break;
            }
            case "toast":
              showToast(action.message, action.toastKind, action.timeoutMs);
              break;
            case "discard-held":
              // term.html's `discardHeldInput` (:8237-8242): clear the queue and
              // dispose the held-key overlay.
              //
              // UNREACHABLE BY CONSTRUCTION, and deliberately so rather than
              // pending: the world below passes `EMPTY_HELD`, so `isHolding` is
              // false and keys.ts never takes this leg. attach.ts owns the hold
              // and exposes no discard, and the overlay this would dispose is
              // not ported. Wiring the leg without the discard is worse than
              // leaving it: Escape would be swallowed, a toast would promise
              // the line was thrown away, and the hold would replay on the next
              // reconnect anyway. What it needs is a `discardHeld()` on
              // `Attachment` plus the hold and its dim flag reaching this
              // component, which is the same pair `heldWord` above already
              // reads on the callback.
              break;
            default: {
              const unhandled: never = action;
              void unhandled;
            }
          }
        }
      };

      /**
       * THE ONE KEY HANDLER xterm STORES, now the whole of term.html's
       * `attachCustomKeyEventHandler` contract (:8516-8589).
       *
       * xterm keeps exactly one (`_customKeyEventHandler` is a single field and
       * a second `attachCustomKeyEventHandler` replaces it), so every rule that
       * wants a look at a keydown shares this function, and keys.ts tests them
       * in the page's order. What each leg does NOT do is the interesting part:
       * Escape clears a highlight and still reaches vim, Ctrl+C is a copy while
       * one is up and SIGINT the moment it is not, F12 goes to the browser
       * whole.
       *
       * The chord tests are selection.ts's, not `e.key === "c"`, because on a
       * Cyrillic layout the C position reports `с` and a key test misses it,
       * firing SIGINT with a highlight on screen. That is the failure ADR-0003
       * exists to prevent.
       *
       * THE PASTE LEG is the one that was here before the rest, and its measured
       * record belongs with it. Ctrl+V is `\x16` to xterm by default, from the
       * plain-Ctrl-letter arm of `evaluateKeyboardEvent`, and xterm then
       * preventDefaults the keydown (`cancel(ev, true)`), which is what stops
       * the browser firing its paste event at all. Measured on the deployed site
       * with a raw pty capture: the iframe path put the 53 bytes of clipboard
       * text on the pty and this path put a single 0x16, and since ^V is
       * quoted-insert in zsh it then swallowed the first byte of the next paste
       * too. Answering false is the whole fix (term.html:8585-8586, "let the
       * browser paste event fire"). Cmd+V on a Mac never had the problem, xterm
       * yielding no key and no preventDefault for it, and both go through this
       * one decision anyway: a chord whose answer depends on the platform is a
       * chord nobody can reason about.
       *
       * `appChord` IS A DECLARED DIVERGENCE. keys.ts asks for
       * `tlKb.matchesAppChord(e)` (term.html:8526), and the engine that answers
       * it is created in App.tsx and reaches neither this component nor
       * SessionView (keybindings/engine.ts, `createKeybindingEngine`). What is
       * read instead is `e.defaultPrevented`, which is true for the same events
       * and for one more:
       *   - the engine's own `onKeydown`, which `init` installs on `window` at
       *     CAPTURE, calls `preventDefault()` on exactly a `matchesAppChord`
       *     match and then runs the command. Capture descends, so it has already
       *     run by the time xterm's own listener consults this handler: the
       *     installed @xterm/xterm 6.0.0 registers that one on `this.textarea`,
       *     a descendant of the host, also at capture. All that is left to decide
       *     is that the key must not ALSO be typed, which is what this leg
       *     answers.
       *   - App.tsx's Ctrl/Cmd+J dock chord (App.tsx, `onDockKey`) is the extra
       *     one, and it is the answer term.html gives too: its own keybinding
       *     table carries `ctrl+j` -> `session.new.shell`, so :8526 swallows it
       *     there. Every other capture-phase keydown listener in the app belongs
       *     to an overlay that owns the keyboard while it is open, and a
       *     terminal is not focused behind one.
       * The cost of being wrong either way is worth naming: too NARROW and a
       * chord fires and types, so Alt+Shift+W kills the session and puts ESC W
       * on the pty; too WIDE and a key the app claimed is silently not typed.
       * Threading the matcher itself needs a prop through SessionView from
       * App.tsx, which is the shape to prefer once one of those files is open.
       *
       * `selection` is a getter because term.html reads `term.getSelection()`
       * only inside its copy branch (:8570) and never on an ordinary keystroke,
       * and xterm builds that string by translating every selected row.
       * `hasSelection` is not the same question and is read eagerly: a drag
       * ending in a row's trailing blanks leaves a visible highlight whose text
       * is "", which still clears on Escape and still spends the copy chord.
       */
      term.attachCustomKeyEventHandler((e: KeyboardEvent): boolean => {
        const r = reduceKey(
          {
            now: performance.now(),
            macLike: macPlatform,
            appChord: e.defaultPrevented,
            selection: {
              hasSelection: term.hasSelection(),
              get selection(): string {
                return term.getSelection();
              },
              stash,
            },
            // See the `discard-held` arm: no hold reaches this component yet,
            // and a world that claimed otherwise would swallow Escape.
            held: EMPTY_HELD,
            heldDim: false,
          },
          e,
        );
        performKey(r, e);
        return r.passToTerminal;
      });

      /**
       * THE PASTE EVENT the chord above now allows, delivered.
       *
       * THE CHORD LEG ALONE ALREADY FIXES THE DEFECT, measured against the real
       * library rather than assumed: with the handler wired and no listener of
       * ours at all, xterm's own `handlePasteEvent` takes the text and produces
       * the same pty bytes, `one\rtwo` either way. So this listener is not the
       * missing receiver, and an earlier version of this comment said it was.
       *
       * What it adds is two things worth having. It calls `preventDefault`,
       * which xterm does not, keeping the pasted text out of xterm's offscreen
       * helper textarea the way term.html does (:8934). And it routes through
       * the same named path the toolbar bridge uses, so paste has one
       * implementation rather than one for the chord and another for the button.
       *
       * For context on why the iframe needed no such thing: term.html's own
       * document paste listener (:8932-8944) lives in the FRAMED document. This
       * app has a document listener too (clipboard/attach.ts), and it takes
       * IMAGE items only, passing a text paste through for the focused field,
       * which is right for the composer.
       *
       * Scoped to THIS terminal's host, where term.html could use the document
       * because that page held one terminal and excluded its own compose field
       * by id (:8900-8903). The lobby's own inputs live in the SAME document as
       * this terminal, so a document-level swallow would send the composer's
       * and the rename box's text to the pty. A paste event is dispatched at
       * the focused element, so "inside this host" is exactly the question
       * worth asking, and it also settles the duplication clipboard/attach.ts
       * needed an `active` gate for: every mounted session's document listener
       * sees one paste, while only the focused terminal's host is on its path.
       *
       * CAPTURE, and it stops the event, because xterm registers its own
       * `handlePasteEvent` on the helper textarea and on `.xterm` in
       * `_initGlobal`, which `open()` calls (@xterm/xterm/lib/xterm.js), and
       * that handler calls the same routine `term.paste` calls. Left to
       * propagate, the same text would be pasted twice. `preventDefault` is
       * term.html's (:8934): the default action inserts the text into xterm's
       * offscreen helper textarea, the field xterm empties itself on the paste
       * path being bypassed here.
       *
       * The text is read BEFORE anything is prevented, so a paste carrying no
       * text is left entirely alone: an image belongs to clipboard/attach.ts,
       * which uploads it and types the path at the prompt. Its document
       * listener runs first, being higher up the capture path, and term.html
       * likewise takes its image branch before its text branch (:8905-8930).
       */
      const onPasteEvent = (e: ClipboardEvent): void => {
        const text = e.clipboardData?.getData("text") ?? "";
        if (!text) return;
        e.preventDefault();
        e.stopPropagation();
        pasteText(text);
      };
      host.addEventListener("paste", onPasteEvent, true);

      // `ask` goes through attach.ts's `reportNow`, which re-fires the same
      // `onPhase` above rather than reading the ladder from out here, so the
      // badge is painted through one path whether it was volunteered or asked
      // for. The two answers can still DIFFER, and that is deliberate:
      // `reportNow` recomputes from the browser rather than replaying the last
      // change, so a socket that is still readyState OPEN while
      // navigator.onLine is false answers offline where the last volunteered
      // change said open. term.html does the same, taking the message path from
      // `reportConn` and the state fresh from `currentConnState`
      // (term.html:9822-9832). That window is roughly 50 seconds wide, since
      // nothing volunteers a change until the liveness watchdog gives up.
      props.onReady?.({ reconnect: () => a.reconnect(), ask: () => a.reportNow() });

      // The size the pty is told has to follow the size xterm actually reached,
      // and a reflow can change that without the window resizing (the sidebar
      // opening, the soft keyboard arriving).
      //
      // Through the viewport decision rather than straight to `refit`, which is
      // what it did before the module landed: viewport.ts's header names this
      // observer as one of `observed`'s two callers, and `nothing` still fits,
      // so a box that changed WIDTH with the reserve unmoved behaves exactly as
      // it did. What it gains is the case where the box changed because the
      // keyboard moved.
      const ro = new ResizeObserver(() =>
        feedViewport({ type: "observed", facts: viewportFacts() }),
      );
      ro.observe(host);

      // Theme trigger 2, which the module's header calls out: an OS light/dark
      // flip while the stored theme is "system" re-reads the vars. Trigger 1,
      // an explicit pick, comes through the same global from theme.ts.
      const live = (): void => {
        term.options.theme = toXtermTheme(cssVar);
        term.refresh(0, term.rows - 1);
      };
      const w = window as unknown as Record<string, unknown>;
      const previous = w[THEME_LIVE_GLOBAL];
      w[THEME_LIVE_GLOBAL] = live;
      // The handback below is guarded on identity, and that guard is the whole
      // point rather than defensive noise. Every visited session stays mounted
      // (store/keepalive.ts), so two terminals can hold this global in
      // succession, and an unmount is not necessarily the newest claim: mount
      // T1, mount T2, unmount T1. Handing `previous` back unconditionally there
      // wipes T2's live callback while T2 is the terminal on screen, and an OS
      // light/dark flip then leaves it on its old palette until it remounts.
      // lib/ownwhile.ts states the same rule for the bridges it owns, "a
      // cleanup only restores the previous value if the handle is still ITS
      // value", and this is that rule for a global claimed on mount rather
      // than on being visible.
      const releaseTheme = (): void => {
        if (w[THEME_LIVE_GLOBAL] === live) w[THEME_LIVE_GLOBAL] = previous;
      };

      // THE SAME BRIDGES TerminalView installs, pointing at this terminal
      // instead of at an iframe. Everything upstream — paste, the soft keys, a
      // dropped file, the composer's "send to terminal" — already calls these
      // globals, so the native path inherits all of it without any caller
      // knowing which terminal it is talking to. Each returns a boolean because
      // the callers treat false as "no terminal took this".
      const owns = (): boolean => props.ownsBridges !== false;
      // Through the choke point, so the soft keys, the composer's send and a
      // dropped file's path all cancel a flick coast the way term.html's
      // `sendInput` does for every one of them (:8269).
      ownWhile(owns, "__tlSendToTerminal", (bytes: string) => {
        // THE MIRROR RESET BELONGS HERE, not at the choke point, and term.html
        // puts it here twice for the same reason: `mirrorLineReset()` THEN
        // `sendInput()` in the `tl-input` arm (:9388) and in `sendKey` (:6828).
        // These bytes never pass `term.onData`, so the hook that covers
        // ordinary typing cannot see them, and a soft arrow or Esc tap would
        // silently desync the field from the pty line it claims to mirror.
        // Seven of the page's nine reset sites arrive through this one bridge:
        // the soft-key row, the Text view's send-to-terminal, three upload
        // paths, the gallery's "Insert path into terminal" and saved paths.
        //
        // The choke point would be wrong twice over: the onData path decides
        // this question for itself (and must NOT reset while the mirror is the
        // one emitting), and the word jumps and the replayed status-row click
        // reach `send` too, where term.html resets nothing (:8550).
        feedMirror({ type: "out-of-band", value: mirrorField?.value ?? "" });
        send(bytes);
        return true;
      });
      // The same route a Ctrl/Cmd-V takes, so the toolbar button, the
      // composer's send and the chord cannot drift apart. `pasteText` above
      // carries the reasoning.
      ownWhile(owns, "__tlPasteToTerminal", pasteText);
      ownWhile(owns, "__tlFocusTerminal", () => {
        term.focus();
        return true;
      });
      ownWhile(owns, "__tlRefitTerminal", () => {
        refit("fit-wanted");
        return true;
      });
      ownWhile(owns, "__tlKeyboardOffset", (px: number) => {
        // HOW MANY PIXELS OF THE BOTTOM THE SOFT KEYBOARD COVERS, measured by
        // the shell (mobile/viewport.ts) and forwarded from App.tsx:194.
        //
        // The shrink has to happen HERE rather than on the container:
        // `.tl-views.tl-kb-inline` deliberately leaves the keyboard out of that
        // reservation (app.css, `body.has-soft-keys .tl-views.tl-kb-inline`),
        // because shrinking the container moved the terminal out from under the
        // tap that had just opened the keyboard and made it flash shut.
        //
        // term.html's `tl-kb` arm (:9407-9422), and viewport.ts is now the
        // whole decision: both of the page's gates, `max(own, forwarded)` where
        // pass 1 took the forwarded height alone, and the dedupe. The FACTS go
        // with the message because the page recomputes from a LIVE read rather
        // than from the forwarded number alone (:9419-9420), and `px` is spent
        // on this event rather than remembered: natively the two readings are
        // one measurement of one keyboard taken twice, so a remembered
        // forwarded height can only ever be older than a fresh `own` and would
        // pin the reserve at the stale maximum, where a live 0 cannot give the
        // rows back. That is where term.html's `framedKb` (:8425) is
        // deliberately left behind.
        //
        // `false` is reserved for "there was no terminal", which is what a
        // caller reads it as, and for the non-finite message the page discards
        // whole (:9418, its reason in its own words at :9416-9417).
        // viewport.ts answers `ignored` for that one, the only answer that also
        // skips the fit. A GATE refusing still answers true: the terminal did
        // take the message.
        if (!host) return false;
        return feedViewport({ type: "forwarded", px, facts: viewportFacts() });
      });

      teardown = () => {
        if (fitTimer !== undefined) clearTimeout(fitTimer);
        viewShown = null;
        ro.disconnect();
        // The two outstanding frames, given up through the modules that asked
        // for them rather than cancelled behind their backs: an `interrupt`
        // ends a coast (term.html:6130) and `detached` is the page's own
        // teardown for the pacer, zeroing the accumulator and cancelling the
        // frame (:6270-6271). Both then run through the same performers, so
        // this cannot drift from what a pref flip would do.
        feedTouch({ type: "interrupt" });
        performWheel({ type: "detached" });
        document.removeEventListener("mousedown", onPress, true);
        document.removeEventListener("mousemove", onMotion, true);
        document.removeEventListener("mouseup", onRelease, true);
        // Removing a listener that was never added is a no-op, so the four
        // touch handlers come off without re-testing the coarse-pointer gate
        // they went on under.
        host?.removeEventListener("touchstart", onTouchStart);
        host?.removeEventListener("touchmove", onTouchMove);
        host?.removeEventListener("touchend", onTouchEnd);
        host?.removeEventListener("touchcancel", onTouchCancel);
        host?.removeEventListener("wheel", onHostWheel, true);
        host?.removeEventListener("paste", onPasteEvent, true);
        document.removeEventListener("visibilitychange", onVisibility);
        releaseField?.();
        releaseField = null;
        releaseTheme();
        term.dispose();
      };
    })();
  });

  onCleanup(() => {
    disposed = true;
    // The socket and its timers first, so nothing can write a late frame into
    // an xterm that `teardown` is about to dispose.
    attachment?.dispose();
    attachment = null;
    teardown?.();
    teardown = null;
    // The frame is gone, so whatever it last said about its socket stops being
    // true — same handover the iframe makes (ADR-0016).
    props.onConn?.({ state: "closed", attempt: 0 });
  });

  return (
    <>
      <div class="tl-terminal-native" ref={host} />
      {barEngaged ? (
        <div
          class="tl-compose-mirror"
          ref={composeBar}
          // INLINE, and this is the one place in the app that reaches for that.
          // The layout here is the posture: the ghost render and the painted
          // bar differ by six declarations, and keeping them beside the
          // reasoning is worth more than a class in a 121 KB stylesheet that
          // nothing else reads. `--kb-offset`, `--safe-b` and `--sk-h` are the
          // shell's own published values (mobile/viewport.ts), so the bar rides
          // the exact stack `#soft-keys` does and there is no second source of
          // truth for where the keyboard's top edge is. term.html parks it the
          // same way (:1826-1828), with `env(safe-area-inset-bottom)` where
          // this app has `--safe-b`, which is that env() except while the
          // platform has already taken the bottom edge (app.css,
          // `body.tl-kb-up`).
          style={{
            position: "fixed",
            left: "0",
            right: "0",
            bottom:
              "calc(var(--kb-offset, 0px) + var(--safe-b, 0px) + var(--sk-h, 0px))",
            // Under the soft-key row (40), which it never overlaps: --sk-h is
            // that row's live height and this sits on top of it.
            "z-index": "39",
            "box-sizing": "border-box",
            display: "flex",
            // The buttons would hug the bottom as the field grows (:1838).
            "align-items": "flex-end",
            gap: "6px",
            "padding-left": "calc(6px + env(safe-area-inset-left))",
            "padding-right": "calc(6px + env(safe-area-inset-right))",
            "padding-top": barGhost ? "0" : "6px",
            "padding-bottom": barGhost ? "0" : "6px",
            "font-family": "var(--font-ui)",
            // GHOST: painted away but interactive. `pointer-events: none` is
            // what keeps it from intercepting the taps the terminal wants,
            // since focus arrives only through `tapFocus` (:1882-1883).
            "pointer-events": barGhost ? "none" : "auto",
            background: barGhost ? "transparent" : "var(--bg-card)",
            "border-top": barGhost ? "0" : "1px solid var(--border-strong)",
          }}
        >
          <textarea
            ref={(el) => {
              mirrorField = el;
              // MIRROR_FIELD_ATTRIBUTES rather than a hand-off, because one of
              // them is an ABSENCE: `autocomplete` is deliberately NOT in that
              // set and must not be added. term.html records the measurement
              // (:7103-7110, 2026-07-12) that on iOS, pronounced in the
              // installed PWA's WKWebView, `autocomplete='off'` also suppresses
              // the QuickType predictive bar, a WebKit coupling rather than
              // form-autofill behaviour, which silently killed suggestions in
              // this exact field. `type` is absent for a related reason: a
              // textarea has none, and the helper field's `type=password` trick
              // would kill the composition UI this field exists for. Set from
              // the constant in a loop so the set cannot drift from the module
              // that argues for it, and inside `ref` so they are on before the
              // element is connected rather than two dynamic imports later.
              for (const [name, value] of Object.entries(MIRROR_FIELD_ATTRIBUTES)) {
                el.setAttribute(name, value);
              }
            }}
            // The height the autogrow measures from (:7098).
            rows={1}
            placeholder="Compose…"
            style={{
              flex: "1 1 auto",
              "min-width": "0",
              "box-sizing": "border-box",
              resize: "none",
              // The autogrow flips this to auto past five lines (:7150-7154).
              "overflow-y": "hidden",
              "border-radius": "8px",
              color: "var(--text-primary)",
              "font-family": "var(--font-ui)",
              // 16px, and it has to be inline: this is the whole of the iOS
              // no-focus-auto-zoom guarantee, and it must not depend on a
              // stylesheet rule surviving (mirror.ts, term.html:7122, :1852-1853).
              "font-size": "16px",
              "line-height": "1.3",
              "padding-top": "8px",
              "padding-bottom": "8px",
              "padding-left": "10px",
              "padding-right": "10px",
              // GHOST keeps the field's REAL on-screen size, because a
              // zero-size field can fail to summon the iOS keyboard, and shows
              // nothing: no caret, no border, no background. NEVER
              // `display: none` or `visibility: hidden`, which kill focus and
              // the soft keyboard on iOS (a WebKit trait confirmed 2026-07-13,
              // term.html:1877-1886).
              opacity: barGhost ? "0" : "1",
              "caret-color": barGhost ? "transparent" : "auto",
              border: barGhost ? "1px solid transparent" : "1px solid var(--border-strong)",
              background: barGhost ? "transparent" : "var(--bg-page)",
            }}
          />
        </div>
      ) : null}
    </>
  );
};
