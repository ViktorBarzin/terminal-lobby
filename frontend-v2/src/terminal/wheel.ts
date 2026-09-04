/**
 * The desktop smooth-wheel interceptor: a trackpad's pixel-delta stream
 * de-damped into paced, discrete one-row line wheels
 * (frontend/term.html:6172-6274, the pref that detaches it at :6264-6274).
 *
 * WHY A WHEEL CANNOT JUST BE FORWARDED. A modern trackpad emits a
 * high-frequency stream of small pixel deltas, and term.html measured what
 * xterm 6 does with them (:6173-6180): `consumeWheelEvent` damps a sub-50px
 * PIXEL wheel to x0.3, and in mouse-tracking mode xterm forwards at most one
 * report per DOM wheel event with the magnitude discarded, so tmux receives a
 * sparse trickle and copy-mode jumps five whole lines per surviving report. A
 * `deltaMode: 1` wheel of deltaY +/-1 is undamped and one row exact, and k
 * separate dispatches inside a frame yield k app reports (measured 10/10,
 * :6066-6068). So the fix is to capture the FULL pixel travel and re-emit it as
 * a proportional number of one-row LINE wheels, a frame at a time.
 *
 * WHY A FRAME AND NOT A SYNCHRONOUS RE-EMIT (:6181-6185). Pacing caps the rows
 * per frame, so a coalesced delta or a mouse notch cannot spray a jump; it
 * smooths the macOS inertia tail; and it defers the synthetic dispatch out of
 * the wheel event being handled, so nothing re-enters. There is deliberately NO
 * JS momentum here (:6244-6247): the coast is the OS inertia tail arriving as
 * more trusted wheels, and a JS coast on top would fight it.
 *
 * WHAT THIS FILE IS. The accumulator and the pacing decision: how much travel
 * is owed, how many rows to emit now, whether another frame is wanted, and what
 * to answer xterm. It touches no DOM, no xterm, no clock and no frame, which is
 * what lets the rules be tested at all. term.html's version could not be: it is
 * two page-level variables (`wheelAccumPx`, `wheelRAF`, :6201-6202) closed over
 * by a handler xterm calls and a callback the platform calls.
 *
 * WHICH INPUT EACH SCROLLER OWNS, AND HOW A COMPONENT KEEPS THEM APART. There
 * are two scrollers and one shared emission primitive between them, so this is
 * worth stating exactly.
 *
 * This module owns TRUSTED `wheel` events, and reaches them through xterm's own
 * `attachCustomWheelEventHandler` (:6188-6192) rather than a DOM listener of its
 * own. The touch scroll port (`touchscroll.ts`, term.html:6056 onward) owns
 * `touchstart`, `touchmove` and `touchend` on the terminal host plus the
 * momentum frames that follow a lift. It converts FINGER px; this one converts
 * WHEEL px. Two things keep them off one gesture:
 *   1. Different event types, which is the whole separation on a device with
 *      one input kind. A trackpad produces `wheel` and no `touch*`, and a
 *      finger produces `touch*`. Whether a finger ALSO produces a `wheel` is
 *      the paragraph below, and it is the part nobody here has measured.
 *   2. The `!isTrusted` gate (:6229-6232), which covers the crossing the two
 *      ports DO make. BOTH dispatch synthetic LINE wheels on the terminal
 *      element, so the touch path's emissions arrive at this handler. Passing
 *      them through is what stops them being converted back to px and re-paced,
 *      which would be a double conversion and an unbounded loop.
 * A third thing looks like a separation and is not. The two accumulators and
 * two frame handles, never shared (`wheelAccumPx` and `wheelRAF` here,
 * :6201-6202; `scrollAccumPx` and `momentumRAF` there, :6084-6085), keep the
 * two from corrupting each other's arithmetic. They do not stop both scrollers
 * acting on one gesture. A component wiring both keeps two pieces of state, per
 * terminal.
 *
 * WHERE THE SEPARATION RUNS OUT, on a device that has both input kinds.
 * Nothing in either port stops a browser deriving `wheel` events from a finger
 * pan. term.html's three touch listeners are all `{ passive: true }` (:6491,
 * :6502 and :6526, closing at :6501, :6525 and :6555) and no `preventDefault`
 * exists anywhere in that path, so a derived wheel would arrive TRUSTED, clear
 * gate 2 above, and feed this accumulator while `feedScroll` (:6117-6128) was
 * already emitting line wheels for the same finger. The passivity is deliberate
 * and measured: a standing non-passive touch listener taxes the latency of every
 * one-finger scroll (:6382-6388, probe leg H), which is why the multi-touch
 * registry's non-passive touchmove is attached only once a second finger has
 * landed. So neither module should quietly make a listener blocking to close
 * this. Whether any browser we ship to derives those wheels is unmeasured, in
 * term.html and here; term.html carries the same exposure and this port does not
 * widen it. Closing it needs a deliberate crossing between the two ports, in the
 * direction the existing one already runs, along the lines of the touch path
 * suppressing this accumulator while a finger is down. Neither module can decide
 * that alone.
 *
 * What does NOT separate them either is the pointer type. term.html's heading
 * says "fine pointers", but `wheelSmoothOn()` (:6203-6205) reads the gestures
 * master kill and the pref and queries no pointer. A `(pointer: fine)` gate on
 * the attach would not help either: `pointer` reports the PRIMARY pointing
 * device (Media Queries 4), which on a touchscreen laptop is the trackpad, so it
 * matches there and the interceptor stays attached. And a wheel event carries no
 * pointer type to test per event, so there is nothing to gate on once it
 * arrives.
 *
 * And the one crossing that IS wired, though not from here: a trusted wheel
 * hard-cancels a touch coast (:6279-6281), so a trackpad scroll during momentum
 * stops the coast rather than fighting it. That lives in a second `wheel`
 * listener at :6278, past the end of this range, registered on the terminal HOST
 * ELEMENT (`document.getElementById('terminal')`, `{ passive: true, capture:
 * true }`) rather than on the document, so it sees only wheels over the
 * terminal. `touchscroll.ts` takes it as an `interrupt` event. Nothing here
 * cancels the touch coast, and nothing here should.
 *
 * WHAT THE COMPONENT STILL OWES, per action. The module decides and the
 * component performs, so an action missing from this list is behaviour nobody
 * performs.
 *   emit           Dispatch `count` SEPARATE one-row wheels on the terminal
 *                  element, each `new WheelEvent('wheel', { deltaY: sign,
 *                  deltaMode: 1, bubbles: true, cancelable: true, clientX: 0,
 *                  clientY })`. That is term.html's `emitLineWheel`
 *                  (:6105-6113), the SAME primitive the touch scroller calls,
 *                  so wire one and share it. Separate dispatches are the whole
 *                  point: one event carrying `deltaY: count` is one app report,
 *                  which is the cap this module exists to beat. Their `clientY`
 *                  comes from the touch path's last emit point
 *                  (`scrollLastEmitY`, :6087, :6111), which starts at 100 and
 *                  is NOT the wheel's own clientY. This port keeps that,
 *                  because the mouse report's cell is derived from the
 *                  coordinate: switching to the wheel's own clientY would
 *                  change which tmux pane a wheel report lands in. That is a
 *                  decision to take deliberately, not silently.
 *   schedule-frame One `requestAnimationFrame`, whose callback feeds a `frame`
 *                  event back in. Perform it unconditionally, and never gate it
 *                  on the `pumping` of the state it arrives with: the frame
 *                  case re-arms (:6224) and returns `pumping` TRUE, because
 *                  more travel is owed, and a component that guarded the rAF on
 *                  that flag being false would drop every re-arm and stall a
 *                  burst bigger than one frame. The invariant is that never
 *                  more than one frame is outstanding, and the module holds it
 *                  for you: a wheel arms only when nothing is outstanding
 *                  (:6257 arms on `wheelRAF === null`, which is
 *                  `!state.pumping` here), and a frame re-arms the one it has
 *                  just spent. Perform the actions and `pumping` reads as "a
 *                  frame is outstanding". Feed a `frame` ONLY for a frame this
 *                  module asked for: like term.html's `pumpWheel` (:6212), the
 *                  frame case does not test whether one was outstanding,
 *                  because nothing else can call it.
 *   cancel-frame   `cancelAnimationFrame` on the handle from the last
 *                  schedule-frame (:6271), and forget the handle.
 *
 * Then the four things no action carries:
 *   - THE RETURN VALUE. `passToXterm` goes back verbatim from the handler
 *     xterm calls. xterm diverts only on an exact `false`
 *     (`if (this._customWheelEventHandler &&
 *     false === this._customWheelEventHandler(ev)) return false`), so `true`
 *     reaches its raw path unchanged.
 *   - preventDefault IS NOT THIS MODULE'S, and measured against the installed
 *     xterm 6.0.0 it is not needed either. Two listeners consult the custom
 *     handler, both on the terminal element and both non-passive. In
 *     mouse-tracking mode xterm's is `wheel: e => (i(e), this.cancel(e, true))`,
 *     a comma expression, so the intercepted event is preventDefaulted whatever
 *     the handler answered. Outside mouse tracking the other listener returns
 *     early on a `false` and prevents nothing, but there `.xterm-viewport {
 *     overflow-y: scroll }` (xterm.css:93-96) means the browser's own native
 *     scroll IS the scrollback behaviour and is the right thing to leave alone;
 *     the emitted wheels do not double it, because `dispatchEvent` runs
 *     listeners without performing a default action. term.html:6191-6192 states
 *     that xterm's `cancel()` covers this in every case; the mouse-tracking
 *     half is the half the source shows.
 *   - STATE IS PER TERMINAL. The lobby keeps every visited session mounted and
 *     CSS-hides the rest (`store/keepalive.ts`), so several terminals exist at
 *     once. Each holds its own `WheelState` and its own frame handle. term.html
 *     can afford page-level variables, being one terminal per document.
 *   - THE ATTACH AND DETACH, of which only the detach is optional. `isSmoothOn`
 *     is the same reading term.html's `applyWheelSmoothPref` (:6264-6273) takes
 *     at boot and from every pref apply path; when it goes false, feed a
 *     `detached` event in and detach. Feed one on unmount too. The pref path
 *     does THREE things at :6269-6271, and the `detached` event is the only
 *     carrier of the last two: it detaches the handler, zeroes `wheelAccumPx`,
 *     and `cancelAnimationFrame`s the pending frame. A component that cannot
 *     detach may keep the handler attached, since a `smoothOn: false` world
 *     passes every wheel through to the same raw xterm path, and it still owes
 *     the event. Skipping it keeps a live rAF and a loaded accumulator
 *     across the toggle, and the `frame` case deliberately does not re-read the
 *     pref, so that frame drains into emissions after the pref went off.
 *     Measured: from `{ accumPx: 160, pumping: true }` with `smoothOn` false and
 *     no `detached` fed, a `frame` at cellH 16 speed 1 returns one emit of ten
 *     rows; term.html cancels that frame at :6271 and emits none.
 *
 * WHAT THE COMPONENT MUST READ, and when. Every field FRESH at the moment of
 * the event, because that is when term.html reads it.
 *   cellH     px per row: `.xterm-screen`'s box height over `term.rows`, and 16
 *             when there is no screen or no rows (:6094-6097). Read on a wheel
 *             (line mode, and the cap) and on a frame (the row size). The 16
 *             covers a MISSING screen only. A screen that exists and has not
 *             laid out yet has height 0 with `term.rows` nonzero, so it measures
 *             0, which the clamp and the frame both handle by dropping travel.
 *   screenH   `.xterm-screen`'s box height, `(term.rows || 24) * 16` without one
 *             (:6098-6101). Read for a DOM_DELTA_PAGE wheel only. Same shape: an
 *             unlaid-out screen measures 0, not the fallback.
 *   speed     the roamed `gestures.wheelSpeed`, RAW. This module validates it
 *             through `speedMultiplier`, because term.html holds no validated
 *             copy either: `wheelSpeedMult()` (:6206-6209) is called fresh at
 *             both of its two sites, the frame's row size (:6214) and the
 *             wheel's cap (:6254), and a roamed doc can carry anything.
 *   smoothOn  `isSmoothOn` of the master kill and the pref (:6203-6205). Read on
 *             a wheel only, deliberately: see the `frame` case.
 *   mounted   `!!term.element` (:6215, :6238). Read on a wheel and a frame.
 * Nothing is cached from a wheel into the frame it scheduled, so a speed change
 * or a resize mid-burst is visible to the drain, which is where the pump's own
 * row clamp earns its keep.
 *
 * TWO THINGS A READER WILL WANT TO CHECK.
 *   - A WHEEL ALREADY IN LINE UNITS. What stops a double conversion is the
 *     `isTrusted` gate, not a deltaMode test: this module's own emissions are
 *     untrusted and pass straight through. A TRUSTED line wheel, which is a
 *     notched mouse, IS normalized through px (:6239) and comes back out as
 *     `deltaY * speed` one-row wheels, so at the default speed the total travel
 *     is unchanged and only the count of DOM events and their pacing differ.
 *     That split is the fix rather than a side effect: one deltaY=3 event is one
 *     app report, three deltaY=1 events are three.
 *   - TWO CLAMPS, BOTH KEPT. The accumulator is bounded to one frame's drain on
 *     every wheel (:6244-6256), because with no JS momentum it must never hold
 *     more than a frame spends, or a hard flick backlogs into the multi-second
 *     runaway coast term.html names. The pump then clamps the row count as well
 *     (:6218-6219). That second clamp bites whenever the row size SHRANK between
 *     the wheel and the frame it scheduled, since the wheel caps the accumulator
 *     at ten rows measured at the wheel's numbers and the pump counts rows at
 *     the frame's: a speed rise does it, and so does a smaller cell height from
 *     a font change or a resize. With the same numbers at both ends the two caps
 *     agree and `k` cannot come out above ten. Dropping either one gives back a
 *     different failure.
 *
 * OUT OF SCOPE. The wheel accumulator that decides when a wheel DISMISSES a
 * highlight (`WHEEL_CLEAR_PX`, `WHEEL_WINDOW_MS`, :5849 and :6276-6297) shares
 * that host-element listener at :6278 and belongs with selection; the one
 * genuine document-level `wheel` listener in the page is neither of these, it is
 * the diagnostics ring buffer at :5883. The touch recognizer and its momentum
 * engine are :6056-6171, and the pixel-to-font pinch is `font.ts`.
 */

import type { WheelSpeed } from "../store/prefs";

/**
 * The per-frame emission ceiling, term.html:6082.
 *
 * ONE constant in term.html, shared with the touch scroller, which uses it in
 * `feedScroll` (:6123-6124). ~600 rows/s at 60fps, far above any intentional
 * scroll, so it bounds a runaway without being reachable by hand.
 *
 * `touchscroll.ts` declares its own copy of the same number, so the two ports
 * each carry one where the page carries one. Both cite :6082, and picking a
 * single home is a wiring decision rather than something either module can take
 * on its own.
 */
export const SCROLL_MAX_EVENTS_PER_FEED = 10;

/** `WheelEvent.DOM_DELTA_LINE`. A deltaY in rows. */
export const DOM_DELTA_LINE = 1;
/** `WheelEvent.DOM_DELTA_PAGE`. A deltaY in screenfuls. */
export const DOM_DELTA_PAGE = 2;

/**
 * A DOM wheel event, narrowed to what the interceptor reads.
 *
 * `deltaMode` stays a plain number because that is what the DOM hands over; the
 * two values that mean anything here have names above.
 */
export interface WheelFacts {
  /** False for this module's own emissions, and for anything else script-made. */
  readonly isTrusted: boolean;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

/** What the component measured from xterm and the prefs for this event. */
export interface WheelWorld {
  /** px per row. */
  readonly cellH: number;
  /** px of the whole screen. Read for a page-mode wheel only. */
  readonly screenH: number;
  /** The raw `gestures.wheelSpeed`; validated here, not by the caller. */
  readonly speed: number;
  /** `isSmoothOn` of the master kill and the pref. */
  readonly smoothOn: boolean;
  /** `!!term.element`: xterm has opened and has not been disposed. */
  readonly mounted: boolean;
}

/** The two halves of term.html's `wheelSmoothOn()` (:6203-6205). */
export interface SmoothGates {
  /**
   * The gestures master kill: localStorage `tl-gestures` !== 'off'
   * (term.html:3163-3166). The read goes inside a try/catch that answers TRUE
   * on a throw, so a browser that refuses storage keeps its gestures rather
   * than losing them. Nothing in frontend-v2 reads that key yet.
   */
  readonly gesturesEnabled: boolean;
  /** The roamed `gestures.wheelSmooth` pref. Default ON. */
  readonly wheelSmooth: boolean;
}

export interface WheelState {
  /**
   * Signed px of travel not yet spent, term.html's `wheelAccumPx` (:6201).
   *
   * It carries ACROSS events on purpose. Rounding each wheel on its own would
   * drop every sub-row delta, and a trackpad scrolled slowly is nothing but
   * sub-row deltas, so the terminal would never move however long you scrolled.
   */
  readonly accumPx: number;
  /**
   * A frame has been asked for and has not run yet, term.html's `wheelRAF !==
   * null` (:6202). It is what keeps one burst to one frame request.
   */
  readonly pumping: boolean;
}

/** Nothing owed, no frame outstanding. Where a freshly mounted terminal starts. */
export const NO_WHEEL: WheelState = { accumPx: 0, pumping: false };

export type SmoothWheelEvent =
  /** A wheel event reached xterm's custom handler. */
  | { readonly type: "wheel"; readonly wheel: WheelFacts }
  /** The frame this module asked for has run: term.html's `pumpWheel` (:6212). */
  | { readonly type: "frame" }
  /**
   * The interceptor has been taken out of the wheel path: the pref went off,
   * the gestures master kill flipped, or the terminal is unmounting. The else
   * branch of `applyWheelSmoothPref` (:6269-6271).
   */
  | { readonly type: "detached" };

export type WheelAction =
  /**
   * Dispatch this many one-row LINE wheels in this direction, as separate
   * events. `count` is always at least 1; a frame with nothing to spend asks
   * for no emit at all.
   */
  | { readonly kind: "emit"; readonly sign: -1 | 1; readonly count: number }
  /** requestAnimationFrame, feeding a `frame` event back in. */
  | { readonly kind: "schedule-frame" }
  /** cancelAnimationFrame on the outstanding handle. */
  | { readonly kind: "cancel-frame" };

export interface WheelReduction {
  /** Identical to the state passed in for every pass-through, so the hot path allocates nothing. */
  readonly state: WheelState;
  /** In the order the component must perform them. Empty when there is nothing to do. */
  readonly actions: readonly WheelAction[];
  /**
   * What the xterm custom handler returns: `true` hands the event to xterm's
   * raw path, `false` says this module has taken it. Only a `wheel` event's
   * answer means anything, and it is the only event a handler is inside; the
   * other two answer `true` because there is no wheel to suppress.
   */
  readonly passToXterm: boolean;
}

const NOTHING: readonly WheelAction[] = [];
const SCHEDULE: WheelAction = { kind: "schedule-frame" };
const CANCEL: WheelAction = { kind: "cancel-frame" };

/** term.html:6203-6205. Either half off stops the interceptor. */
export function isSmoothOn(gates: SmoothGates): boolean {
  return gates.gesturesEnabled && gates.wheelSmooth;
}

/**
 * The speed pref, validated (term.html:6206-6208 verbatim).
 *
 * Written out rather than tested against `WHEEL_SPEEDS` so the literal union
 * narrows and nothing needs casting. The fallback matters, and both junk values
 * end at the same place, a terminal that has stopped scrolling. A roamed 0 makes
 * the row size infinite, so `k` truncates to zero forever and the accumulator
 * fills without ever emitting. A negative makes it negative, which `onFrame`
 * refuses at `!(rowPx > 0)` (:6215) and drops; the negative cap on the wheel
 * path also flips the accumulator's sign, and that never reaches the screen
 * either, since the same frame drops it.
 */
export function speedMultiplier(value: number): WheelSpeed {
  return value === 1 || value === 1.5 || value === 2 || value === 3 ? value : 1;
}

/** The whole interceptor. Nothing here touches xterm, the DOM, a clock or a frame. */
export function reduce(
  state: WheelState,
  event: SmoothWheelEvent,
  world: WheelWorld,
): WheelReduction {
  switch (event.type) {
    case "wheel":
      return onWheel(state, event.wheel, world);
    case "frame":
      return onFrame(state, world);
    case "detached":
      return onDetached(state);
    default: {
      const unhandled: never = event;
      void unhandled;
      return passed(state);
    }
  }
}

/** Hand the event to xterm and change nothing. The state comes back by identity. */
function passed(state: WheelState): WheelReduction {
  return { state, actions: NOTHING, passToXterm: true };
}

function onWheel(state: WheelState, ev: WheelFacts, world: WheelWorld): WheelReduction {
  // The pass-through set, in term.html's order (:6229-6242).
  //
  // isTrusted first, because it is both the re-entrancy guard and what keeps
  // the touch scroller's emissions out of this accumulator (:6229-6231). Then
  // the modifiers, which each mean something else already: Shift is horizontal
  // scrolling, Ctrl and Cmd are zoom, Alt is nothing this may claim, and a
  // horizontal-dominant delta is a native two-finger swipe. term.html marks all
  // of that as the red line, unchanged from before the interceptor existed
  // (:6233-6235).
  if (!ev.isTrusted) return passed(state);
  if (ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.altKey) return passed(state);
  // `>` and not `>=`: a perfectly diagonal wheel is intercepted, which is
  // term.html's reading (:6237). The two differ on exactly that event.
  if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) return passed(state);
  if (!world.smoothOn || !world.mounted) return passed(state);

  // Normalize to px so one accumulator serves every input device (:6239-6241).
  const px =
    ev.deltaMode === DOM_DELTA_LINE
      ? ev.deltaY * world.cellH
      : ev.deltaMode === DOM_DELTA_PAGE
        ? ev.deltaY * world.screenH
        : ev.deltaY;
  // `!px` (:6242). The value an unlaid-out screen actually produces is ZERO, not
  // NaN: `xtermCellH` is `height / term.rows` and `xtermScreenH` is `height`
  // (:6094-6101), so a screen with no layout yet measures 0 in both and a line
  // or page delta multiplies to 0 here, which this gate refuses. Measured: at
  // cellH 0 a deltaMode 1, deltaY 3 wheel passes through with the state
  // untouched. `!` refuses a NaN too, which is worth knowing but is not a value
  // either of those two measurements can hand over. A PIXEL wheel is the one
  // case this gate does not catch at cellH 0, its px being the raw deltaY, and
  // the cap below is what discards that one.
  if (!px) return passed(state);

  const capPx = SCROLL_MAX_EVENTS_PER_FEED * (world.cellH / speedMultiplier(world.speed));
  const actions: WheelAction[] = [];
  // One frame per burst: :6257 arms only when nothing is outstanding.
  if (!state.pumping) actions.push(SCHEDULE);
  return {
    state: { accumPx: clampAccum(state.accumPx + px, capPx), pumping: true },
    actions,
    passToXterm: false,
  };
}

/**
 * Bound the accumulator to one frame's drain (term.html:6244-6256).
 *
 * Two ifs rather than a `Math.min`/`Math.max` pair because :6255-6256 is two
 * ifs. That is the whole reason, and an earlier draft of this comment gave a
 * different one that was false in both halves. It named an unlaid-out screen as
 * the case that needs this shape, and an unlaid-out screen gives a cap of ZERO:
 * `xtermCellH` measures 0 there (:6094-6097) and `10 * (0 / speed)` is 0. It
 * then said the shape leaves such an accumulator untouched, where a zero cap
 * CLAMPS it to zero and discards every px of travel. Measured: cellH 0, one
 * 100px pixel wheel, capPx 0, accumPx 0.
 *
 * The two shapes do differ on a NaN cap, where two ifs keep the accumulator and
 * `Math.min(x, NaN)` would poison it, and matching the page keeps that
 * behaviour. No cell height the page's own measurement can return makes the cap
 * NaN, though, and it changes nothing either way: the frame refuses to divide by
 * a NaN row size and drops what is left (:6215). Measured at cellH NaN, accumPx
 * survives the clamp at 100 and the frame it scheduled emits nothing.
 */
function clampAccum(accumPx: number, capPx: number): number {
  if (accumPx > capPx) return capPx;
  if (accumPx < -capPx) return -capPx;
  return accumPx;
}

function onFrame(state: WheelState, world: WheelWorld): WheelReduction {
  // The row size is re-derived here rather than carried from the wheel, so a
  // speed change or a font change between the two is respected (:6214).
  const rowPx = world.cellH / speedMultiplier(world.speed);
  // `!(rowPx > 0)` and not `!== 0` (:6215): a NaN and a negative are refused
  // with the zero. There is nothing to divide by, and travel measured against a
  // size that no longer applies is not travel worth keeping, so it goes.
  if (!(rowPx > 0) || !world.mounted) {
    return { state: NO_WHEEL, actions: NOTHING, passToXterm: true };
  }

  // Note what this case does NOT read: the pref. term.html cancels the pending
  // frame from the pref path instead (:6271), so a frame that survived a pref
  // change is one nobody cancelled, and draining it is what that page does. A
  // `smoothOn` test here would be a divergence rather than a tidy-up.
  const actions: WheelAction[] = [];
  let accumPx = state.accumPx;
  let k = Math.trunc(accumPx / rowPx);
  if (k !== 0) {
    // :6218-6219. Reachable when the row size SHRANK since the wheel clamped
    // the accumulator, from a speed rise or a smaller cell height, which is why
    // the size is re-derived above. With the same numbers at both ends the
    // wheel's cap is exactly ten of these rows, so `k` lands at ten at most.
    if (k > SCROLL_MAX_EVENTS_PER_FEED) k = SCROLL_MAX_EVENTS_PER_FEED;
    else if (k < -SCROLL_MAX_EVENTS_PER_FEED) k = -SCROLL_MAX_EVENTS_PER_FEED;
    // Math.trunc, so the sub-row remainder keeps its sign and its size and the
    // next frame or the next wheel spends it (:6220).
    accumPx -= k * rowPx;
    actions.push({ kind: "emit", sign: k < 0 ? -1 : 1, count: Math.abs(k) });
  }
  // Keep pumping while a whole row is still owed: an inertia tail or a burst
  // bigger than one frame drains over several (:6224). Below a row the travel
  // waits for the next wheel instead, which costs nothing.
  const pumping = Math.abs(accumPx) >= rowPx;
  if (pumping) actions.push(SCHEDULE);
  return { state: { accumPx, pumping }, actions, passToXterm: true };
}

/**
 * term.html:6269-6271. The travel is forgotten and the frame is cancelled, so
 * turning the pref back on cannot emit a burst that was accumulated before it
 * went off.
 */
function onDetached(state: WheelState): WheelReduction {
  return {
    state: NO_WHEEL,
    actions: state.pumping ? [CANCEL] : NOTHING,
    passToXterm: true,
  };
}
