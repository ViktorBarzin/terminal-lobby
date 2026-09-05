/**
 * Plain-drag selection: how a mouse still selects text inside a pane that is
 * reporting mouse events (frontend/term.html:5921-6055).
 *
 * WHY IT NEEDS RECLAIMING. tmux, and Claude Code inside it, keep the terminal
 * in mouse-report mode. xterm then treats a plain left drag as something to
 * report to the pty rather than something to select with, and selects only when
 * its own `SelectionService.shouldForceSelection` says so, which reads
 * `isMac ? e.altKey && macOptionClickForcesSelection : e.shiftKey`. So the
 * moment a component wires `term.onBinary`, which is what turns mouse reporting
 * on at all, mouse text selection stops working in every tracking pane.
 * term.html:5818-5828 bought it back, and this is that port.
 *
 * HOW. Every trusted, plain, left-button mousedown over `.xterm-screen` is
 * intercepted at document capture, swallowed, and re-dispatched as a clone
 * carrying the modifier that predicate wants: Option on a Mac, Shift everywhere
 * else (:5950). xterm's SelectionService then owns the whole gesture, drag
 * growth, double-click words and persistence included, while "wheel /
 * right-click / modifier chords still reach the app" (:5824-5825). The clone is
 * an UNTRUSTED event on the same node, so passing untrusted presses through is
 * not a nicety: intercept one and it clones itself forever.
 *
 * TWO OPTIONS THIS RESTS ON, both passed to the constructor in pass 1
 * (the `new Terminal({...})` call in TerminalNative.tsx; the line numbers this
 * used to carry pointed at `report` after the file moved under them):
 *   - `macOptionClickForcesSelection: true`, because it is the second half of
 *     that predicate on a Mac and xterm defaults it to false. Without it every
 *     Mac clone is just another reported click and this module does nothing but
 *     swallow. Off a Mac the predicate is `e.shiftKey` alone, so no option is
 *     needed there.
 *   - `altClickMovesCursor: false`, xterm's default being true. Its mouse-up
 *     path runs `moveToCellSequence` when `selectionText.length <= 1 &&
 *     elapsed < 500 && e.altKey && altClickMovesCursor`, which writes arrow
 *     keys to the app. Every Mac clone carries altKey, so a clone click that
 *     selects nothing would move the prompt cursor instead.
 * Both live in `ITerminalOptions` and xterm reads them off `rawOptions` at
 * click time, so they are settable after construction as well
 * (`ITerminalInitOnlyOptions` holds only `cols` and `rows`). Constructing with
 * them is simply where TerminalNative does it.
 *
 * Everything here is pure: pointer facts and a reading of the world go in, a
 * list of actions comes out. Nothing reads a clock, an element or xterm, which
 * is what lets these rules be tested at all. term.html's version could not be,
 * because it lives in document listeners closing over two mutable page
 * variables, `cloneDrag` (:5920) and `lastHijackUp` (:5903).
 *
 * WHAT THE COMPONENT STILL OWES. The module decides and the component performs,
 * so an action missing from this list is behaviour nobody performs.
 *
 * First, the listeners. THREE permanent `document` listeners, all at CAPTURE,
 * for `mousedown`, `mousemove` and `mouseup`, each feeding every event straight
 * into `reduce`. Permanent is the point: term.html adds and removes a pair of
 * closures per gesture (:6001-6002, :6033-6034, :5953-5956), and this module
 * holds that gesture in `pending`/`drag` instead, so nothing needs arming.
 * Register them once per mounted terminal, remove them on cleanup, and keep the
 * state per terminal. SEVERAL are mounted at once: the lobby keeps every
 * visited session mounted and CSS-hides the rest (App.tsx:835-842,
 * store/keepalive.ts), so each `mousedown` reaches every instance's listener.
 * `insideScreen` is what settles who acts on it, so each instance must test the
 * `.xterm-screen` inside ITS OWN host, never a bare `document.querySelector`
 * (which is what term.html:5961 can afford, being one terminal per document).
 * A document query would have every mounted terminal swallow and clone the same
 * press.
 *
 * Then, per action:
 *   swallow-press       `e.stopImmediatePropagation()` AND `e.preventDefault()`
 *                       on the mousedown, both, as the page calls them at one
 *                       site (:5966-5967). The listener has to be on `document`
 *                       at CAPTURE: xterm's own handler is on the screen
 *                       element, a descendant, so only a capture-phase document
 *                       listener runs before it and only stopping propagation
 *                       there keeps the press away from it. Do not pass
 *                       `passive: true`, which would make the preventDefault a
 *                       no-op; mousedown is not passive by default, so this only
 *                       matters if the component passes the option.
 *   swallow-motion      `m.stopImmediatePropagation()` only, no preventDefault
 *                       (:6053). Same document-capture listener as every other
 *                       motion.
 *   force-selection     dispatch `new MouseEvent('mousedown', {...clone, view:
 *                       window})` on the ORIGINAL press target (:5952), and
 *                       REMEMBER that target: `finalize-drag` needs it. The
 *                       clone object carries every other init field already.
 *   finalize-drag       dispatch `new MouseEvent('mouseup', { bubbles: true,
 *                       cancelable: true, composed: true, view: window, clientX,
 *                       clientY, button: 0, buttons: 0 })` at the action's `at`,
 *                       on the remembered clone target, falling back to the
 *                       `.xterm-screen` element and doing nothing at all when
 *                       there is neither (:5921-5930). That synthetic mouseup
 *                       bubbles to document and re-enters the component's own
 *                       mouseup listener; harmless, because `reduce` has already
 *                       cleared the drag, and term.html's own once-listener sees
 *                       it the same way.
 *   clear-selection     `term.clearSelection()`, plus the same bookkeeping
 *                       term.html's `clearSelectionBecause` does (:5892-5902):
 *                       hand `reason` to the log and feed selection.ts's
 *                       `reduceStash` a `{ type: "dismissed", hasSelection:
 *                       term.hasSelection() }` event. Do NOT re-implement the
 *                       stash rules here; that guard is why a dismissal with no
 *                       highlight leaves a pending copy alive.
 *   focus               term.html's `tapFocus()` (:5815): `term.focus()`, or the
 *                       compose field when the mobile input bar is visible and
 *                       `input.tapFocus === 'field'` (reassigned at :7459-7460).
 *                       Both halves are wired as TerminalNative's `tapFocus`,
 *                       and touchscroll.ts's `focus` action is the same call:
 *                       a tap on a phone produces both, which term.html names
 *                       and calls harmless, being two `.focus()` calls on one
 *                       element.
 *   replay-status-click send each string, in order, through the SAME path a
 *                       keystroke takes: `attach.sendInput`, which is what
 *                       term.html uses (:5994-5995). Not the binary path. That
 *                       choice carries the read-only guard, so a watcher's
 *                       status-row click is refused and explained rather than
 *                       written into a session they cannot type to.
 *
 * WHAT THE COMPONENT MUST READ, and when. Every field of `DragSelectWorld` is
 * read FRESH at the moment of the event, because that is when term.html reads
 * it. The one thing deliberately NOT re-read is the screen box behind a
 * status-row release: `reduce` keeps the box measured at the press, since
 * term.html captures `rect` in the mousedown (:5963) and the release reads that
 * capture (:5991-5993).
 *   insideScreen   `scr.contains(e.target)`, with term.html's `e.target
 *                  instanceof Node` test in front of it (:5962).
 *   screen         `scr.getBoundingClientRect()`. `null` when there is no
 *                  `.xterm-screen` at all, which is term.html's `!scr` arm.
 *   hasSelection   `term.hasSelection()`.
 *   rows, cols     `term.rows`, `term.cols`.
 *   mouseTracking  `term.modes.mouseTrackingMode`.
 *   isMac          term.html's test is an include list over
 *                  `navigator.platform` (:5817); `keybindings/engine.ts:83-92`
 *                  already has a `detectMac()` that tries
 *                  `userAgentData.platform` first and matches /mac/i.
 *   now            term.html reads `Date.now()` at all five of these points
 *                  (:5929, :5933, :5951, :5955, :6006). This module only ever
 *                  subtracts one reading from another, so any clock does, as
 *                  long as it is the same one every time.
 *
 * WHERE THIS IS NOT term.html LINE FOR LINE. term.html arms a fresh pair of
 * closures for each press it holds back, either kind, and removes them on
 * travel or on any document-capture mouseup. If a mouseup never reaches the
 * document, that pair stays armed and the next press arms a second one
 * alongside it. This module holds ONE pending press, so a new trusted press
 * replaces a stale one.
 *
 * OUT OF SCOPE, on purpose. What copy does with a selection, the stash and the
 * chords are selection.ts, and the wheel-pixel accumulation and Escape that
 * dismiss a selection live with the key handler. The touch path is a different
 * range of the page (:6056 onward) and is not ported here.
 */

/**
 * How long after a hijacked drag lifts a press is still treated as trackpad
 * noise, and how far from the lift point it may land.
 *
 * macOS trackpads emit spurious trusted mousedown/up pairs after a drag lift,
 * sometimes deferred until the finger next touches to MOVE the pointer
 * (term.html:5832-5835). Any click-clears rule eventually eats a fresh
 * selection because of them, so a press inside this window keeps the selection
 * instead.
 */
export const GHOST_MS = 400;
export const GHOST_PX = 8;

/**
 * How far a press must travel before it counts as a replacing drag.
 *
 * Deliberately larger than trackpad jitter (term.html:5842-5844): macOS
 * tap-drag continuations and micro-slips move a few pixels, while an
 * intentional replacing drag travels. The test is per-axis rather than
 * euclidean, so either axis on its own commits the drag.
 */
export const REPLACE_PX = 10;

/**
 * How long a clone drag may sit stationary on a Mac before the next motion is
 * read as drag-lock resuming rather than the selection growing.
 *
 * macOS three-finger-drag and tap-drag-lock do not release the button when the
 * fingers lift: the OS keeps the drag alive and the user's next pointer move
 * continues it, silently dragging the selection away (term.html:5910-5918).
 */
export const STALL_MS = 500;

/** The `.xterm-screen` box, in CSS pixels, as `getBoundingClientRect` reports it. */
export interface ScreenBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** `term.modes.mouseTrackingMode`, xterm's own union. */
export type MouseTracking = "none" | "x10" | "vt200" | "drag" | "any";

/** A mousedown, narrowed to the fields the interceptor reads. */
export interface PressEvent {
  /** False for our own clone, and for anything else script-made. */
  readonly isTrusted: boolean;
  /** 0 is the left button. Nothing else is intercepted. */
  readonly button: number;
  /** The click count. 2 and up is an explicit new-selection gesture, and xterm reads it off the clone to pick a word or a line. */
  readonly detail: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly screenX: number;
  readonly screenY: number;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

/** A mousemove, narrowed the same way. */
export interface MoveEvent {
  readonly isTrusted: boolean;
  /** The button bitmask. Only bit 0, the left button, is ever read. */
  readonly buttons: number;
  readonly clientX: number;
  readonly clientY: number;
}

/** A mouseup. Only where it landed matters. */
export interface ReleaseEvent {
  readonly clientX: number;
  readonly clientY: number;
}

export type DragSelectEvent =
  | { readonly type: "press"; readonly press: PressEvent }
  | { readonly type: "motion"; readonly motion: MoveEvent }
  | { readonly type: "release"; readonly release: ReleaseEvent };

/** What the component read from the DOM, xterm and its clock for this event. */
export interface DragSelectWorld {
  readonly now: number;
  readonly isMac: boolean;
  readonly insideScreen: boolean;
  readonly hasSelection: boolean;
  readonly screen: ScreenBox | null;
  readonly rows: number;
  readonly cols: number;
  readonly mouseTracking: MouseTracking;
}

/**
 * A clone drag in flight: xterm is mid-selection because of a clone we
 * dispatched, and has not seen a mouseup yet.
 *
 * term.html's `cloneDrag`, minus the target, which stays with the component.
 * `clientX`/`clientY` track the last point the drag reached and `at` is when it
 * last moved, so the healing rules can finalize at the right place.
 */
export interface CloneDrag {
  readonly clientX: number;
  readonly clientY: number;
  readonly at: number;
}

/** Where and when a hijacked drag last let go. term.html's `lastHijackUp`. */
export interface HijackRelease {
  readonly at: number;
  readonly clientX: number;
  readonly clientY: number;
}

/**
 * A press that was swallowed and is being held back until it proves itself.
 *
 * Two kinds, because their releases differ. A `status-row` press replays the
 * click to the app; a `held-back` press keeps the selection that was already up.
 * Both resolve into a clone the moment they travel.
 */
export interface PendingPress {
  readonly kind: "status-row" | "held-back";
  /** The press itself: both resolutions build the clone from the ORIGINAL press (:5980, :6026), and the status-row replay measures from it (:5991-5993). */
  readonly press: PressEvent;
  /** The screen box as measured at the press, which is the one the status-row replay reads. */
  readonly screen: ScreenBox;
}

export interface DragSelectState {
  readonly drag: CloneDrag | null;
  readonly lastRelease: HijackRelease | null;
  readonly pending: PendingPress | null;
}

/** No drag in flight, no press held back, no lift to be suspicious of. */
export const NO_GESTURE: DragSelectState = { drag: null, lastRelease: null, pending: null };

/**
 * The `MouseEvent` init for the clone, bar `view: window`, which the component
 * adds because a pure module has no window.
 *
 * `buttons: 1` says the left button is down, which is what makes xterm treat
 * the clone as the start of a drag rather than a stray press.
 *
 * Exactly one of `altKey`/`shiftKey` is ever true, and the two are not
 * interchangeable. `shouldForceSelection` is
 * `isMac ? e.altKey && macOptionClickForcesSelection : e.shiftKey`. A Mac clone
 * carrying Shift therefore forces nothing, and the press is swallowed for no
 * selection at all. Off a Mac an Alt clone forces nothing either, and it also
 * matches xterm's `shouldColumnSelect` (`e.altKey` and not the Mac case), so
 * the drag would come out as a column block.
 */
export interface SelectionClone {
  readonly bubbles: true;
  readonly cancelable: true;
  readonly composed: true;
  readonly detail: number;
  readonly screenX: number;
  readonly screenY: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly button: 0;
  readonly buttons: 1;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

export type DragSelectAction =
  /** Keep the real press off xterm: stopImmediatePropagation and preventDefault. */
  | { readonly kind: "swallow-press" }
  /** Keep idle motion off xterm so a mode-1003 pane does not repaint the selection away. */
  | { readonly kind: "swallow-motion" }
  /** Dispatch the clone. This is the whole mechanism. */
  | { readonly kind: "force-selection"; readonly clone: SelectionClone }
  /** End a drag whose real mouseup never arrived, at the last point it reached. */
  | {
      readonly kind: "finalize-drag";
      readonly at: { readonly clientX: number; readonly clientY: number };
      readonly cause: "lost-mouseup" | "drag-lock-resume";
    }
  /** A deliberate dismissal, with the reason term.html records for it. */
  | { readonly kind: "clear-selection"; readonly reason: string }
  /** Take the focus the swallowed press would have taken. */
  | { readonly kind: "focus" }
  /** Replay a tmux status-row click to the app as SGR bytes, press then release. */
  | { readonly kind: "replay-status-click"; readonly sends: readonly string[] };

export interface DragSelectReduction {
  /** Identical to the state passed in whenever nothing moved, so a caller can compare by identity. */
  readonly state: DragSelectState;
  /** In the order the component must perform them. Empty when there is nothing to do. */
  readonly actions: readonly DragSelectAction[];
}

const NOTHING: readonly DragSelectAction[] = [];

/** The whole interceptor. Nothing here touches the DOM, xterm or a clock. */
export function reduce(
  state: DragSelectState,
  event: DragSelectEvent,
  world: DragSelectWorld,
): DragSelectReduction {
  switch (event.type) {
    case "press":
      return onPress(state, event.press, world);
    case "motion":
      return onMotion(state, event.motion, world);
    case "release":
      return onRelease(state, event.release, world);
    default: {
      const unhandled: never = event;
      void unhandled;
      return { state, actions: NOTHING };
    }
  }
}

function onPress(
  state: DragSelectState,
  e: PressEvent,
  world: DragSelectWorld,
): DragSelectReduction {
  // The pass-through set, in term.html's order (:5959-5962). The isTrusted test
  // is the recursion guard: the clone this module asks for is an untrusted
  // mousedown on the same node. A modified press is left alone by design
  // (:5824-5825), and a press outside the screen was never ours.
  if (!e.isTrusted || e.button !== 0) return { state, actions: NOTHING };
  if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return { state, actions: NOTHING };
  if (!world.insideScreen || world.screen === null) return { state, actions: NOTHING };

  const screen = world.screen;
  // Swallowed before anything else is decided (:5966-5967), including before the
  // ghost test, so every branch below is already invisible to xterm.
  const actions: DragSelectAction[] = [{ kind: "swallow-press" }];

  if (onStatusRow(e.clientY, screen, world.rows)) {
    // The bottom row is the tmux status line, but it is ALSO where a drag starts
    // when selecting the last lines of output upward, because the Claude input
    // box lives at the bottom. Disambiguate by travel (:5969-5973), and take no
    // focus: the click is about to be replayed and tmux moves focus itself.
    return { state: { ...state, pending: { kind: "status-row", press: e, screen } }, actions };
  }

  if (isGhost(state.lastRelease, e, world.now) && world.hasSelection) {
    // A lift ghost. Swallowed and otherwise ignored, so the selection survives
    // (:6009). Holding it back instead would be worse than letting it through:
    // the ghost's own travel would then replace the selection.
    return { state, actions };
  }

  if (!world.hasSelection || e.detail > 1) {
    // Nothing to protect, or an explicit new-selection gesture. Straight through
    // (:6010-6014). The clear rides `detail > 1` alone, with no test for a
    // highlight: term.html's `clearSelectionBecause` has that guard itself
    // (:5893), and the dismissal reaching selection.ts with nothing selected is
    // exactly what keeps a pending copy alive there. Adding the test here would
    // move that guard.
    if (e.detail > 1) actions.push({ kind: "clear-selection", reason: "double-click replace" });
    actions.push({ kind: "force-selection", clone: cloneOf(e, world.isMac) });
    actions.push({ kind: "focus" });
    return { state: { ...state, pending: null, drag: dragFrom(e, world.now) }, actions };
  }

  // A selection is up and this is a single press: hold it back until it proves
  // to be a drag (:6016-6017). A release without travel keeps the selection.
  // tapFocus still runs, because the press that would have focused xterm was
  // swallowed (:6035).
  actions.push({ kind: "focus" });
  return { state: { ...state, pending: { kind: "held-back", press: e, screen } }, actions };
}

function onMotion(
  state: DragSelectState,
  m: MoveEvent,
  world: DragSelectWorld,
): DragSelectReduction {
  const actions: DragSelectAction[] = [];
  let next = state;

  // 1. Heal a drag whose mouseup never arrived (:5931-5943). This listener is
  // registered before the swallow in term.html, and neither stops the other, so
  // both can act on one motion event.
  if (m.isTrusted && next.drag !== null) {
    const drag = next.drag;
    const cause = healCause(drag, m, world);
    if (cause !== null) {
      const at = { clientX: drag.clientX, clientY: drag.clientY };
      actions.push({ kind: "finalize-drag", at, cause });
      // finalizeCloneDrag arms the ghost window from the point it finalized at,
      // not from wherever the pointer had wandered to (:5929).
      next = { ...next, drag: null, lastRelease: { at: world.now, ...at } };
    } else {
      next = { ...next, drag: { clientX: m.clientX, clientY: m.clientY, at: world.now } };
    }
  }

  // 2. The mode-1003 motion swallow (:6048-6053), read against the state the
  // healing above just left. That ordering is term.html's: the swallow's own
  // `cloneDrag` test sees the null a finalize wrote on this same event.
  if (
    m.isTrusted &&
    (m.buttons & 1) === 0 &&
    world.hasSelection &&
    next.drag === null &&
    world.insideScreen
  ) {
    actions.push({ kind: "swallow-motion" });
    // stopImmediatePropagation ends the event for every later listener on
    // document, and a pending press's move listener is added inside the
    // mousedown, so it is always later than this one. The travel check below
    // therefore does not run. Reachable: a held-back press whose mouseup went
    // missing leaves buttons at 0 with the selection still up.
    return { state: next, actions };
  }

  // 3. A pending press of either kind proving itself a drag (:5975-5981,
  // :6019-6027). term.html's per-gesture move listeners test neither isTrusted
  // nor buttons, so neither does this.
  const pending = next.pending;
  if (pending !== null) {
    const dx = Math.abs(m.clientX - pending.press.clientX);
    const dy = Math.abs(m.clientY - pending.press.clientY);
    if (dx < REPLACE_PX && dy < REPLACE_PX) return { state: next, actions };
    if (pending.kind === "status-row") {
      // `if (term.hasSelection())` (:5979): the reason is only recorded when
      // there is a highlight to clear.
      if (world.hasSelection) {
        actions.push({ kind: "clear-selection", reason: "replacing drag (bottom row)" });
      }
    } else {
      // Unconditional here (:6023), and the px suffix rides the second number.
      actions.push({ kind: "clear-selection", reason: `replacing drag (${dx},${dy}px)` });
    }
    actions.push({ kind: "force-selection", clone: cloneOf(pending.press, world.isMac) });
    next = { ...next, pending: null, drag: dragFrom(pending.press, world.now) };
  }

  return { state: next, actions };
}

function onRelease(
  state: DragSelectState,
  up: ReleaseEvent,
  world: DragSelectWorld,
): DragSelectReduction {
  const actions: DragSelectAction[] = [];
  let next = state;

  // The clone's own mouseup listener (:5953-5956). `lastHijackUp` is written by
  // this and by a finalize, and by nothing else, so an ordinary release we never
  // hijacked must not arm the ghost window.
  if (next.drag !== null) {
    next = { ...next, drag: null, lastRelease: { at: world.now, ...pointOf(up) } };
  }

  const pending = next.pending;
  if (pending !== null) {
    next = { ...next, pending: null };
    // The status-row click, replayed as raw SGR rather than a re-entrant DOM
    // dispatch (:5984-5995), and only to an app that asked for mouse reports:
    // sent to a shell the bytes would land as typed garbage, and a status line
    // click needs tmux mouse mode anyway.
    if (pending.kind === "status-row" && world.mouseTracking !== "none") {
      actions.push({ kind: "replay-status-click", sends: statusClickReports(pending, world) });
    }
  }

  return { state: next, actions };
}

/**
 * Is this press on the tmux status line?
 *
 * term.html:5964-5965 verbatim: the threshold is the top of the last grid row,
 * divided out of the box height rather than read from a cell. `rows > 1` is
 * load-bearing. A one-row terminal has no status line to protect, and treating
 * its only row as one would make the whole screen unselectable.
 */
function onStatusRow(clientY: number, screen: ScreenBox, rows: number): boolean {
  return rows > 1 && clientY - screen.top >= (screen.height * (rows - 1)) / rows;
}

/** term.html:6005-6008. Inclusive on the pixels, exclusive on the window. */
function isGhost(last: HijackRelease | null, e: PressEvent, now: number): boolean {
  return (
    last !== null &&
    now - last.at < GHOST_MS &&
    Math.abs(e.clientX - last.clientX) <= GHOST_PX &&
    Math.abs(e.clientY - last.clientY) <= GHOST_PX
  );
}

/**
 * Why this motion should end the drag, or null to keep dragging.
 *
 * Case (a), the button coming up unseen, applies everywhere. term.html names
 * two sources (:5906-5909): a release past the window edge, and a release over
 * the lobby sidebar while the page runs in the lobby iframe. Only the first
 * survives the port, since a native terminal shares the lobby's document
 * (ADR-0017) and a release over the sidebar reaches these listeners. Case (b),
 * a stall then travel, is gated on Macs (:5938) because three-finger-drag is a
 * macOS trackpad feature; a mouse resting mid-drag anywhere else is just a hand
 * holding still.
 */
function healCause(
  drag: CloneDrag,
  m: MoveEvent,
  world: DragSelectWorld,
): "lost-mouseup" | "drag-lock-resume" | null {
  if ((m.buttons & 1) === 0) return "lost-mouseup";
  if (world.isMac && world.now - drag.at >= STALL_MS) return "drag-lock-resume";
  return null;
}

/** term.html:5945-5950. Exactly one modifier, and it is what xterm force-selects on. */
function cloneOf(e: PressEvent, isMac: boolean): SelectionClone {
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    detail: e.detail,
    screenX: e.screenX,
    screenY: e.screenY,
    clientX: e.clientX,
    clientY: e.clientY,
    button: 0,
    buttons: 1,
    altKey: isMac,
    shiftKey: !isMac,
  };
}

/** A clone drag begins at the press it was built from, never at the travel that triggered it (:5951). */
function dragFrom(e: PressEvent, now: number): CloneDrag {
  return { clientX: e.clientX, clientY: e.clientY, at: now };
}

function pointOf(p: ReleaseEvent): { clientX: number; clientY: number } {
  return { clientX: p.clientX, clientY: p.clientY };
}

/**
 * The two SGR reports a replayed status-row click sends, press then release
 * (term.html:5990-5995).
 *
 * 1-based cell coordinates, clamped into the grid so a press on the last
 * sub-pixel cannot report a column past the last one. Measured from the PRESS
 * and against the box as it was at the press: a trackpad release drifts a pixel
 * or two, and a status click that reported the drift would land on the
 * neighbouring window tab.
 */
function statusClickReports(pending: PendingPress, world: DragSelectWorld): readonly string[] {
  const box = pending.screen;
  const col = Math.min(
    world.cols,
    Math.max(1, Math.floor((pending.press.clientX - box.left) / (box.width / world.cols)) + 1),
  );
  const row = Math.min(
    world.rows,
    Math.max(1, Math.floor((pending.press.clientY - box.top) / (box.height / world.rows)) + 1),
  );
  return [`\x1b[<0;${col};${row}M`, `\x1b[<0;${col};${row}m`];
}
