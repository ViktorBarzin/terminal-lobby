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
import type { TerminalReport } from "../diagnostics/status";
import {
  NO_FIT_OWED,
  reduce as reduceFit,
  type FitEvent,
  type FitState,
  type HostBox,
} from "../terminal/fit";
import { isHolding, type HeldState, type HeldVerdict } from "../terminal/held";
import {
  NO_GESTURE,
  reduce as reduceGesture,
  type DragSelectReduction,
  type DragSelectState,
  type DragSelectWorld,
  type ScreenBox,
} from "../terminal/dragselect";
import { reduceStash, type SelectionStash } from "../terminal/selection";
import { isCoarsePointer } from "../mobile/pointer";
import { diag } from "../telemetry/diag";
import {
  coercePrefs,
  FONT_SIZE_KEY,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  PREFS_KEY,
  type Prefs,
} from "../store/prefs";
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
  '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Monaco, "Courier New", monospace';

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
      // line with `reopened`); the Esc half is a key binding this component
      // does not have. term.html binds Escape inside its
      // `attachCustomKeyEventHandler` (:8554-8564), where it calls
      // `discardHeldInput()` and toasts "Discarded what you typed while
      // offline". That handler is a later phase, so the sentence is cut back
      // to what pressing a key here actually achieves. Porting :8554-8564 is
      // what restores the full wording.
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
 * through `term.paste`, reports the mouse and buys plain-drag selection back
 * from that reporting, fits only into a host that has a box, takes the
 * forwarded soft-keyboard height off its own height, hardens xterm's helper
 * textarea against predictive text, and says why a keystroke was refused or
 * held.
 *
 * WHAT IT IS NOT YET. The compose mirror, copy and the clipboard chords, the
 * key-handler contract, touch scroll, pinch-to-zoom, web links, the bell, sixel
 * and the held-key overlay all still belong to term.html. The soft keyboard is
 * half ported: `__tlKeyboardOffset` below takes the height the shell measured,
 * and term.html's own reading of it (`syncViewport`, :8427-8469) pairs that
 * height with its visualViewport, its toolbar and its compose bar, none of
 * which is here. It is behind a flag for exactly those reasons.
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
    if (Date.now() - saidAt < HELD_SAY_MS) return;
    saidAt = Date.now();
    showToast(word.message, word.kind);
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
       * Is the primary pointer a finger? Read ONCE, where term.html reads it
       * once (`const isCoarsePointer`, :6350, right after the same textarea
       * hardening). Reading it live would let a 2-in-1 switching to its
       * trackpad leave a keyboard reservation on screen with nothing to clear
       * it. mobile/pointer.ts is the app's own mirror of that query.
       */
      const coarsePointer = isCoarsePointer();

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
      // one (TerminalView.tsx:307-311), which needs the `active` prop the
      // native branch is not given, so a mode switch from text to terminal
      // still leaves this unfocused.
      if (bootFitted && !typingElsewhere()) term.focus();

      attachment = attach({
        base: "",
        args: props.args,
        write: (bytes) => term.write(bytes),
        size: () => ({ cols: term.cols, rows: term.rows }),
        onPhase: (phase, attempt) => props.onConn?.(report(phase, attempt)),
        watch: () => props.watch?.() === true,
        onHeld,
      });
      const a = attachment;
      term.onData((data) => a.send(data));
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

      /** THIS terminal's screen node. Never a document query: see `worldAt`. */
      const screenOf = (): HTMLElement | null =>
        host?.querySelector<HTMLElement>(".xterm-screen") ?? null;

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
              // term.html's `clearSelectionBecause`, in its order (:5892-5902):
              // the stash, the reason, then the clear. The `hasSelection` read
              // has to come BEFORE `clearSelection`, because it is the guard at
              // :5893 and selection.ts keeps the rule. `tel` there is
              // `tlDiagnostics.incident` (:5868-5870), which is what `diag()`
              // is here; its `?seldebug` console line and toast (:5898-5901)
              // have no equivalent in this app.
              stash = reduceStash(
                stash,
                { type: "dismissed", hasSelection: term.hasSelection() },
                performance.now(),
              );
              diag().incident("sel-cleared", { "tl.reason": action.reason });
              term.clearSelection();
              break;
            case "focus":
              // term.html's `tapFocus` (:5815), which is `term.focus()` until
              // the mobile input bar reassigns it to the compose field
              // (:7459-7462). That bar is pass 2, and a fine pointer never
              // reassigns it there either.
              term.focus();
              break;
            case "replay-status-click":
              // `a.send`, NOT `a.sendBinary`: term.html replays through
              // `sendInput` (:5994-5995), which carries the read-only guard, so
              // a watcher's status-row click is refused and explained rather
              // than written into a session they cannot type into.
              for (const bytes of action.sends) a.send(bytes);
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
      const ro = new ResizeObserver(() => refit("fit-wanted"));
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
      ownWhile(owns, "__tlSendToTerminal", (bytes: string) => {
        a.send(bytes);
        return true;
      });
      ownWhile(owns, "__tlPasteToTerminal", (text: string) => {
        // term.paste, NOT a raw send: it wraps the text in bracketed paste when
        // the app asked for it and normalizes \r\n, so a multiline paste stops
        // executing line by line in a shell (term.html:9404-9409). It reaches
        // the pty through xterm's own onData, which is the same choke point a
        // keystroke takes, so watch mode still drops it.
        //
        // term.html disarms its armed soft modifiers first, because its
        // onData wrapper would remap the pasted text's first character. There
        // is nothing to disarm here yet: this app's modifier machine lives
        // inside SoftKeys.tsx and only remaps the keys that component sends.
        // The remap (term.html:8340-8360) is still to port, and this line has
        // to disarm when it lands.
        //
        // Empty text is dropped rather than pasted, as the page drops it, but
        // the answer is still true: a terminal took the paste, and false means
        // there was no terminal to take it.
        if (text) term.paste(text);
        return true;
      });
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
        // the shell (mobile/viewport.ts) and forwarded from App.tsx:194. The
        // terminal cannot measure it: an iframe's own visualViewport never saw
        // the keyboard, and a ResizeObserver on this div does not fire for one
        // either, so without this the last rows, the prompt among them, sit
        // behind it.
        //
        // The shrink has to happen HERE rather than on the container:
        // `.tl-views.tl-kb-inline` deliberately leaves the keyboard out of that
        // reservation (app.css:2309-2318), because shrinking the container
        // moved the terminal out from under the tap that had just opened the
        // keyboard and made it flash shut.
        //
        // Half of term.html's `tl-kb` arm (:9407-9422). The page pairs the
        // forwarded height with its OWN visualViewport reading and with the
        // toolbar and compose-bar heights (`syncViewport`, :8427-8469); that
        // port is pass 2. What is here is the part nothing else can do, and it
        // composes: `100%` is already the container minus the toolbar.
        //
        // A non-finite value is ignored rather than trusted into the layout, as
        // the page ignores it (:9418, and the reason in its own words at
        // :9416-9417); false then says nothing took it.
        //
        // A terminal that has handed the bridge over keeps whatever it was last
        // told, because the shell forwards on CHANGE only (mobile/viewport.ts).
        // A framed term.html keeps its `framedKb` the same way, so this is
        // parity rather than a new gap, and the pass-2 port is where a terminal
        // gets to read the keyboard for itself.
        if (!host || !Number.isFinite(px)) return false;
        const reserve = Math.max(0, px);
        // THE HEIGHT WRITE IS GATED TWICE, both gates term.html's, because the
        // shell forwards this height whatever the device is:
        // `installViewportSync` reads `visualViewport ?? null`, falls back to
        // `window.innerHeight`, and still seeds and publishes (viewport.ts:242,
        // :261, :332), so a fine-pointer desktop reaches this bridge too.
        //   1. no `window.visualViewport` and `syncViewport` returns before
        //      writing anything at all (:8428). Read per call, where the page
        //      reads it per call.
        //   2. `terminalEl.style.height` is written only inside
        //      `if (isCoarsePointer)` (:8441). A fine pointer has no soft
        //      keyboard to make room for, and taking rows off a desktop
        //      terminal because the browser moved its visual viewport is a
        //      regression rather than a reservation.
        // The refit is NOT gated: term.html calls `refit()` outside
        // `syncViewport` and after it, unconditionally (:9421). And `true` is
        // still the answer when a gate refuses, because the terminal did take
        // the message; false is reserved for "there was no terminal".
        if (window.visualViewport && coarsePointer) {
          host.style.height = reserve > 0 ? `calc(100% - ${reserve}px)` : "";
        }
        // The grid follows the height, through the same debounce as every other
        // trigger: the keyboard animates over ~250ms and fires a burst, and each
        // fit emits a tmux resize (term.html:8390-8393, and its own refit at
        // :9421).
        refit("fit-wanted");
        return true;
      });

      teardown = () => {
        if (fitTimer !== undefined) clearTimeout(fitTimer);
        viewShown = null;
        ro.disconnect();
        document.removeEventListener("mousedown", onPress, true);
        document.removeEventListener("mousemove", onMotion, true);
        document.removeEventListener("mouseup", onRelease, true);
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

  return <div class="tl-terminal-native" ref={host} />;
};
