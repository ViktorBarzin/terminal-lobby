import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EMIT_Y_SEED,
  FALLBACK_CELL_HEIGHT_PX,
  FALLBACK_ROWS,
  NO_TOUCH_EMIT,
  SCROLL_MAX_EVENTS_PER_FEED,
  lineWheelAt,
  noteTouchEmit,
  screenGeometry,
  touchScrollWorld,
  wheelWorld,
  wheelsFor,
  type EmitPoint,
  type ScreenGeometry,
} from "../src/terminal/emit";
import {
  NO_TOUCH_SCROLL,
  SCROLL_MAX_EVENTS_PER_FEED as TOUCH_CAP,
  reduce as reduceTouch,
  type LineWheel,
  type TouchScrollEvent,
  type TouchScrollState,
  type TouchScrollWorld,
} from "../src/terminal/touchscroll";
import {
  DOM_DELTA_LINE,
  DOM_DELTA_PAGE,
  NO_WHEEL,
  SCROLL_MAX_EVENTS_PER_FEED as WHEEL_CAP,
  reduce as reduceWheel,
  type SmoothWheelEvent,
  type WheelFacts,
  type WheelState,
  type WheelWorld,
} from "../src/terminal/wheel";

/**
 * The three couplings the two scroller ports could not resolve on their own,
 * and what happens if a wiring resolves them by accident instead.
 *
 * WHAT IS AT STAKE. touchscroll.ts and wheel.ts were ported from separate
 * ranges of term.html and reviewed as independently wireable. The page does not
 * separate them: one `emitLineWheel` (:6105) reading one `scrollLastEmitY`
 * (:6087), one `SCROLL_MAX_EVENTS_PER_FEED` (:6082) behind four clamps, and one
 * `.xterm-screen` box behind `xtermCellH` (:6094) and `xtermScreenH` (:6098).
 * Each module says its half and hands the choice to the wiring. Wire them from
 * those two lists alone and the terminal gets two coordinates, two caps and two
 * measurements, and the last of those breaks a rule touchscroll states as a
 * rule: never measure the screen box on a touchmove.
 *
 * The cases below are grouped as the three conflicts. The laziness group is the
 * one that stops a later reader collapsing a getter into a plain object: it
 * drives the REAL reducers and counts the measurements they cause, so an eager
 * world fails rather than passing with a comment claiming it is lazy.
 */

/** 16px rows, 24 of them, so a screen box is 384px. term.html's own defaults. */
const CELL_H = 16;
const ROWS = 24;
const SCREEN_H = CELL_H * ROWS;

/**
 * `frontend/term.html` was read here at module scope until 2026-09-05, and the
 * cases that compared this module's constants and helpers against the page's
 * own source went with it. Every `term.html:NNNN` citation below indexes that
 * page at the commit that removed it: provenance for the port, not a claim
 * about anything running. The values they pinned are asserted here as this
 * module's own.
 */

const touchWorld = (over: Partial<TouchScrollWorld> = {}): TouchScrollWorld => ({
  cellHeightPx: CELL_H,
  screenHeightPx: SCREEN_H,
  scrollSpeed: 1,
  momentum: true,
  mounted: true,
  ...over,
});

const smoothWorld = (over: Partial<WheelWorld> = {}): WheelWorld => ({
  cellH: CELL_H,
  screenH: SCREEN_H,
  speed: 1,
  smoothOn: true,
  mounted: true,
  ...over,
});

const wheelFacts = (over: Partial<WheelFacts> = {}): WheelFacts => ({
  isTrusted: true,
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...over,
});

const spin = (over: Partial<WheelFacts> = {}): SmoothWheelEvent => ({
  type: "wheel",
  wheel: wheelFacts(over),
});

/** Play a touch sequence against a plain world, and hand back where it got to. */
const play = (events: readonly TouchScrollEvent[]): TouchScrollState => {
  let state = NO_TOUCH_SCROLL;
  for (const event of events) state = reduceTouch(state, event, touchWorld()).state;
  return state;
};

const start = (y: number, touches = 1): TouchScrollEvent => ({ type: "touchstart", touches, y });
const move = (y: number, t: number, touches = 1): TouchScrollEvent => ({
  type: "touchmove",
  touches,
  y,
  t,
  th: t,
});
const end = (t: number): TouchScrollEvent => ({ type: "touchend", t, th: t });

/** Every wheel a reduction asks the component to dispatch, in order. */
const touchWheels = (
  state: TouchScrollState,
  event: TouchScrollEvent,
  world: TouchScrollWorld,
  point: EmitPoint,
): readonly LineWheel[] => {
  const r = reduceTouch(state, event, world);
  const out: LineWheel[] = [];
  for (const action of r.actions) {
    if (action.kind === "wheel") out.push(...wheelsFor(action, point));
  }
  return out;
};

const wheelEmissions = (
  state: WheelState,
  event: SmoothWheelEvent,
  world: WheelWorld,
  point: EmitPoint,
): readonly LineWheel[] => {
  const r = reduceWheel(state, event, world);
  const out: LineWheel[] = [];
  for (const action of r.actions) {
    if (action.kind === "emit") out.push(...wheelsFor(action, point));
  }
  return out;
};

/**
 * A geometry that counts what it cost: how many times the box was measured, and
 * how many times each field was read.
 *
 * The read counters wrap a real `screenGeometry`, so `measured` is the number of
 * `getBoundingClientRect` calls a component would have paid for.
 */
interface GeometrySpy {
  readonly geometry: ScreenGeometry;
  measured(): number;
  cellReads(): number;
  screenReads(): number;
}

const spy = (height: number | null, rows = ROWS): GeometrySpy => {
  let measured = 0;
  let cell = 0;
  let screen = 0;
  const real = screenGeometry(() => {
    measured++;
    return height;
  }, rows);
  return {
    geometry: {
      get cellHeightPx(): number {
        cell++;
        return real.cellHeightPx;
      },
      get screenHeightPx(): number {
        screen++;
        return real.screenHeightPx;
      },
    },
    measured: () => measured,
    cellReads: () => cell,
    screenReads: () => screen,
  };
};

describe("conflict 1: one coordinate, and the machine that has no finger", () => {
  /**
   * term.html seeds `scrollLastEmitY` to 100 and never resets it, so the very
   * first synthetic wheel of a session carries 100 whatever produced it.
   */
  it("starts where term.html starts", () => {
    expect(EMIT_Y_SEED).toBe(100);
    expect(NO_TOUCH_EMIT.y).toBe(EMIT_Y_SEED);
  });

  /**
   * THE MOUSE-ONLY MACHINE, which is the case a wiring built from the two owes
   * lists has no value for: touchscroll's attach is gated on a coarse pointer,
   * so there is no `TouchScrollState` to read the y off, and the trackpad path
   * still has to emit. Here that is not a fallback, it is the state the terminal
   * was created in and never leaves.
   */
  it("carries 100 on every trackpad wheel when no finger ever emitted", () => {
    const wheels = wheelsFor({ kind: "emit", sign: -1, count: 3 }, NO_TOUCH_EMIT);
    expect(wheels).toHaveLength(3);
    for (const w of wheels) expect(w.clientY).toBe(100);
  });

  /** The finger writes it, and the trackpad's next burst carries what it wrote. */
  it("hands the finger's last y to the trackpad", () => {
    const point = noteTouchEmit(NO_TOUCH_EMIT, 412);
    expect(point.y).toBe(412);
    expect(wheelsFor({ kind: "emit", sign: 1, count: 1 }, point)[0]?.clientY).toBe(412);
  });

  /**
   * FED FROM THE STATE, NOT FROM AN ACTION, which is the difference term.html
   * has at :6522: it assigns on every qualifying touchmove, before the feed
   * decides anything. A single 8px move on 16px rows banks its pixels and emits
   * nothing, and the page still moved the coordinate. A wiring that recorded the
   * y off a dispatched wheel would have missed this move entirely and left the
   * trackpad emitting at the previous point.
   */
  it("moves on a touchmove that emits no wheel at all", () => {
    const armed = reduceTouch(NO_TOUCH_SCROLL, start(300), touchWorld()).state;
    const r = reduceTouch(armed, move(292, 16), touchWorld());
    expect(r.actions).toEqual([]);
    expect(r.state.emitY).toBe(292);
    expect(noteTouchEmit(NO_TOUCH_EMIT, r.state.emitY).y).toBe(292);
  });

  /**
   * The two ports' wheels are the same wheel once they share the coordinate,
   * which is what "one primitive" has to mean to be worth anything. The touch
   * arm hands back the module's own init and the trackpad arm builds one, so
   * this is the assertion that they cannot drift apart.
   */
  it("emits the same wheel from either scroller at the same point", () => {
    const armed = reduceTouch(NO_TOUCH_SCROLL, start(300), touchWorld()).state;
    const r = reduceTouch(armed, move(280, 16), touchWorld());
    const point = noteTouchEmit(NO_TOUCH_EMIT, r.state.emitY);
    const fromFinger = touchWheels(armed, move(280, 16), touchWorld(), point);
    expect(fromFinger).toHaveLength(1);
    const fromTrackpad = wheelsFor({ kind: "emit", sign: 1, count: 1 }, point);
    expect(fromFinger[0]).toEqual(fromTrackpad[0]);
    expect(fromFinger[0]).toEqual(lineWheelAt(1, 280));
  });

  /**
   * The trackpad is a reader and never a writer, as `scrollLastEmitY` has
   * exactly one assignment in the page. `wheelsFor` takes the point by value and
   * hands nothing back, so there is no route by which a burst could move it.
   */
  it("is never written by the trackpad path", () => {
    let point: EmitPoint = NO_TOUCH_EMIT;
    let state = NO_WHEEL;
    for (const event of [spin({ deltaY: 120 }), { type: "frame" } as const]) {
      const r = reduceWheel(state, event, smoothWorld());
      state = r.state;
      for (const action of r.actions) {
        if (action.kind === "emit") wheelsFor(action, point);
      }
    }
    expect(point).toBe(NO_TOUCH_EMIT);
    point = noteTouchEmit(point, EMIT_Y_SEED);
    expect(point).toBe(NO_TOUCH_EMIT);
  });

  /**
   * Identity when the y did not move. A coast reuses the drag's last y for every
   * frame it runs, so this is the common case rather than a curiosity.
   */
  it("allocates nothing when the y has not moved", () => {
    const moved = noteTouchEmit(NO_TOUCH_EMIT, 250);
    expect(noteTouchEmit(moved, 250)).toBe(moved);
    expect(noteTouchEmit(moved, 251)).not.toBe(moved);
  });

  /**
   * A drag hands the coast its last y, so the wheels a flick keeps emitting
   * after the finger has gone carry the point the finger left, not the seed.
   */
  it("keeps the lifted finger's y through the coast", () => {
    const lifted = play([start(300), move(280, 16), move(260, 32), end(32)]);
    expect(lifted.coast).not.toBeNull();
    const point = noteTouchEmit(NO_TOUCH_EMIT, lifted.emitY);
    expect(point.y).toBe(260);
    const coasting = touchWheels(lifted, { type: "frame", now: 48 }, touchWorld(), point);
    expect(coasting.length).toBeGreaterThan(0);
    for (const w of coasting) expect(w.clientY).toBe(260);
  });
});

describe("conflict 1: one primitive, two action shapes", () => {
  /**
   * The five constant fields, each of which is load-bearing. LINE mode with a
   * deltaY of one row is the only shape xterm neither damps nor collapses:
   * a sub-50px PIXEL delta is damped to 0.3x, and in mouse-tracking mode one DOM
   * event is at most one app report whatever its magnitude.
   */
  it("builds the page's wheel and nothing else", () => {
    expect(lineWheelAt(-1, 42)).toEqual({
      deltaY: -1,
      deltaMode: 1,
      bubbles: true,
      cancelable: true,
      clientX: 0,
      clientY: 42,
    });
    expect(DOM_DELTA_LINE).toBe(1);
  });

  /**
   * The count fans out into separate events, which is the whole mechanism: ten
   * events are ten app reports where one event carrying `deltaY: 10` is one.
   */
  it("turns a count into that many one-row wheels", () => {
    const wheels = wheelsFor({ kind: "emit", sign: -1, count: 4 }, NO_TOUCH_EMIT);
    expect(wheels).toHaveLength(4);
    for (const w of wheels) {
      expect(w.deltaY).toBe(-1);
      expect(w.deltaMode).toBe(1);
    }
  });

  /** The touch arm dispatches the module's own init, rather than rebuilding it. */
  it("passes a touch action's wheel through untouched", () => {
    const armed = reduceTouch(NO_TOUCH_SCROLL, start(300), touchWorld()).state;
    const r = reduceTouch(armed, move(280, 16), touchWorld());
    const action = r.actions[0];
    expect(action?.kind).toBe("wheel");
    if (action?.kind !== "wheel") return;
    expect(wheelsFor(action, NO_TOUCH_EMIT)[0]).toBe(action.wheel);
  });

  /**
   * No clamp here, as `emitLineWheel` has none. The cap belongs to the two
   * feeds, and each applies it while deciding, so a count above it is a module
   * bug rather than something to absorb silently.
   */
  it("applies no cap of its own", () => {
    expect(wheelsFor({ kind: "emit", sign: 1, count: 12 }, NO_TOUCH_EMIT)).toHaveLength(12);
  });

  /** And neither module ever asks for more than the cap. */
  it("is never asked for more than the cap by the trackpad", () => {
    const armed = reduceWheel(NO_WHEEL, spin({ deltaY: 100000 }), smoothWorld());
    const wheels = wheelEmissions(armed.state, { type: "frame" }, smoothWorld(), NO_TOUCH_EMIT);
    expect(wheels).toHaveLength(SCROLL_MAX_EVENTS_PER_FEED);
  });

  it("is never asked for more than the cap by the finger", () => {
    const armed = reduceTouch(NO_TOUCH_SCROLL, start(1000), touchWorld()).state;
    const wheels = touchWheels(armed, move(0, 16), touchWorld(), NO_TOUCH_EMIT);
    expect(wheels).toHaveLength(SCROLL_MAX_EVENTS_PER_FEED);
  });

  /**
   * A count neither module can produce still must not throw: this runs inside
   * xterm's wheel handler, where an exception costs the whole scroll rather than
   * one event. `new Array(count)` would raise a RangeError on a negative.
   */
  it("returns nothing rather than throwing on a count no module produces", () => {
    expect(wheelsFor({ kind: "emit", sign: 1, count: 0 }, NO_TOUCH_EMIT)).toEqual([]);
    expect(wheelsFor({ kind: "emit", sign: 1, count: -3 }, NO_TOUCH_EMIT)).toEqual([]);
  });
});

describe("conflict 2: one home for the per-frame cap", () => {
  /**
   * The page had one constant and four spends of it, two in each scroller
   * (:6082). The two ports each declared their own copy and both re-export this
   * one instead, so the three names below are one number. A port that
   * re-declared its own copy and quietly raised it hands back the multi-second
   * runaway coast the number was tuned to stop, which is what this holds down.
   *
   * The value itself was checked against the page's declaration until the page
   * was deleted; the literal is pinned below instead.
   */
  it("is the number the page was tuned to", () => {
    // term.html:6082, `const SCROLL_MAX_EVENTS_PER_FEED = 10;`, with the
    // comment "burst cap: one frame can't spray hundreds of events".
    expect(SCROLL_MAX_EVENTS_PER_FEED).toBe(10);
  });

  it("agrees with both modules' copies", () => {
    expect(TOUCH_CAP).toBe(SCROLL_MAX_EVENTS_PER_FEED);
    expect(WHEEL_CAP).toBe(SCROLL_MAX_EVENTS_PER_FEED);
  });

});

describe("conflict 3: one box, two freshness rules, so the read is lazy per field", () => {
  /**
   * THE ASSERTION THAT KEEPS THIS FIXED. A world nobody read has measured
   * nothing. Collapse the getters into a plain object and this is the case that
   * goes red, which is the only thing standing between touchscroll's "never
   * measure the screen box on a touchmove" and a shared reader that measures
   * both up front and satisfies every type signature while doing it.
   */
  it("measures nothing until a field is read", () => {
    const s = spy(SCREEN_H);
    const w = wheelWorld(s.geometry, { speed: 1, smoothOn: true, mounted: true });
    const t = touchScrollWorld(s.geometry, { scrollSpeed: 1, momentum: true, mounted: true });
    expect(s.measured()).toBe(0);
    expect(w.mounted).toBe(true);
    expect(t.momentum).toBe(true);
    expect(s.measured()).toBe(0);
  });

  /** One box, so whichever field asks first pays and the other reads for free. */
  it("measures the box once, whichever field asks first", () => {
    const first = spy(SCREEN_H);
    expect(first.geometry.screenHeightPx).toBe(SCREEN_H);
    expect(first.geometry.cellHeightPx).toBe(CELL_H);
    expect(first.measured()).toBe(1);

    const second = spy(SCREEN_H);
    expect(second.geometry.cellHeightPx).toBe(CELL_H);
    expect(second.geometry.cellHeightPx).toBe(CELL_H);
    expect(second.geometry.screenHeightPx).toBe(SCREEN_H);
    expect(second.measured()).toBe(1);
  });

  /**
   * What the eager shape costs, spelled out rather than asserted about. Both of
   * these are worlds a wiring could plausibly write, and both measure the box
   * before anything has asked a question.
   */
  it("shows what a spread or an eager literal would have cost", () => {
    const spread = spy(SCREEN_H);
    const asSpread: TouchScrollWorld = {
      ...spread.geometry,
      scrollSpeed: 1,
      momentum: true,
      mounted: true,
    };
    expect(spread.measured()).toBe(1);
    expect(asSpread.screenHeightPx).toBe(SCREEN_H);

    const eager = spy(SCREEN_H);
    const asLiteral: WheelWorld = {
      cellH: eager.geometry.cellHeightPx,
      screenH: eager.geometry.screenHeightPx,
      speed: 1,
      smoothOn: true,
      mounted: true,
    };
    expect(eager.measured()).toBe(1);
    expect(asLiteral.cellH).toBe(CELL_H);
  });

  /**
   * The trackpad's pass-through set, which is most of the wheels a page sees:
   * our own synthetic emissions, a Ctrl-zoom, a Shift-horizontal. term.html
   * measures nothing for any of them either, because the reads sit past the
   * gates.
   */
  it.each([
    ["an untrusted synthetic wheel", spin({ isTrusted: false, deltaY: 120 })],
    ["a zoom wheel", spin({ ctrlKey: true, deltaY: 120 })],
    ["a horizontal swipe", spin({ deltaX: 200, deltaY: 10 })],
  ])("measures nothing for %s", (_name, event) => {
    const s = spy(SCREEN_H);
    const world = wheelWorld(s.geometry, { speed: 1, smoothOn: true, mounted: true });
    reduceWheel(NO_WHEEL, event, world);
    expect(s.measured()).toBe(0);
    expect(s.cellReads()).toBe(0);
    expect(s.screenReads()).toBe(0);
  });

  /**
   * A pixel wheel reads the cell height for its accumulator cap and never the
   * screen box, which is wheel.ts's rule: `screenH` is for a DOM_DELTA_PAGE
   * wheel only.
   */
  it("reads the cell height and not the screen box on a pixel wheel", () => {
    const s = spy(SCREEN_H);
    reduceWheel(
      NO_WHEEL,
      spin({ deltaY: 120 }),
      wheelWorld(s.geometry, { speed: 1, smoothOn: true, mounted: true }),
    );
    expect(s.cellReads()).toBe(1);
    expect(s.screenReads()).toBe(0);
    expect(s.measured()).toBe(1);
  });

  /** And a page wheel is the one that does need it, so the getter is not dead. */
  it("reads the screen box on a page-mode wheel", () => {
    const s = spy(SCREEN_H);
    reduceWheel(
      NO_WHEEL,
      spin({ deltaY: 1, deltaMode: DOM_DELTA_PAGE }),
      wheelWorld(s.geometry, { speed: 1, smoothOn: true, mounted: true }),
    );
    expect(s.screenReads()).toBe(1);
    expect(s.measured()).toBe(1);
  });

  /**
   * THE TOUCHMOVE RULE, in its live form. A feeding move reads the row size and
   * must not reach the screen box: this is the hot path, and a box read there
   * forces a layout against a grid xterm is writing into.
   */
  it("never reads the screen box on a touchmove", () => {
    const armed = reduceTouch(NO_TOUCH_SCROLL, start(300), touchWorld()).state;
    const s = spy(SCREEN_H);
    reduceTouch(
      armed,
      move(260, 16),
      touchScrollWorld(s.geometry, { scrollSpeed: 1, momentum: true, mounted: true }),
    );
    expect(s.cellReads()).toBe(1);
    expect(s.screenReads()).toBe(0);
  });

  /** A move that decided nothing measures nothing at all. */
  it("measures nothing on a touchmove a second finger took", () => {
    const armed = reduceTouch(NO_TOUCH_SCROLL, start(300), touchWorld()).state;
    const s = spy(SCREEN_H);
    reduceTouch(
      armed,
      move(260, 16, 2),
      touchScrollWorld(s.geometry, { scrollSpeed: 1, momentum: true, mounted: true }),
    );
    expect(s.measured()).toBe(0);
  });

  /**
   * The lift is where the screen box is finally wanted, and only if a coast
   * actually starts: the velocity gate reads the cell height and returns before
   * the coast cap is measured. Three lifts, three different answers, which is
   * why one `readGeometry()` measuring both per event was never going to do.
   *
   * Two cell reads, because term.html has two: the gate at :6551 and
   * `startScrollMomentum`'s own `xtermCellH()` for the stop speed (:6150). With
   * the screen box at :6156 that is three `getBoundingClientRect` calls on this
   * one lift, where the memo pays for one.
   */
  it("reads the screen box at a lift that coasts", () => {
    const flicked = play([start(300), move(280, 16), move(260, 32)]);
    const s = spy(SCREEN_H);
    const r = reduceTouch(
      flicked,
      end(32),
      touchScrollWorld(s.geometry, { scrollSpeed: 1, momentum: true, mounted: true }),
    );
    expect(r.state.coast).not.toBeNull();
    expect(s.cellReads()).toBe(2);
    expect(s.screenReads()).toBe(1);
    expect(s.measured()).toBe(1);
  });

  it("stops at the cell height when the flick is too slow to coast", () => {
    const slow = play([start(300), move(292, 16)]);
    const s = spy(SCREEN_H);
    const r = reduceTouch(
      slow,
      end(16),
      touchScrollWorld(s.geometry, { scrollSpeed: 1, momentum: true, mounted: true }),
    );
    expect(r.state.coast).toBeNull();
    expect(s.cellReads()).toBe(1);
    expect(s.screenReads()).toBe(0);
  });

  it("measures nothing at a lift with momentum turned off", () => {
    const flicked = play([start(300), move(280, 16), move(260, 32)]);
    const s = spy(SCREEN_H);
    reduceTouch(
      flicked,
      end(32),
      touchScrollWorld(s.geometry, { scrollSpeed: 1, momentum: false, mounted: true }),
    );
    expect(s.measured()).toBe(0);
  });

  /**
   * The memo is what makes a geometry a one-event object, and the component
   * builds one per event for that reason. A hoisted geometry would answer a
   * later event with an earlier box, which the header says and this pins.
   */
  it("answers a second read from the first measurement", () => {
    let height = SCREEN_H;
    const geometry = screenGeometry(() => height, ROWS);
    expect(geometry.cellHeightPx).toBe(CELL_H);
    height = 800;
    expect(geometry.cellHeightPx).toBe(CELL_H);
    expect(screenGeometry(() => height, ROWS).cellHeightPx).toBe(800 / ROWS);
  });
});

describe("the fallbacks the page falls back to", () => {
  /**
   * No screen element at all, which is `xtermCellH`'s bare 16 and
   * `xtermScreenH`'s `(term.rows || 24) * 16`. Both are reached without a second
   * call: learning there is nothing to measure is one call.
   */
  it("falls back with no screen element", () => {
    const s = spy(null);
    expect(s.geometry.cellHeightPx).toBe(FALLBACK_CELL_HEIGHT_PX);
    expect(s.geometry.screenHeightPx).toBe(ROWS * FALLBACK_CELL_HEIGHT_PX);
    expect(s.measured()).toBe(1);
  });

  /** And with neither a screen nor rows, the page assumes 24 of them. */
  it("assumes 24 rows with no screen and no rows", () => {
    const s = spy(null, 0);
    expect(s.geometry.screenHeightPx).toBe(FALLBACK_ROWS * FALLBACK_CELL_HEIGHT_PX);
    expect(FALLBACK_ROWS * FALLBACK_CELL_HEIGHT_PX).toBe(384);
  });

  /**
   * A screen that exists and has not laid out yet measures ZERO, not the
   * fallback and not NaN. Both scrollers rest on that: a feed taken at a row
   * size of 0 keeps its pixels rather than spending them, so the travel is not
   * thrown away.
   */
  it("measures an unlaid-out screen as zero", () => {
    const s = spy(0);
    expect(s.geometry.cellHeightPx).toBe(0);
    expect(s.geometry.screenHeightPx).toBe(0);
  });

  /**
   * The asymmetry between the two helpers, which is easy to lose in a port: the
   * cell height falls back when `term.rows` is falsy even with a screen present,
   * while the screen height answers with the box it measured whatever the rows
   * say.
   */
  it("keeps the two fallbacks the different shapes they are", () => {
    const s = spy(SCREEN_H, 0);
    expect(s.geometry.cellHeightPx).toBe(FALLBACK_CELL_HEIGHT_PX);
    expect(s.geometry.screenHeightPx).toBe(SCREEN_H);
  });

  /**
   * And the reason the port takes a resolver instead: the page found this box
   * with a DOCUMENT query, six times over, which it could afford at one
   * terminal per document: the two scroll helpers (:6095, :6099), the link
   * copy-chip's position (:5394), two hit-tests in the drag-selection reclaim
   * (:5961, :6051) and the pixel-size resize payload (:8323). The lobby keeps
   * every visited session mounted, so a document query here would hand every
   * terminal the first match, and a hidden one measures 0.
   */
  it("keeps the document query out of the port", () => {
    const source = readFileSync(resolve(__dirname, "../src/terminal/emit.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toContain("querySelector");
  });
});

describe("what the component is told to do", () => {
  const source = readFileSync(resolve(__dirname, "../src/terminal/emit.ts"), "utf8");
  const owes = (): string => {
    const at = source.indexOf("WHAT THE COMPONENT STILL OWES");
    const end = source.indexOf("WHERE THIS IS NOT term.html LINE FOR LINE", at);
    expect(at, "the owes list").toBeGreaterThan(-1);
    expect(end, "the end of the owes list").toBeGreaterThan(at);
    return source.slice(at, end);
  };

  /**
   * A pure module decides and the component performs, so this comment is the
   * only carrier for the two DOM calls this file exists to unify. A different
   * agent wires it, from this list.
   */
  it.each([
    ["the dispatch target", "term.element"],
    ["the constructor", "new WheelEvent"],
    ["the fan-out", "wheelsFor"],
    ["the coordinate's only writer", "r.state.emitY"],
    ["the seed", "NO_TOUCH_EMIT"],
    ["the resolver", ".xterm-screen"],
    ["the per-terminal scoping", "PER TERMINAL"],
    ["the one-event lifetime", "THE LIFETIME"],
  ])("names %s", (_name, needle) => {
    expect(owes()).toContain(needle);
  });

  /**
   * The two traps a wiring falls into on its own: a document query, which a
   * hidden terminal answers with 0, and recording the coordinate off a
   * dispatched action, which misses the moves that bank pixels without emitting.
   */
  it("names the document-query trap and what a hidden terminal measures", () => {
    const body = owes();
    expect(body).toContain("document query");
    expect(body).toContain("tl-hidden");
  });

  it("says the coordinate comes from the state and not from an action", () => {
    const body = owes();
    expect(body).toContain("STATE and not from a dispatched action");
    expect(body).toContain(":6522");
  });

  /** The mouse-only machine is a named value here, not an unstated default. */
  it("says what a terminal with no touch screen carries", () => {
    expect(source).toContain("THE MACHINE THAT HAS NO FINGER");
    const doc = source.slice(
      source.indexOf("Where a freshly mounted terminal starts"),
      source.indexOf("export const NO_TOUCH_EMIT"),
    );
    expect(doc).toContain("isCoarsePointer");
    expect(doc).toContain("never called");
  });
});

describe("pure, as every module under src/terminal is", () => {
  const source = readFileSync(resolve(__dirname, "../src/terminal/emit.ts"), "utf8");
  /** Comments stripped, so the header naming a DOM call is not read as one. */
  const code = (): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  /**
   * The file is about a `dispatchEvent` and a `getBoundingClientRect` and
   * contains neither, which is what lets the laziness above be tested at all: a
   * measurement behind a callback is a measurement a test can count.
   */
  it.each([
    ["the DOM", /\b(?:document|window|globalThis|navigator|location)\b/],
    ["an event", /\b(?:dispatchEvent|WheelEvent|addEventListener)\b/],
    ["a measurement", /getBoundingClientRect|querySelector/],
    ["a timer or a frame", /set(?:Timeout|Interval)\s*\(|requestAnimationFrame\s*\(/],
    ["a clock", /Date\.now|performance\.now/],
    ["a socket", /WebSocket|postMessage|fetch\s*\(/],
  ])("reaches for %s nowhere in its code", (_name, forbidden) => {
    expect(code()).not.toMatch(forbidden);
  });

  /** And it imports nothing at runtime, so it cannot cycle with the two modules it serves. */
  it("imports only types", () => {
    const imports = [...source.matchAll(/^import .*$/gm)].map((m) => m[0]);
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/^import type /);
  });
});
