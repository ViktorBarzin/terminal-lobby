/**
 * Terminal font size, and the pinch that changes it. PURE — no DOM, no xterm,
 * no timers, no storage. Events and current state go in, decisions come out;
 * the component preventDefaults, applies the size, draws the readout.
 *
 * Lifted from frontend/term.html (the A−/A+ stepper, `applyFontSize`, and the
 * two pinch recognizers) ahead of the native xterm component, which has to
 * answer a pinch exactly the way the iframe does or the gesture changes feel
 * between builds. The rules below are that page's, including the ones that read
 * like accidents — they are load-bearing, and each says why.
 *
 * TWO FRONT-ENDS, because no single event covers both engines, and at most one
 * arms per device:
 *   Chromium — no pinch event exists, so two-finger spans are measured by hand.
 *     Consuming `touchmove` from the FIRST move is the claim. Probe-derived and
 *     deliberately not simplified: on 2026-07-11 both naive models were
 *     falsified on the production surface. Chrome's cancelable-touchmove window
 *     is only ~1-3 moves, so classify-then-claim never lands, and a one-shot
 *     first-move preventDefault does not hold.
 *   WebKit (iOS/iPadOS) — the proprietary GestureEvent IS the pinch signal (a
 *     two-finger pan never fires it, so there is no pan-vs-pinch question to
 *     answer), and `scale` is already the cumulative span ratio.
 *
 * What stays outside this module, because it is not arithmetic: the engine
 * sniff, reading the device flag, `visualViewport.scale`, hit-testing the
 * terminal element, the 220 ms readout fade, the M.8 repaint mask, and the
 * selection haptic. Each of those is a fact the caller supplies or an effect it
 * performs; `isCommittedStep` is here so the haptic fires on the same rule.
 */
import { clampFontSize } from "../store/prefs";

// Re-exported so a component has one import for the whole font contract.
// clampFontSize is the store's own function, reused rather than re-implemented:
// the 6..22 range is validated in three places (this module, the prefs doc, and
// term.html's PREF_VALID) and a second copy of the bounds would eventually
// disagree with the one the server doc is checked against.
export {
  clampFontSize,
  FONT_SIZE_DEFAULT,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
} from "../store/prefs";

/** Chromium: two-finger moves consumed before deciding pinch-or-pan. */
export const PINCH_CLASSIFY_MOVE = 3;

/** |ratio − 1| below this is a two-finger pan, not a pinch. */
export const PINCH_CLASSIFY_RATIO = 0.05;

/** One font step per this much cumulative span ratio. */
export const PINCH_STEP_RATIO = 0.07;

/**
 * A pinch on an already-zoomed page belongs to the browser. Claiming it there
 * takes away the only gesture that zooms back out, so the recognizer stands
 * down above this scale — the standing regression guard, kept as a number
 * rather than an equality because the viewport reports 1 with float noise.
 */
export const PINCH_PAGE_SCALE_MAX = 1.001;

/** How long the size readout lingers after the fingers lift. The timer belongs
 *  to the component; the duration is part of the gesture's contract. */
export const FONT_READOUT_HIDE_MS = 220;

/* -------------------------------------------------------------------------
 * The ladder: A− / A+ / the settings stepper
 * ---------------------------------------------------------------------- */

/** `current` moved `delta` steps, clamped. One press is one pixel of size. */
export function stepFontSize(current: number, delta: number): number {
  return clampFontSize(current + delta);
}

/**
 * Whether a step actually moved the size.
 *
 * The selection haptic and the readout fire per COMMITTED step: holding A− at 6
 * or A+ at 22 buzzes once and then goes quiet, rather than ticking against a
 * wall. Same rule for the pinch, which rides the shared apply path.
 */
export function isCommittedStep(before: number, after: number): boolean {
  return clampFontSize(before) !== clampFontSize(after);
}

/* -------------------------------------------------------------------------
 * Pinch arithmetic
 * ---------------------------------------------------------------------- */

export interface PinchPoint {
  clientX: number;
  clientY: number;
}

export interface PinchTouch extends PinchPoint {
  identifier: number;
}

/**
 * How far apart two fingers are, floored at 1.
 *
 * The floor matters because the opening span is a divisor: two touches reported
 * at the same coordinates would otherwise make every later ratio Infinity, and
 * the first move would slam the size to a bound.
 */
export function pinchSpan(a: PinchPoint, b: PinchPoint): number {
  return Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY));
}

/**
 * The size a gesture has reached, from where it started and how far it spread.
 *
 * Truncation toward zero, not rounding, so the size changes only once the
 * fingers have travelled a full step — rounding would flip the size at half a
 * step and make the gesture feel twitchy. It also leaves the boundaries
 * slightly asymmetric in binary floating point: 1.07 is one step up but 0.93 is
 * none, because (0.93 − 1) / 0.07 is −0.9999999999999992. term.html carries the
 * same expression and the same edge; matching it is the point.
 *
 * Nothing guards a degenerate ratio, and that is the parity: term.html has no
 * such guard either, so ratio 0 is (0 − 1) / 0.07 = −14 steps DOWN into the
 * floor rather than no movement, and a NaN one falls through to clampFontSize's
 * own non-finite branch and comes back as the default 15 rather than `base`.
 * Neither reaches here through a recognizer — pinchSpan floors both spans at 1,
 * and the WebKit front-end normalizes `scale` before it asks — but the
 * primitive is exported, so a guard here would be a divergence in whatever
 * calls it next.
 */
export function sizeForRatio(base: number, ratio: number): number {
  return clampFontSize(base + Math.trunc((ratio - 1) / PINCH_STEP_RATIO));
}

/**
 * True once a span ratio is far enough from 1 to be a deliberate pinch.
 *
 * The exact negation of term.html's `Math.abs(ratio - 1) < PINCH_CLASSIFY_RATIO`
 * and not a `>=` with a finiteness test beside it, because the two disagree on a
 * non-finite ratio and that disagreement flips the gesture: `<` is false for
 * NaN, so the page falls through and CLAIMS, where `Number.isFinite(ratio) &&`
 * answers "not a pinch" and sends the recognizer down the release branch —
 * handing a two-finger gesture to native scrolling instead of stepping the size.
 */
export function isPinch(ratio: number): boolean {
  return !(Math.abs(ratio - 1) < PINCH_CLASSIFY_RATIO);
}

/** The three facts the caller measures before either front-end may claim. */
export interface PinchGates {
  /** The gestures master kill AND the device-local pinch flag (default ON). */
  armed: boolean;
  /** `visualViewport.scale` of the TOP window — the tab zooms, not the frame. */
  pageScale: number;
  /** Every finger of the gesture came down on the terminal surface. */
  onSurface: boolean;
}

/**
 * Written as a negated `>` rather than `<=` on purpose: a viewport that reports
 * NaN (no visualViewport, a cross-origin top) must not disable the gesture, and
 * `NaN <= max` would. term.html reads the same way.
 */
export function canClaimPinch(g: PinchGates): boolean {
  return g.armed && g.onSurface && !(g.pageScale > PINCH_PAGE_SCALE_MAX);
}

/* -------------------------------------------------------------------------
 * The decision both front-ends return
 * ---------------------------------------------------------------------- */

/** A size to show, `"hide"` to fade the readout out, `null` to leave it alone. */
export type FontReadout = number | "hide" | null;

export interface PinchDecision<S> {
  /** State to carry into the next event; null once no gesture is in flight. */
  state: S | null;
  /** preventDefault this event. For touchmove the consumption IS the claim. */
  consume: boolean;
  /** A font size to apply, or null when nothing needs applying. */
  size: number | null;
  readout: FontReadout;
}

function idle<S>(state: S, consume = false): PinchDecision<S> {
  return { state, consume, size: null, readout: null };
}

/** No gesture in flight and nothing to do — the same answer for either state. */
const NOTHING: PinchDecision<never> = {
  state: null,
  consume: false,
  size: null,
  readout: null,
};

/* -------------------------------------------------------------------------
 * Chromium front-end: measure the span, claim by consuming
 * ---------------------------------------------------------------------- */

export interface TouchPinchState {
  /** The two fingers this gesture belongs to; a substitution ends it. */
  ids: readonly [number, number];
  span0: number;
  moves: number;
  claimed: boolean;
  /** Released or aborted. Native owns the rest of this gesture, for good. */
  dead: boolean;
  baseFont: number;
  lastTarget: number | null;
}

export interface TouchPinchStartEvent extends PinchGates {
  touches: readonly PinchTouch[];
  currentSize: number;
}

export interface TouchPinchMoveEvent {
  touches: readonly PinchTouch[];
  /** False once the browser has committed the stream to native scrolling. */
  cancelable: boolean;
  currentSize: number;
}

/**
 * A finger came down. Arms the gesture, or kills one already in flight.
 *
 * The kill comes first, before the two-finger test: a third finger landing
 * mid-pinch aborts and never resumes, so a pinch cannot be finished with a
 * different pair than it started with.
 */
export function touchPinchStart(
  state: TouchPinchState | null,
  e: TouchPinchStartEvent,
): PinchDecision<TouchPinchState> {
  if (state) return idle({ ...state, dead: true });
  const a = e.touches[0];
  const b = e.touches[1];
  if (e.touches.length !== 2 || !a || !b) return NOTHING;
  if (!canClaimPinch(e)) return NOTHING;
  return idle({
    ids: [a.identifier, b.identifier],
    span0: pinchSpan(a, b),
    moves: 0,
    claimed: false,
    dead: false,
    baseFont: e.currentSize,
    lastTarget: null,
  });
}

/**
 * A two-finger move. Consumed from move 1 — that consumption is the claim —
 * with the pinch-or-pan question deferred to move `PINCH_CLASSIFY_MOVE`, by
 * which point Chrome's cancelable window would already have closed on a
 * recognizer that waited to be sure before claiming.
 */
export function touchPinchMove(
  state: TouchPinchState | null,
  e: TouchPinchMoveEvent,
): PinchDecision<TouchPinchState> {
  if (!state) return NOTHING;
  // Released or aborted: hand every remaining move of this gesture to the page.
  if (state.dead) return idle(state);
  const a = e.touches[0];
  const b = e.touches[1];
  if (
    e.touches.length !== 2 ||
    !a ||
    !b ||
    a.identifier !== state.ids[0] ||
    b.identifier !== state.ids[1]
  ) {
    return idle({ ...state, dead: true });
  }
  // Native already owns this stream — a finger joining a scroll already in
  // flight arrives non-cancelable. Never fight it, and never preventDefault a
  // non-cancelable event: it does nothing except earn a console intervention
  // warning. Panic-zooming mid-scroll therefore stays native. That leak is
  // declared, not overlooked.
  if (!e.cancelable) return idle({ ...state, dead: true });

  const moves = state.moves + 1;
  const ratio = pinchSpan(a, b) / state.span0;
  let claimed = state.claimed;
  if (!claimed) {
    if (moves < PINCH_CLASSIFY_MOVE) return idle({ ...state, moves }, true);
    if (!isPinch(ratio)) {
      // Span held constant across three consumed moves: a two-finger pan.
      // Release it — native resumes, having lost the ~7.5px of centroid travel
      // that the classification cost. This move was consumed; no later one is.
      return idle({ ...state, moves, dead: true }, true);
    }
    claimed = true;
  }

  const target = sizeForRatio(state.baseFont, ratio);
  if (target === state.lastTarget) return idle({ ...state, moves, claimed }, true);
  return {
    state: { ...state, moves, claimed, lastTarget: target },
    consume: true,
    // A target equal to the live size needs no apply. Re-applying it would run
    // the whole metric swap — a refit and a repaint-mask flash — for no change.
    size: target === e.currentSize ? null : target,
    readout: target,
  };
}

/**
 * A finger lifted, or the touch stream was cancelled. The gesture survives while
 * two remain, so a third finger lifting leaves an aborted pinch aborted rather
 * than reviving it.
 *
 * touchcancel comes HERE, not to pinchReset: term.html registers one handler for
 * touchend and touchcancel alike and it calls the recognizer's end(). So a
 * cancel that leaves two fingers down fails the `< 2` test and the gesture keeps
 * running — a later move still steps the size.
 */
export function touchPinchEnd(
  state: TouchPinchState | null,
  e: { touches: readonly unknown[] },
): PinchDecision<TouchPinchState> {
  if (!state) return NOTHING;
  if (e.touches.length >= 2) return idle(state);
  return { state: null, consume: false, size: null, readout: "hide" };
}

/**
 * Teardown: pagehide, or the component dropping the recognizer.
 *
 * Not touchcancel — wire that to touchPinchEnd. term.html reaches its
 * recognizer's reset() only through resetAll(), and resetAll() is registered on
 * pagehide alone; touchcancel shares the touchend handler, which calls end().
 * The two answers differ on a cancel that leaves two fingers down: end() keeps
 * the gesture (its `touches.length < 2` test fails), while this drops the state
 * and fades the readout out from under a pinch still in progress.
 */
export function pinchReset<S>(): PinchDecision<S> {
  return { state: null, consume: false, size: null, readout: "hide" };
}

/* -------------------------------------------------------------------------
 * WebKit front-end: GestureEvent carries the ratio
 * ---------------------------------------------------------------------- */

export interface GesturePinchState {
  baseFont: number;
  lastTarget: number | null;
  /** Stepping stopped for the rest of this gesture. Never unset mid-gesture. */
  frozen: boolean;
}

export interface GesturePinchChangeEvent {
  /** WebKit's cumulative span ratio, 1.0 at gesturestart. */
  scale: number;
  /** Fingers down, counted from passive touch listeners — GestureEvent
   *  exposes a scale but not a touch count, and the third-finger rule needs it. */
  fingers: number;
  currentSize: number;
}

/**
 * The claim is the preventDefault the caller makes on this event: it suppresses
 * native pinch-zoom for the whole gesture. There is nothing to classify — a
 * two-finger pan never fires a GestureEvent.
 */
export function gesturePinchStart(
  e: PinchGates & { currentSize: number },
): PinchDecision<GesturePinchState> {
  if (!canClaimPinch(e)) return NOTHING;
  return idle({ baseFont: e.currentSize, lastTarget: null, frozen: false }, true);
}

/**
 * Steps the size from the cumulative scale, while holding the claim.
 *
 * Two rules that look alike and are not. A claimed WebKit gesture cannot be
 * released mid-flight without the page popping into native zoom, so a third
 * finger FREEZES stepping through gestureend rather than half-releasing the way
 * Chromium does. And the 5% deadzone applies only until the first step lands:
 * after that, the size follows the scale back through the deadzone, so a pinch
 * out and back returns to where it started instead of sticking.
 */
export function gesturePinchChange(
  state: GesturePinchState | null,
  e: GesturePinchChangeEvent,
): PinchDecision<GesturePinchState> {
  if (!state) return NOTHING;
  if (state.frozen || e.fingers > 2) return idle({ ...state, frozen: true }, true);
  const ratio = e.scale > 0 ? e.scale : 1;
  if (state.lastTarget === null && !isPinch(ratio)) return idle(state, true);
  const target = sizeForRatio(state.baseFont, ratio);
  if (target === state.lastTarget) return idle(state, true);
  return {
    state: { ...state, lastTarget: target },
    consume: true,
    size: target === e.currentSize ? null : target,
    readout: target,
  };
}

export function gesturePinchEnd(
  state: GesturePinchState | null,
): PinchDecision<GesturePinchState> {
  if (!state) return NOTHING;
  return { state: null, consume: true, size: null, readout: "hide" };
}
