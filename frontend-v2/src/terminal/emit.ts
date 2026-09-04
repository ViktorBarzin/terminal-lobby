/**
 * What the two scrollers share: the one synthetic-wheel emission, the clientY
 * every one of those wheels carries, the per-frame cap, and one reading of the
 * screen box (frontend/term.html:6082, :6087, :6094-6113).
 *
 * WHY THERE IS A FILE HERE AT ALL. `touchscroll.ts` and `wheel.ts` are ports of
 * two separate ranges of term.html, and each was written and reviewed as
 * something a component could wire on its own. In the page they are not
 * separate. They call ONE `emitLineWheel` (:6105), which reads ONE
 * `scrollLastEmitY` (:6087, read at :6111); they clamp against ONE
 * `SCROLL_MAX_EVENTS_PER_FEED` (:6082, spent by the finger at :6123-6124 and by
 * the trackpad at :6218-6219 and :6254); and they measure ONE `.xterm-screen`
 * box, through `xtermCellH` (:6094) and `xtermScreenH` (:6098). Each module's
 * owes list carries its own half of that and says, correctly, that picking a
 * home is a wiring decision neither of them can take alone. This file is that
 * decision, so that wiring one scroller today and the other next week cannot
 * quietly give them two coordinates, two caps and two measurements.
 *
 * PURE, like every module under src/terminal, which is why the two DOM calls
 * this file is about are not in it. The `WheelEvent` constructor stays in
 * TerminalNative.tsx, beside the `new MouseEvent` the drag-selection wiring
 * already dispatches, and `getBoundingClientRect` stays behind `MeasureScreen`,
 * which is a callback rather than a measurement so that a field nobody reads is
 * a box nobody measured. That is not tidiness: it is the only shape in which one
 * reader can serve two incompatible freshness rules, and the section on the box
 * says why.
 *
 * THE COORDINATE, AND THE MACHINE THAT HAS NO FINGER. Every synthetic wheel
 * carries its `clientY` from `scrollLastEmitY`, which starts at 100 (:6087) and
 * is assigned in exactly ONE place in the whole page: :6522, the touchmove that
 * feeds the scroller, inside `if (isCoarsePointer)` (:6478, the query read once
 * at :6350). The trackpad pacer only ever reads it, through the shared
 * primitive. So a trackpad wheel carries the last y a finger reached, and on a
 * machine where no finger ever did, it carries 100 for the life of the page.
 *
 * That is a real coupling and not a placeholder, which is why both modules keep
 * it and neither would change it alone. xterm builds the mouse report's row from
 * the event's `clientY` measured against the SCREEN element's box:
 * `getMouseReportCoords` (MouseService.ts) takes
 * `clientY - rect.top - paddingTop`, clamps it into the canvas, and divides by
 * the cell height. That row decides which tmux pane the wheel report is routed
 * to, so a port that switched to the wheel's own clientY would move a trackpad
 * scroll from one pane to another on a split window. `NO_TOUCH_EMIT` names the
 * state a mouse-only terminal never leaves, so that case is a value with a name
 * rather than a fallback nobody notices.
 *
 * ONE CAP, ONE HOME. `SCROLL_MAX_EVENTS_PER_FEED` lives here because term.html
 * has one of it and four users of it, across both scrollers. Both ports had
 * declared their own copy of the number while neither could see the other, each
 * saying on its own declaration that choosing a home was not theirs to do.
 * Nothing in this file spends it, deliberately: `emitLineWheel` has no cap either, because
 * each feed applies the clamp while deciding, before an action exists. Both
 * ports now import this one and re-export it, so the name stays in each
 * module's public API where their suites read it, and there is one number to
 * check against the page.
 *
 * ONE BOX, TWO FRESHNESS RULES, SO THE READ IS LAZY PER FIELD. `xtermCellH` and
 * `xtermScreenH` measure the same `.xterm-screen` height, and the two scrollers
 * want it at different moments. The touch path reads the cell height on every
 * feed and the screen height at the LIFT ONLY, and its owes list forbids
 * measuring the screen height on a touchmove, because that is the hot path and a
 * box read forces a layout against a grid xterm is writing into. The trackpad
 * path reads the cell height on a wheel and on a frame, and the screen height on
 * a DOM_DELTA_PAGE wheel only. A shared reader that measured both up front would
 * satisfy both type signatures and break the touch rule with nothing to notice
 * it.
 *
 * So `screenGeometry` hands back getters, measured at most once and only if
 * read, which is the pattern TerminalNative.tsx's `worldAt` already uses for the
 * drag-selection screen box and for the same reason. Both fields share one
 * measurement, because they are one box and nothing between two reads inside a
 * single reduction can move it; the freshness that matters is per EVENT, and the
 * component gets that by building one geometry per event, as `worldAt` does. A
 * world built from `{ ...geometry }` would evaluate the getters on the spot and
 * lose all of it, which is why the two world builders below exist and why the
 * laziness has a test of its own rather than a comment.
 *
 * WHAT THE COMPONENT STILL OWES. The module decides and the component performs,
 * so anything missing from this list is behaviour nobody performs.
 *
 * THE DISPATCH, which is the same two lines for both scrollers:
 *
 *     for (const w of wheelsFor(action, point))
 *       term.element?.dispatchEvent(new WheelEvent("wheel", w));
 *
 * on the xterm ROOT (`term.element`, :6107), not the host and not
 * `.xterm-screen`, and one `dispatchEvent` per wheel. Separate dispatches are
 * the entire mechanism: in mouse-tracking mode xterm forwards at most one report
 * per DOM wheel event with the magnitude discarded, so one event carrying
 * `deltaY: 3` is one report where three events are three. The `term.element`
 * test is also term.html's own guard at :6106; both feeds test `mounted` before
 * they emit, so it can only fire on a terminal disposed between the decision and
 * the dispatch.
 *
 * THE COORDINATE, one `EmitPoint` per terminal, seeded `NO_TOUCH_EMIT`. After
 * EVERY touchscroll reduction, whatever it decided:
 *
 *     point = noteTouchEmit(point, r.state.emitY);
 *
 * from the module's STATE and not from a dispatched action, because :6522 writes
 * `scrollLastEmitY` on every qualifying touchmove, including one that banks its
 * pixels and emits no wheel at all. Reading it off an action would skip those and
 * leave a trackpad wheel carrying a y the finger has already left. The trackpad
 * path only reads it, exactly as the page does.
 *
 * THE RESOLVER behind `MeasureScreen`, which must find `.xterm-screen` inside
 * THIS terminal's own host:
 *
 *     screenGeometry(() => {
 *       const scr = host?.querySelector<HTMLElement>(".xterm-screen");
 *       return scr ? scr.getBoundingClientRect().height : null;
 *     }, term.rows)
 *
 * TerminalNative.tsx's `screenOf` is already that query, for the reason
 * dragselect.ts gives: term.html can afford `document.querySelector` (:6095,
 * :6099) because a framed page holds one terminal, while the lobby keeps every
 * visited session mounted and CSS-hides the rest (`.tl-hidden`,
 * `display: none`, app.css:1121-1123). A document query would hand every
 * terminal the first match in the DOM, and a hidden one measures 0, which makes
 * `rowPx` 0: the visible terminal's finger would then bank pixels and emit not
 * one wheel.
 *
 * THE LIFETIME. One geometry per event, built beside the world that reads it.
 * Hoisting one caches a box across events, which is the staleness both modules'
 * "read every field FRESH" instruction exists to prevent, and the memo would
 * make it invisible.
 *
 * PER TERMINAL, for both the point and the geometry, since several terminals are
 * mounted at once (`store/keepalive.ts`). term.html can afford page-level
 * variables for both.
 *
 * WHERE THIS IS NOT term.html LINE FOR LINE. Two divergences, and two things
 * that read like one and are not.
 *
 * `emitLineWheel(sign)` accepts any signed number and normalizes it (:6108).
 * `lineWheelAt` takes `-1 | 1`, so a caller cannot hand it 3 and silently get
 * one row. Nothing is lost: both of the page's callers already reduce a signed
 * count to a sign before calling it (`k < 0 ? -1 : 1` at :6126 and :6221) and
 * loop over the magnitude (:6127, :6222).
 *
 * The box is measured once per geometry where the page measures it once per
 * helper call (:6096 and :6100 each run their own `getBoundingClientRect`).
 * Within one reduction the two answers cannot differ, since nothing mutates the
 * DOM between them, so a second read would cost a layout read to return the
 * number the first one already had.
 *
 * The two that only look like divergences. The count and the fan-out sit on
 * opposite sides in the two PORTS, which is conflict 1 in one sentence:
 * touchscroll's `feed` pushes one `wheel` action per row, all sharing one init,
 * while wheel.ts's `onFrame` pushes a single `emit` action carrying a count.
 * Neither is what the page does differently; `wheelsFor` answers both with a
 * list of wheels to dispatch, so the component performs one shape.
 *
 * And no cap is applied to `count`, exactly as `emitLineWheel` applies none: the
 * cap belongs to the feeds and each applies it before the action exists
 * (wheel.ts clamps `k` to ten, touchscroll clamps `whole`), which is worth
 * saying here because this is the file the constant lives in. The fan-out is a
 * loop rather than `new Array(count)` so that a count which could not arrive
 * returns nothing instead of throwing a RangeError inside a wheel handler.
 *
 * OUT OF SCOPE. Which wheels a scroller decides to emit is `touchscroll.ts` and
 * `wheel.ts`; this file only says what one of them looks like and where its y
 * comes from. The trusted-wheel cancel that ends a coast is a listener on the
 * host element (registered at :6278, cancelling at :6281) reaching touchscroll
 * as `interrupt`, not an emission. What a wheel does to a selection is
 * selection.ts, in that same listener (`WHEEL_CLEAR_PX`, :5849, spent at
 * :6292). The `tl-gestures` master kill and the scroll prefs are the
 * component's to read.
 */

import type { LineWheel, TouchScrollAction, TouchScrollWorld } from "./touchscroll";
import type { WheelAction, WheelWorld } from "./wheel";

/**
 * The per-frame emission ceiling, term.html:6082, and the one home for it.
 *
 * ~600 rows/s at 60fps, far above any intentional scroll, so it bounds a runaway
 * without being reachable by hand. One constant in the page with four spends,
 * two in each scroller. `touchscroll.ts` and `wheel.ts` re-export this
 * binding rather than declaring the number a second time; see the header for
 * why nothing here spends it.
 */
export const SCROLL_MAX_EVENTS_PER_FEED = 10;

/**
 * Where the shared clientY starts, term.html:6087 (`let scrollLastEmitY = 100`).
 *
 * A real coordinate rather than a neutral zero, and the one a mouse-only machine
 * keeps. It is a VIEWPORT y, so which row it names depends on where the screen
 * box sits: xterm subtracts the box's top and padding before dividing by the
 * cell height, and clamps the result into the canvas.
 */
export const EMIT_Y_SEED = 100;

/** The clientX every synthetic wheel carries, term.html:6111. */
const EMIT_CLIENT_X = 0;

/**
 * The point the next synthetic wheels are emitted at: term.html's
 * `scrollLastEmitY`, per terminal.
 *
 * One field, because that is all the page carries. The x is a constant (:6111)
 * and the y is the only part a finger moves.
 */
export interface EmitPoint {
  /** The `clientY` a synthetic wheel carries. */
  readonly y: number;
}

/**
 * Where a freshly mounted terminal starts, and where a terminal with no touch
 * screen stays for its whole life.
 *
 * touchscroll's attach is gated on `isCoarsePointer()` read once at mount, as
 * term.html gates its whole recognizer (:6478), so on a mouse-only machine
 * `noteTouchEmit` is never called: not once, not late, not from a fallback path.
 * Every trackpad wheel report there is built from y 100. term.html does exactly
 * the same, since :6522 is its only writer and it sits inside that gate.
 */
export const NO_TOUCH_EMIT: EmitPoint = { y: EMIT_Y_SEED };

/**
 * Record where the touch scroller's wheels are now landing (term.html:6522).
 *
 * The only writer, as the page has only one. Fed from the touch module's state
 * after every reduction rather than from a dispatched wheel, because the page
 * assigns on every qualifying touchmove and a move can advance the y without
 * emitting anything.
 *
 * Identity is preserved when the y has not moved, so a coast, which reuses the
 * drag's last y for every frame, allocates nothing.
 */
export function noteTouchEmit(point: EmitPoint, y: number): EmitPoint {
  return point.y === y ? point : { y };
}

/**
 * One synthetic wheel, as the `WheelEvent` init the component dispatches:
 * term.html's `emitLineWheel` (:6105-6113) with its `scrollLastEmitY` read
 * passed in.
 *
 * `deltaMode: 1` is DOM_DELTA_LINE and one row exact, which is the only shape
 * xterm neither damps nor collapses. `consumeWheelEvent` multiplies a
 * pixel-mode delta under 50px by 0.3 (`isLikelyTrackpad`,
 * CoreMouseService.ts), and in mouse-tracking mode one DOM wheel event produces
 * at most one report whatever its magnitude, so a pixel delta and a `deltaY: k`
 * would each arrive at the pty as something other than what was asked for.
 */
export function lineWheelAt(sign: -1 | 1, clientY: number): LineWheel {
  return {
    deltaY: sign,
    deltaMode: 1,
    bubbles: true,
    cancelable: true,
    clientX: EMIT_CLIENT_X,
    clientY,
  };
}

/**
 * What a scroller asks to be emitted: touchscroll's `wheel` action, which
 * carries a finished init, or wheel.ts's `emit` action, which carries a sign and
 * a count.
 *
 * Extracted from the modules' own action unions rather than restated, so a
 * change to either shape fails here at compile time instead of in the wiring.
 * The two discriminants differ, which is what lets one union carry both.
 */
export type EmitRequest =
  | Extract<TouchScrollAction, { kind: "wheel" }>
  | Extract<WheelAction, { kind: "emit" }>;

/**
 * The wheels one scroller action becomes, in the order they must be dispatched.
 *
 * The touch arm hands back the module's own init untouched: it was built from
 * that module's `emitY`, which is the same number `point` holds, and one action
 * is one wheel there. The trackpad arm builds `count` of them at `point.y`,
 * because that module fans out with a count instead. The same wheels either way,
 * which is the whole point of there being one primitive.
 */
export function wheelsFor(request: EmitRequest, point: EmitPoint): readonly LineWheel[] {
  if (request.kind === "wheel") return [request.wheel];
  // One init, repeated. The component builds a fresh WheelEvent per dispatch and
  // nothing on either side mutates the init, so `count` distinct objects would
  // differ only in allocations.
  const wheel = lineWheelAt(request.sign, point.y);
  const wheels: LineWheel[] = [];
  for (let i = 0; i < request.count; i++) wheels.push(wheel);
  return wheels;
}

/**
 * The cell height with no screen element to measure, term.html:6096.
 *
 * It covers a MISSING screen only. A screen that exists and has not laid out yet
 * measures 0 with `term.rows` nonzero, and both scrollers handle that 0 by
 * keeping their pixels rather than spending them.
 */
export const FALLBACK_CELL_HEIGHT_PX = 16;

/** The rows `xtermScreenH` assumes with neither a screen nor rows, term.html:6100. */
export const FALLBACK_ROWS = 24;

/**
 * Measure `.xterm-screen`'s box height inside THIS terminal's host, or answer
 * `null` when there is no such element.
 *
 * A callback and not a measurement, so that the geometry below can decline to
 * call it. The header has the resolver to pass, and why a document query is the
 * wrong one.
 */
export type MeasureScreen = () => number | null;

/**
 * One reading of the screen box, as the two numbers both scrollers derive from
 * it (term.html:6094-6101).
 *
 * Both are getters. Reading one measures the box; reading the other after it
 * costs nothing; reading neither measures nothing.
 */
export interface ScreenGeometry {
  /** `.xterm-screen`'s height over `term.rows`, term.html:6094-6097. */
  readonly cellHeightPx: number;
  /** `.xterm-screen`'s height, term.html:6098-6101. */
  readonly screenHeightPx: number;
}

/**
 * The lazy box read, one object per event.
 *
 * `rows` is `term.rows` at the moment of the event, which is a property read
 * rather than a layout flush, so it is taken eagerly. The height is not.
 */
export function screenGeometry(measure: MeasureScreen, rows: number): ScreenGeometry {
  // Three states, and `undefined` is the one that matters: not measured yet.
  // `null` is measured, and there was no screen element to measure.
  let height: number | null | undefined;
  const box = (): number | null => {
    if (height === undefined) height = measure();
    return height;
  };
  return {
    get cellHeightPx(): number {
      const h = box();
      // term.html tests `term.rows` for truth (:6096), so 0 rows takes the
      // fallback instead of dividing by zero, and so would a NaN.
      return h !== null && rows ? h / rows : FALLBACK_CELL_HEIGHT_PX;
    },
    get screenHeightPx(): number {
      const h = box();
      // The other fallback, deliberately not the same shape (:6100): a screen
      // that exists answers with its height whatever `term.rows` is.
      return h !== null ? h : (rows || FALLBACK_ROWS) * FALLBACK_CELL_HEIGHT_PX;
    },
  };
}

/**
 * A `TouchScrollWorld` over a shared geometry, with the box reads still lazy.
 *
 * The geometry goes in as getters and not as values, which is the only part of
 * this that carries any weight: the touch path reads `screenHeightPx` at the
 * lift and its owes list forbids measuring it on a touchmove, and the only thing
 * standing between those two facts is that this stays a getter. `rest` is spread
 * FIRST so neither box field can be shadowed by a caller.
 */
export function touchScrollWorld(
  geometry: ScreenGeometry,
  rest: Omit<TouchScrollWorld, "cellHeightPx" | "screenHeightPx">,
): TouchScrollWorld {
  return {
    ...rest,
    get cellHeightPx(): number {
      return geometry.cellHeightPx;
    },
    get screenHeightPx(): number {
      return geometry.screenHeightPx;
    },
  };
}

/**
 * A `WheelWorld` over the same geometry, under that module's own field names.
 *
 * `screenH` is read for a DOM_DELTA_PAGE wheel and nothing else, and the two
 * modules disagree about nothing here except spelling.
 */
export function wheelWorld(
  geometry: ScreenGeometry,
  rest: Omit<WheelWorld, "cellH" | "screenH">,
): WheelWorld {
  return {
    ...rest,
    get cellH(): number {
      return geometry.cellHeightPx;
    },
    get screenH(): number {
      return geometry.screenHeightPx;
    },
  };
}
