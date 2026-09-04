import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DOM_DELTA_LINE,
  DOM_DELTA_PAGE,
  NO_WHEEL,
  SCROLL_MAX_EVENTS_PER_FEED,
  isSmoothOn,
  reduce,
  speedMultiplier,
  type SmoothWheelEvent,
  type WheelAction,
  type WheelFacts,
  type WheelReduction,
  type WheelState,
  type WheelWorld,
} from "../src/terminal/wheel";
import { PREF_DEFAULTS, WHEEL_SPEEDS } from "../src/store/prefs";

/**
 * The desktop smooth-wheel interceptor, as frontend/term.html:6172-6274 paid
 * for it.
 *
 * THE FAILURE BEHIND ALL OF IT. A trackpad emits a stream of small pixel
 * deltas. xterm 6 damps a sub-50px pixel wheel to x0.3 and, in mouse-tracking
 * mode, forwards at most one report per DOM wheel event with the magnitude
 * discarded, so tmux copy-mode receives a sparse trickle and jumps five lines
 * per surviving report. term.html captures the full pixel travel instead and
 * re-emits it as discrete one-row LINE wheels, paced a frame at a time. Each
 * test below is one rule that trade needs.
 */

/** 16px rows and a 24-row screen: the numbers every expectation here is in. */
const CELL_H = 16;
const SCREEN_H = CELL_H * 24;

/** Everything the component measures at the moment of an event. */
const world = (over: Partial<WheelWorld> = {}): WheelWorld => ({
  cellH: CELL_H,
  screenH: SCREEN_H,
  speed: 1,
  smoothOn: true,
  mounted: true,
  ...over,
});

/** A trusted, unmodified, vertical pixel wheel: what a trackpad sends. */
const wheel = (over: Partial<WheelFacts> = {}): WheelFacts => ({
  isTrusted: true,
  deltaX: 0,
  deltaY: 10,
  deltaMode: 0,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...over,
});

const spin = (over: Partial<WheelFacts> = {}): SmoothWheelEvent => ({
  type: "wheel",
  wheel: wheel(over),
});

const FRAME: SmoothWheelEvent = { type: "frame" };
const DETACHED: SmoothWheelEvent = { type: "detached" };

/** Takes a reduction or a whole run, since both carry the actions the same way. */
const kinds = (r: { readonly actions: readonly WheelAction[] }): string[] =>
  r.actions.map((a) => a.kind);

/** The signed number of rows a set of actions asks the component to emit. */
const rowsOf = (actions: readonly WheelAction[]): number =>
  actions.reduce((n, a) => (a.kind === "emit" ? n + a.sign * a.count : n), 0);

/** Feed a sequence of events through one state, collecting every action in order. */
function run(
  events: readonly SmoothWheelEvent[],
  w: WheelWorld = world(),
  from: WheelState = NO_WHEEL,
): { state: WheelState; actions: WheelAction[]; rows: number } {
  let state = from;
  const actions: WheelAction[] = [];
  for (const e of events) {
    const r = reduce(state, e, w);
    state = r.state;
    actions.push(...r.actions);
  }
  return { state, actions, rows: rowsOf(actions) };
}

/** `n` pixel wheels of `deltaY` each, then the single frame they scheduled. */
const burst = (n: number, deltaY: number): SmoothWheelEvent[] => [
  ...Array.from({ length: n }, () => spin({ deltaY })),
  FRAME,
];

describe("a pixel burst becomes a smaller number of line wheels", () => {
  /**
   * The headline case, and Viktor's original complaint. A Mac trackpad's
   * history scroll arrives as ten 5px events; raw, each one is damped to x0.3
   * and capped at one report, which measured as zero app events. Here the
   * travel survives whole and comes out as three undamped one-row wheels.
   */
  it("turns ten 5px wheels into three line wheels", () => {
    const r = run(burst(10, 5));
    expect(r.rows).toBe(3);
    expect(kinds(r)).toEqual(["schedule-frame", "emit"]);
  });

  /** One row of travel, one line wheel. The table is the whole conversion. */
  it.each([
    { travel: "a sub-row nudge", deltaY: 15, rows: 0 },
    { travel: "exactly one row", deltaY: 16, rows: 1 },
    { travel: "a row and a half", deltaY: 24, rows: 1 },
    { travel: "two rows", deltaY: 32, rows: 2 },
    { travel: "six and a quarter rows", deltaY: 100, rows: 6 },
  ])("$travel ($deltaY px)", ({ deltaY, rows }) => {
    expect(run([spin({ deltaY }), FRAME]).rows).toBe(rows);
  });

  /** Sign in, sign out. Down is +1 and up is -1, as emitLineWheel defines them. */
  it.each([
    { direction: "down", deltaY: 50, rows: 3 },
    { direction: "up", deltaY: -50, rows: -3 },
  ])("preserves the $direction direction", ({ deltaY, rows }) => {
    const r = run([spin({ deltaY }), FRAME]);
    expect(r.rows).toBe(rows);
    expect(r.actions).toContainEqual({
      kind: "emit",
      sign: rows < 0 ? -1 : 1,
      count: Math.abs(rows),
    });
  });

  /**
   * `count` separate one-row wheels, never one wheel carrying the count. In
   * mouse-tracking mode xterm forwards one report per DOM event, so a single
   * deltaY=3 event is one report and the de-damping would be undone.
   */
  it("asks for one emit action carrying a row count, not a multiplied delta", () => {
    const r: WheelReduction = reduce({ accumPx: 48, pumping: true }, FRAME, world());
    expect(r.actions).toEqual([{ kind: "emit", sign: 1, count: 3 }]);
  });
});

describe("the remainder carries across events", () => {
  /**
   * Slow scrolling is the case a naive `Math.round` per event loses entirely:
   * four 4px flicks are four sub-row deltas, and dropping each one means the
   * content never moves however long you scroll.
   */
  it("moves a row once four 4px wheels have added up to one", () => {
    const nudge = spin({ deltaY: 4 });
    const r = run([nudge, FRAME, nudge, FRAME, nudge, FRAME]);
    expect(r.rows).toBe(0);
    expect(r.state.accumPx).toBe(12);

    const last = run([spin({ deltaY: 4 }), FRAME], world(), r.state);
    expect(last.rows).toBe(1);
    expect(last.state.accumPx).toBe(0);
  });

  it("keeps a sub-row wheel's travel and asks for no more frames", () => {
    const r = run([spin({ deltaY: 4 }), FRAME]);
    expect(r.rows).toBe(0);
    expect(r.state).toEqual({ accumPx: 4, pumping: false });
  });

  /** Two identical bursts: the leftovers of the first are spent by the second. */
  it("carries the leftover of one burst into the next", () => {
    const first = run(burst(10, 5));
    expect(first.rows).toBe(3);
    expect(first.state.accumPx).toBe(2);

    const second = run(burst(10, 5), world(), first.state);
    expect(second.rows).toBe(3);
    expect(second.state.accumPx).toBe(4);
  });

  /** Math.trunc, not floor: an upward remainder must stay upward. */
  it("keeps a negative remainder negative", () => {
    const r = run([spin({ deltaY: -44 }), FRAME]);
    expect(r.rows).toBe(-2);
    expect(r.state.accumPx).toBe(-12);
  });
});

describe("what is passed through untouched", () => {
  /**
   * Every gate term.html:6229-6242 puts in front of the accumulator, in one
   * table. A pass-through must answer `true` to xterm, ask for nothing, and
   * leave the state IDENTICAL, so the hot path allocates nothing.
   */
  const PASSES: readonly [string, Partial<WheelFacts>, Partial<WheelWorld>][] = [
    [
      "our own synthetic line wheel",
      { isTrusted: false, deltaMode: DOM_DELTA_LINE, deltaY: -1 },
      {},
    ],
    ["a Shift wheel, which is horizontal", { shiftKey: true }, {}],
    ["a Ctrl wheel, which is zoom", { ctrlKey: true }, {}],
    ["a Cmd wheel, which is zoom", { metaKey: true }, {}],
    ["an Alt wheel", { altKey: true }, {}],
    ["a horizontal-dominant two-finger swipe", { deltaX: 40, deltaY: 10 }, {}],
    ["a horizontal-dominant swipe upward", { deltaX: -40, deltaY: 10 }, {}],
    ["a wheel with no vertical travel", { deltaY: 0 }, {}],
    ["a wheel whose delta is NaN", { deltaY: Number.NaN }, {}],
    [
      "a line wheel over an unlaid-out screen",
      { deltaMode: DOM_DELTA_LINE },
      { cellH: Number.NaN },
    ],
    [
      "a page wheel over an unlaid-out screen",
      { deltaMode: DOM_DELTA_PAGE },
      { screenH: Number.NaN },
    ],
    ["any wheel while the pref is off", {}, { smoothOn: false }],
    ["any wheel before xterm has an element", {}, { mounted: false }],
  ];

  it.each(PASSES)("passes through: %s", (_name, over, w) => {
    const state: WheelState = { accumPx: 7, pumping: false };
    const r = reduce(state, spin(over), world(w));
    expect(r.passToXterm).toBe(true);
    expect(r.actions).toEqual([]);
    expect(r.state).toBe(state);
  });

  /**
   * `Math.abs(deltaX) > Math.abs(deltaY)` and not `>=`: a perfectly diagonal
   * wheel is intercepted, which is term.html's reading. Stating it because the
   * two differ on exactly this event and a `>=` would hand diagonal scrolling
   * back to the damped path.
   */
  it("intercepts a wheel whose axes are equal", () => {
    const r = reduce(NO_WHEEL, spin({ deltaX: 20, deltaY: 20 }), world());
    expect(r.passToXterm).toBe(false);
  });

  it("tells xterm it handled a wheel it accumulated", () => {
    expect(reduce(NO_WHEEL, spin(), world()).passToXterm).toBe(false);
  });
});

describe("a wheel already in lines is converted once, not twice", () => {
  /**
   * The re-entrancy guard, and the reason the two scrollers can share one
   * emission primitive. Both emit `deltaMode: 1` wheels on the terminal
   * element, so those arrive back at this handler; converting them to px and
   * re-pacing them would be a double conversion and an unbounded loop.
   */
  it("passes an untrusted line wheel straight back to xterm", () => {
    const state: WheelState = { accumPx: 40, pumping: true };
    const r = reduce(
      state,
      spin({ isTrusted: false, deltaMode: DOM_DELTA_LINE, deltaY: 1 }),
      world(),
    );
    expect(r.passToXterm).toBe(true);
    expect(r.state).toBe(state);
    expect(r.actions).toEqual([]);
  });

  /**
   * A TRUSTED line wheel is a notched mouse, and it is normalized through px
   * (term.html:6239) rather than short-circuited. At the default speed the
   * travel comes back out unchanged in total: three lines in, three one-row
   * wheels out. The split is the fix rather than a side effect, since one
   * deltaY=3 event is one app report and three deltaY=1 events are three.
   */
  it("re-emits a trusted three-line wheel as three one-row wheels", () => {
    const r = run([spin({ deltaMode: DOM_DELTA_LINE, deltaY: 3 }), FRAME]);
    expect(r.actions).toEqual([{ kind: "schedule-frame" }, { kind: "emit", sign: 1, count: 3 }]);
    expect(r.state.accumPx).toBe(0);
  });

  it("scales a trusted line wheel by the speed pref like any other", () => {
    const r = run([spin({ deltaMode: DOM_DELTA_LINE, deltaY: 3 }), FRAME], world({ speed: 2 }));
    expect(r.rows).toBe(6);
  });
});

describe("page-mode wheels measure by the screen", () => {
  /** deltaMode 2 is one screenful, so it reads screenH and not cellH (:6240). */
  it("turns one page into as many rows as the screen holds", () => {
    const r = run([spin({ deltaMode: DOM_DELTA_PAGE, deltaY: 1 }), FRAME], world({ screenH: 80 }));
    expect(r.rows).toBe(5);
  });

  it("preserves the direction of a page-up wheel", () => {
    const r = run([spin({ deltaMode: DOM_DELTA_PAGE, deltaY: -1 }), FRAME], world({ screenH: 80 }));
    expect(r.rows).toBe(-5);
  });
});

describe("any other deltaMode is pixels", () => {
  /**
   * term.html's normalizer is a ternary chain testing `=== 1` then `=== 2`,
   * with the pixel arm as the fall-through (:6239-6241), so DOM_DELTA_PIXEL, a
   * mode past the two named ones, and a junk value all measure in px. Worth a
   * table because the other reading, treating an unknown mode as rows, would
   * multiply the travel by the cell height and scroll sixteen times too far.
   */
  it.each([
    { mode: "DOM_DELTA_PIXEL", deltaMode: 0 },
    { mode: "3, past both named modes", deltaMode: 3 },
    { mode: "99", deltaMode: 99 },
    { mode: "a negative mode", deltaMode: -1 },
    { mode: "NaN", deltaMode: Number.NaN },
  ])("reads $mode as pixels", ({ deltaMode }) => {
    expect(run([spin({ deltaMode, deltaY: 100 }), FRAME]).rows).toBe(6);
  });
});

describe("the burst cap: surplus is dropped, not queued", () => {
  /**
   * There is no JS momentum on the desktop wheel by design, so the accumulator
   * must never hold more than one frame drains. Uncapped, term.html measured a
   * hard flick or a coalesced delta backlogging into a multi-second coast that
   * kept scrolling after the fingers stopped.
   */
  it("caps a hard flick at one frame's worth of rows", () => {
    const r = run([spin({ deltaY: 5000 }), FRAME]);
    expect(r.rows).toBe(SCROLL_MAX_EVENTS_PER_FEED);
    expect(r.state.pumping).toBe(false);
    expect(Math.abs(r.state.accumPx)).toBeLessThan(CELL_H);
  });

  it("caps an upward flick the same way", () => {
    expect(run([spin({ deltaY: -5000 }), FRAME]).rows).toBe(-SCROLL_MAX_EVENTS_PER_FEED);
  });

  it("does not let two flicks in one frame queue twice the rows", () => {
    const r = run([spin({ deltaY: 5000 }), spin({ deltaY: 5000 }), FRAME]);
    expect(r.rows).toBe(SCROLL_MAX_EVENTS_PER_FEED);
  });

  /**
   * The pump clamps `k` as well as the wheel clamping the accumulator, and the
   * second clamp bites whenever the row size SHRANK between the wheel and the
   * frame it scheduled. The wheel's cap is ten rows measured at the wheel's
   * numbers and the pump's rows are measured at the frame's, so the same
   * numbers at both ends make the two caps agree. A speed rise is one route.
   */
  it("clamps the drain when the speed grew since the wheel was accumulated", () => {
    const fast = reduce(NO_WHEEL, spin({ deltaY: 5000 }), world());
    expect(fast.state.accumPx).toBe(SCROLL_MAX_EVENTS_PER_FEED * CELL_H);

    const drain = reduce(fast.state, FRAME, world({ speed: 3 }));
    expect(rowsOf(drain.actions)).toBe(SCROLL_MAX_EVENTS_PER_FEED);
    expect(drain.state.pumping).toBe(true);
    expect(drain.state.accumPx).toBeCloseTo(SCROLL_MAX_EVENTS_PER_FEED * (CELL_H - CELL_H / 3), 6);
  });

  /**
   * The other route to the same clamp, with the speed pref untouched: the CELL
   * HEIGHT shrank. A font change or a resize between the wheel and its frame is
   * enough, because `onFrame` re-derives the row size rather than carrying the
   * wheel's (:6214). Stated because the header used to name a speed change as
   * the only way in.
   */
  it("clamps the drain when the cell height shrank, at an unchanged speed", () => {
    const wheeled = reduce(NO_WHEEL, spin({ deltaY: 5000 }), world());
    expect(wheeled.state.accumPx).toBe(SCROLL_MAX_EVENTS_PER_FEED * CELL_H);

    const drain = reduce(wheeled.state, FRAME, world({ cellH: CELL_H / 2 }));
    expect(rowsOf(drain.actions)).toBe(SCROLL_MAX_EVENTS_PER_FEED);
    expect(drain.state).toEqual({
      accumPx: SCROLL_MAX_EVENTS_PER_FEED * (CELL_H / 2),
      pumping: true,
    });
  });

  /**
   * The cap is ten CELL heights even for a page wheel: `capPx` is
   * `10 * (cellH / speed)` (:6254) and never reads screenH. A tall screen makes
   * a page wheel's travel enormous, and it gets the same ten rows any other
   * flick gets. The page-mode tests above use an 80px screen, which is under
   * the cap, so this arm was never exercised.
   */
  it("caps a page wheel by the cell height, not the screen height", () => {
    const r = run(
      [spin({ deltaMode: DOM_DELTA_PAGE, deltaY: 1 }), FRAME],
      world({ screenH: 5000 }),
    );
    expect(r.rows).toBe(SCROLL_MAX_EVENTS_PER_FEED);
    expect(r.state).toEqual(NO_WHEEL);
  });

  /**
   * What the cap does on an unlaid-out screen, which is a ZERO cell height and
   * so a ZERO cap: `10 * (0 / speed)`. A pixel wheel is the only mode that gets
   * past `!px` there, since its px is the raw deltaY rather than a multiple of
   * the cell height, and the cap then clamps the whole travel away. Stated
   * because the clamp's header used to claim this case produced a NaN cap that
   * the two-ifs shape LEAVES ALONE. It is the opposite: a zero cap discards
   * everything.
   */
  it("clamps a pixel wheel to zero on an unlaid-out screen", () => {
    const blind = world({ cellH: 0, screenH: 0 });
    const wheeled = reduce(NO_WHEEL, spin({ deltaY: 100 }), blind);
    expect(wheeled.state).toEqual({ accumPx: 0, pumping: true });
    expect(kinds(wheeled)).toEqual(["schedule-frame"]);
    expect(reduce(wheeled.state, FRAME, blind).actions).toEqual([]);
  });

  /**
   * The one case where two ifs and a `Math.min`/`Math.max` pair differ, kept
   * because :6255-6256 is two ifs. A NaN cap leaves the accumulator alone,
   * where `Math.min(100, NaN)` would poison it. No cell height the page's own
   * measurement can return makes the cap NaN, and it does not matter which way
   * this goes anyway: the frame refuses to divide by a NaN row size and drops
   * the travel, so both shapes emit nothing.
   */
  it("leaves the accumulator alone under a NaN cap, and still emits nothing", () => {
    const nan = world({ cellH: Number.NaN });
    const wheeled = reduce(NO_WHEEL, spin({ deltaY: 100 }), nan);
    expect(wheeled.state).toEqual({ accumPx: 100, pumping: true });

    const drain = reduce(wheeled.state, FRAME, nan);
    expect(drain.actions).toEqual([]);
    expect(drain.state).toEqual(NO_WHEEL);
  });
});

describe("the frame, which the component owns", () => {
  it("asks for one frame per burst, not one per wheel", () => {
    const r = run(burst(10, 5));
    expect(kinds(r).filter((k) => k === "schedule-frame")).toHaveLength(1);
  });

  it("asks for another frame while a row of travel is still owed", () => {
    const r = reduce({ accumPx: 200, pumping: true }, FRAME, world());
    expect(kinds(r)).toEqual(["emit", "schedule-frame"]);
    expect(r.state.pumping).toBe(true);
  });

  it("stops asking once less than a row remains", () => {
    const r = reduce({ accumPx: 20, pumping: true }, FRAME, world());
    expect(kinds(r)).toEqual(["emit"]);
    expect(r.state).toEqual({ accumPx: 4, pumping: false });
  });

  it("emits nothing and stops when a frame finds no travel", () => {
    const r = reduce({ accumPx: 0, pumping: true }, FRAME, world());
    expect(r.actions).toEqual([]);
    expect(r.state).toEqual(NO_WHEEL);
  });

  /**
   * A frame nobody asked for drains exactly like one that was asked for:
   * term.html's `pumpWheel` (:6212-6224) has no outstanding-frame guard either,
   * because nothing else can call it. The header tells the component not to feed
   * one, and this pins what happens if it does, since a wiring bug there would
   * otherwise surface as travel going missing rather than as an error.
   */
  it("drains a frame it never asked for the same as one it did", () => {
    const asked = reduce({ accumPx: 48, pumping: true }, FRAME, world());
    const unasked = reduce({ accumPx: 48, pumping: false }, FRAME, world());
    expect(rowsOf(unasked.actions)).toBe(3);
    expect(unasked.actions).toEqual(asked.actions);
    expect(unasked.state).toEqual(asked.state);
  });

  /**
   * A frame that cannot work out a row height has nothing to divide by, and
   * term.html DROPS the accumulator there rather than carrying travel measured
   * against a size that no longer applies. `!(rowPx > 0)` and not `!== 0`, so a
   * NaN and a negative are refused with the zero. Zero is the case that
   * actually arises: `xtermCellH` is `height / term.rows` (:6094-6097), so an
   * unlaid-out screen measures 0 rather than NaN, which the parity block pins.
   */
  it.each([
    ["an unlaid-out screen, which measures zero", { cellH: 0 }],
    ["a NaN row height, which no measurement produces", { cellH: Number.NaN }],
    ["a negative row height", { cellH: -16 }],
    ["an xterm with no element", { mounted: false }],
  ])("drops the accumulated travel on %s", (_name, w) => {
    const r = reduce({ accumPx: 200, pumping: true }, FRAME, world(w));
    expect(r.actions).toEqual([]);
    expect(r.state).toEqual(NO_WHEEL);
  });

  /**
   * The pump deliberately does not re-read the pref. term.html cancels the
   * pending frame from the pref path instead (:6271), so a frame that survives
   * a pref change is one nobody cancelled, and draining it is what term.html
   * does. A `smoothOn` test here would be a divergence, not a tidy-up.
   */
  it("drains a frame that outlived the pref rather than testing the pref", () => {
    const r = reduce({ accumPx: 48, pumping: true }, FRAME, world({ smoothOn: false }));
    expect(rowsOf(r.actions)).toBe(3);
  });

  /** The frame is spent as soon as it runs, whatever else it decides (:6213). */
  it("clears the pumping flag before deciding whether to re-arm", () => {
    expect(reduce({ accumPx: 8, pumping: true }, FRAME, world()).state.pumping).toBe(false);
  });
});

describe("one frame outstanding, and every re-arm honoured", () => {
  /**
   * `pumping` means "a frame is outstanding", and the only way to check that
   * claim is to BE the component: perform every action in order, hold one frame
   * handle, and feed a `frame` for each `schedule-frame`. The assertion inside
   * the loop is the invariant the header promises, and it is what the wheel
   * case's `!state.pumping` guard and the frame case's re-arm add up to.
   *
   * The wiring this catches: a component that gated `schedule-frame` on the
   * returned `pumping` being FALSE, which an earlier draft of the owes list
   * invited, drops every re-arm the frame case asks for, so a burst bigger than
   * one frame stalls with travel still owed.
   */
  function drive(
    events: readonly SmoothWheelEvent[],
    w: WheelWorld = world(),
    from: WheelState = NO_WHEEL,
  ): { state: WheelState; rows: number; frames: number } {
    let state = from;
    let outstanding = from.pumping;
    let rows = 0;
    let frames = 0;
    const queue: SmoothWheelEvent[] = [...events];
    let step = 0;
    for (let event = queue.shift(); event !== undefined; event = queue.shift()) {
      step += 1;
      expect(step, "the drain terminates").toBeLessThan(100);
      if (event.type === "frame") {
        // The component feeds a frame only for one it asked for, and the handle
        // is spent the moment the callback runs (term.html:6213).
        expect(outstanding, "a frame was fed with none outstanding").toBe(true);
        outstanding = false;
        frames += 1;
      }
      const r = reduce(state, event, w);
      state = r.state;
      for (const action of r.actions) {
        if (action.kind === "emit") rows += action.sign * action.count;
        if (action.kind === "schedule-frame") {
          expect(outstanding, "two frames outstanding at once").toBe(false);
          outstanding = true;
          queue.push(FRAME);
        }
        if (action.kind === "cancel-frame") {
          expect(outstanding, "cancelled a frame nobody asked for").toBe(true);
          outstanding = false;
          const queued = queue.indexOf(FRAME);
          expect(queued, "the cancelled frame was queued").toBeGreaterThan(-1);
          queue.splice(queued, 1);
        }
      }
      expect(outstanding, "pumping tracks the frame handle").toBe(state.pumping);
    }
    return { state, rows, frames };
  }

  /**
   * A burst accumulated at one row size and drained at a smaller one, which is
   * the only way past a single frame: with the same numbers at both ends the
   * wheel's cap is exactly what one frame spends. 160px is what a capped flick
   * leaves at speed 1, and at speed 3 it is worth 30 rows, so it takes three
   * frames and two of them come from the frame case re-arming while `pumping`
   * is true. Each re-arm is the action a component must not gate on that flag.
   */
  it("spends a capped flick over as many frames as it takes", () => {
    const held: WheelState = { accumPx: SCROLL_MAX_EVENTS_PER_FEED * CELL_H, pumping: true };
    const r = drive([FRAME], world({ speed: 3 }), held);
    expect(r.rows).toBe(3 * SCROLL_MAX_EVENTS_PER_FEED);
    expect(r.frames).toBe(3);
    expect(r.state.pumping).toBe(false);
    expect(Math.abs(r.state.accumPx)).toBeLessThan(1e-9);
  });

  /** One wheel, one frame, with the numbers unchanged: the two caps agree. */
  it("spends a capped flick in one frame when nothing changed", () => {
    const r = drive([spin({ deltaY: 5000 })], world({ speed: 3 }));
    expect(r.rows).toBe(SCROLL_MAX_EVENTS_PER_FEED);
    expect(r.frames).toBe(1);
    expect(r.state.pumping).toBe(false);
  });

  /** The same invariant through a pass-through and a detach, which move the handle. */
  it("holds the invariant across a burst, a passed-through wheel and a detach", () => {
    const r = drive([
      spin({ deltaY: 5 }),
      spin({ shiftKey: true, deltaY: 400 }),
      spin({ deltaY: 5 }),
      DETACHED,
      spin({ deltaY: 100 }),
    ]);
    expect(r.frames).toBe(1);
    expect(r.rows).toBe(6);
    expect(r.state).toEqual({ accumPx: 4, pumping: false });
  });
});

describe("the pref that turns the whole thing off", () => {
  /** The master kill and the pref, ANDed, and either one alone is enough to stop it. */
  it.each([
    { gesturesEnabled: true, wheelSmooth: true, on: true },
    { gesturesEnabled: true, wheelSmooth: false, on: false },
    { gesturesEnabled: false, wheelSmooth: true, on: false },
    { gesturesEnabled: false, wheelSmooth: false, on: false },
  ])(
    "gestures $gesturesEnabled and wheelSmooth $wheelSmooth leaves it on: $on",
    ({ gesturesEnabled, wheelSmooth, on }) => {
      expect(isSmoothOn({ gesturesEnabled, wheelSmooth })).toBe(on);
    },
  );

  it("forgets the accumulated travel and cancels the pending frame on detach", () => {
    const r = reduce({ accumPx: 90, pumping: true }, DETACHED, world());
    expect(r.actions).toEqual([{ kind: "cancel-frame" }]);
    expect(r.state).toEqual(NO_WHEEL);
  });

  it("cancels nothing when no frame was outstanding", () => {
    const r = reduce({ accumPx: 90, pumping: false }, DETACHED, world());
    expect(r.actions).toEqual([]);
    expect(r.state).toEqual(NO_WHEEL);
  });

  /**
   * What a MISSING `detached` event costs, which is why the owes list calls it
   * the non-optional half. term.html's pref path does three things at
   * :6269-6271: detach, zero the accumulator, cancel the pending frame. A
   * component that flips the pref off and keeps the handler attached, feeding
   * no `detached`, has done only the first, and the frame case deliberately
   * does not re-read the pref, so a full frame of rows reaches the app after
   * the pref went off. term.html emits none.
   */
  it("emits a whole frame after the pref went off when no detach was fed", () => {
    const loaded: WheelState = { accumPx: SCROLL_MAX_EVENTS_PER_FEED * CELL_H, pumping: true };
    const off = world({ smoothOn: false });

    const kept = reduce(loaded, FRAME, off);
    expect(rowsOf(kept.actions)).toBe(SCROLL_MAX_EVENTS_PER_FEED);

    const detached = reduce(loaded, DETACHED, off);
    expect(detached.actions).toEqual([{ kind: "cancel-frame" }]);
    expect(reduce(detached.state, FRAME, off).actions).toEqual([]);
  });

  /**
   * What the NEXT wheel does with a detached state, which the two tests above
   * do not reach: it starts from zero rather than from travel accumulated
   * before the pref went off, and it asks for a fresh frame because the
   * cancelled one is gone. That is the whole reason the detach drops the
   * accumulator instead of keeping it.
   */
  it("starts the next wheel from zero after a detach", () => {
    const r = run([DETACHED, spin({ deltaY: 100 }), FRAME], world(), {
      accumPx: 90,
      pumping: true,
    });
    expect(kinds(r)).toEqual(["cancel-frame", "schedule-frame", "emit"]);
    expect(r.rows).toBe(6);
    expect(r.state).toEqual({ accumPx: 4, pumping: false });
  });

  /**
   * Raw passthrough while off, and the state must not creep: a burst scrolled
   * with the pref off cannot leave travel behind that a later re-enable
   * suddenly emits. Each wheel hands its state back by identity, so a component
   * comparing states does no work per event either.
   */
  it("leaves the state where it was through a whole burst with the pref off", () => {
    const off = world({ smoothOn: false });
    let state: WheelState = NO_WHEEL;
    for (const e of burst(10, 5)) {
      const r = reduce(state, e, off);
      expect(r.actions).toEqual([]);
      if (e.type === "wheel") expect(r.state).toBe(state);
      state = r.state;
    }
    expect(state).toEqual(NO_WHEEL);
  });
});

describe("the speed multiplier", () => {
  it.each(WHEEL_SPEEDS)("accepts the shipped speed %s", (speed) => {
    expect(speedMultiplier(speed)).toBe(speed);
  });

  /**
   * A roamed prefs doc can carry anything, and term.html holds no validated
   * copy: `wheelSpeedMult()` (:6206-6209) is called fresh at each of its two
   * sites, :6214 and :6254. An unvalidated 0 would make rowPx infinite and stop
   * the terminal scrolling at all.
   */
  it.each([0, -1, 2.5, 4, 100, Number.NaN, Number.POSITIVE_INFINITY])(
    "falls back to 1 for %s",
    (bad) => {
      expect(speedMultiplier(bad)).toBe(1);
    },
  );

  /**
   * The fallback holds at BOTH sites, the wheel's cap and the frame's row size,
   * so a roamed junk value scrolls exactly like the default rather than doing
   * something of its own.
   */
  it.each([0, -3, 2.5, Number.NaN])("scrolls like speed 1 for a roamed %s", (bad) => {
    const bogus = run([spin({ deltaY: 100 }), FRAME], world({ speed: bad }));
    const one = run([spin({ deltaY: 100 }), FRAME], world({ speed: 1 }));
    expect(bogus.rows).toBe(one.rows);
    expect(bogus.state).toEqual(one.state);
  });

  /**
   * What a negative row size actually does, since the header used to say it
   * would invert the direction. It never reaches the screen: on the wheel path
   * a negative `capPx` flips the accumulator's SIGN (:6255-6256), and the frame
   * then refuses to divide by a negative row size and drops the travel (:6215),
   * so nothing is emitted in either direction. The speed is validated, so this
   * is reachable through the cell height, which is measured rather than
   * validated.
   */
  it("emits nothing in either direction when the row size is negative", () => {
    const negative = world({ cellH: -CELL_H });
    const wheeled = reduce(NO_WHEEL, spin({ deltaY: 100 }), negative);
    expect(wheeled.state.accumPx).toBe(-SCROLL_MAX_EVENTS_PER_FEED * CELL_H);

    const drain = reduce(wheeled.state, FRAME, negative);
    expect(drain.actions).toEqual([]);
    expect(drain.state).toEqual(NO_WHEEL);
  });

  /** wheelSpeed is line wheels per row-height, so 3 triples the rows per px. */
  it.each([
    { speed: 1, rows: 1 },
    { speed: 1.5, rows: 1 },
    { speed: 2, rows: 2 },
    { speed: 3, rows: 3 },
  ])("at speed $speed, one row-height of travel is worth $rows rows", ({ speed, rows }) => {
    expect(run([spin({ deltaY: CELL_H }), FRAME], world({ speed })).rows).toBe(rows);
  });

  /** 1.5 is a half-row rate: one row per row-height, three per two. */
  it("emits three rows for two rows of travel at speed 1.5", () => {
    expect(run([spin({ deltaY: CELL_H * 2 }), FRAME], world({ speed: 1.5 })).rows).toBe(3);
  });
});

describe("what the component is told to do", () => {
  const source = readFileSync(resolve(__dirname, "../src/terminal/wheel.ts"), "utf8");
  const owes = (): string => {
    const start = source.indexOf("WHAT THE COMPONENT STILL OWES");
    const end = source.indexOf("WHAT THE COMPONENT MUST READ", start);
    expect(start, "the owes list").toBeGreaterThan(-1);
    expect(end, "the end of the owes list").toBeGreaterThan(start);
    return source.slice(start, end);
  };

  /**
   * A pure module decides and the component performs, so this comment is the
   * only carrier for the DOM work, and a different agent wires it. An action
   * missing from that list is one nobody performs.
   */
  it.each(["emit", "schedule-frame", "cancel-frame"])("describes what to do with %s", (kind) => {
    expect(owes()).toContain(kind);
  });

  /**
   * The details that make the difference between de-damping and doing nothing:
   * separate dispatches beat xterm's one-report cap, one frame at a time keeps
   * the pacing, the state is per terminal because the lobby mounts several, and
   * the return value is the whole suppression contract.
   */
  it.each([
    "emitLineWheel",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "clientY",
    "PER TERMINAL",
    "passToXterm",
    "preventDefault",
  ])("names %s among the wiring it depends on", (needle) => {
    expect(owes()).toContain(needle);
  });

  /**
   * The frame case re-arms with `pumping` TRUE in the state it returns, so a
   * component that read this entry as "only while pumping is false" and guarded
   * the rAF on it would drop every re-arm. The list must not invite that
   * reading, which an earlier draft did.
   */
  it("tells the component to schedule a frame unconditionally", () => {
    const section = owes();
    const entry = section.slice(
      section.indexOf("schedule-frame"),
      section.indexOf("cancel-frame"),
    );
    expect(entry).toContain("unconditionally");
    expect(entry).not.toMatch(/only ever asked for while/);
  });

  /**
   * The `detached` event is the only carrier of the accumulator reset and the
   * frame cancel (term.html:6270-6271), so the "keep the handler attached
   * instead" escape hatch covers the DETACH alone. An earlier draft offered it
   * as an alternative to the whole clause, and a component reading it that way
   * keeps a live rAF and a loaded accumulator across the toggle, which the
   * behaviour test above shows draining into emissions after the pref went off.
   */
  it("owes the detached event even from a component that cannot detach", () => {
    const section = owes();
    const entry = section.slice(section.indexOf("THE ATTACH AND DETACH"));
    expect(entry, "the attach/detach entry").toContain("cancelAnimationFrame");
    expect(entry).toContain("only the detach is optional");
    expect(entry).not.toMatch(/may keep the handler attached instead/);
  });

  /**
   * The desktop and touch scrollers must not both act on one gesture, and the
   * header is where that contract lives, since neither module can see the
   * other's state.
   */
  const ownership = (): string => {
    const start = source.indexOf("WHICH INPUT EACH SCROLLER OWNS");
    expect(start, "the ownership section").toBeGreaterThan(-1);
    return source.slice(start, source.indexOf("WHAT THE COMPONENT STILL OWES", start));
  };

  it("says which input each scroller owns", () => {
    for (const needle of ["touchstart", "isTrusted", "scrollAccumPx", "momentumRAF", "passive"]) {
      expect(ownership()).toContain(needle);
    }
  });

  /**
   * An earlier draft named a `preventDefault` in the touch path as the thing
   * that stops a browser turning a finger pan into wheels. There is none, and
   * the assertion that pins it is against term.html, in the parity block below,
   * rather than against this prose.
   */
  it("does not claim the touch path prevents a default", () => {
    expect(ownership()).not.toMatch(/touch path's own preventDefault/);
  });

  /**
   * The clamp's own header, which twice argued the two-ifs shape from a NaN cap
   * an unlaid-out screen was said to produce. It produces a ZERO cap, and a
   * zero cap clamps rather than passes, so the reason was the reverse of the
   * behaviour. The shape is term.html's and stays; the reason is now that
   * :6255-6256 is two ifs.
   */
  it("does not argue the clamp's shape from an unlaid-out screen", () => {
    const clamp = source.slice(
      source.indexOf("Bound the accumulator to one frame's drain"),
      source.indexOf("function clampAccum"),
    );
    expect(clamp).not.toContain("must leave the accumulator alone");
    expect(clamp).toContain("cap of ZERO");
    expect(clamp).toContain("CLAMPS it to zero");
    expect(clamp).toContain(":6255-6256 is two");
  });

  /**
   * And the `!px` gate, whose comment named NaN as what an unlaid-out screen
   * multiplies a line delta into. It multiplies it into zero, which is the
   * value the gate is there for.
   */
  it("names zero, not NaN, as what an unlaid-out screen measures", () => {
    const gate = source.slice(source.indexOf("// `!px` (:6242)"), source.indexOf("const capPx"));
    expect(gate, "the `!px` comment").toContain("ZERO");
    expect(gate).not.toMatch(/multiplies a line or page delta into NaN/);
  });
});

describe("parity with term.html", () => {
  const TERM_HTML = resolve(__dirname, "../..", "frontend/term.html");
  const html = (): string => readFileSync(TERM_HTML, "utf8");

  /**
   * The per-frame cap lives in two places until term.html retires, and it is
   * SHARED with the touch scroller there. A port that quietly raised it hands
   * back the runaway coast it was tuned to stop.
   */
  it("uses the per-frame cap term.html ships", () => {
    const m = /const SCROLL_MAX_EVENTS_PER_FEED = (\d+);/.exec(html());
    expect(m?.[1], "SCROLL_MAX_EVENTS_PER_FEED in term.html").toBeTruthy();
    expect(Number(m?.[1])).toBe(SCROLL_MAX_EVENTS_PER_FEED);
  });

  /** The validator, character for character, so the accepted set cannot drift. */
  it("accepts exactly the speeds term.html's validator accepts", () => {
    const src = html();
    const m = /wheelSpeed: v => (v === 1 \|\| v === 1\.5 \|\| v === 2 \|\| v === 3)/.exec(src);
    expect(m, "the wheelSpeed validator in term.html").toBeTruthy();
    const accepted = [...(m?.[1] ?? "").matchAll(/v === ([\d.]+)/g)].map((g) => Number(g[1]));
    expect(accepted).toEqual([...WHEEL_SPEEDS]);
    for (const speed of accepted) expect(speedMultiplier(speed)).toBe(speed);
  });

  /** Both halves of the gate, in the order term.html reads them (:6203-6205). */
  it("gates on the gestures master kill as well as the pref", () => {
    expect(html()).toContain("return gesturesEnabled() && getPrefs().gestures.wheelSmooth;");
  });

  /**
   * Default ON in both front-ends, and the same speed. The detach is the safety
   * net that lets it default on, so a default that drifted would ship a red-line
   * surface nobody had agreed to.
   */
  it("ships the same defaults as term.html", () => {
    const src = html();
    expect(src).toContain("wheelSmooth: true,");
    expect(src).toContain("wheelSpeed: 1");
    expect(PREF_DEFAULTS.gestures.wheelSmooth).toBe(true);
    expect(PREF_DEFAULTS.gestures.wheelSpeed).toBe(1);
    expect(speedMultiplier(PREF_DEFAULTS.gestures.wheelSpeed)).toBe(1);
  });

  /**
   * The three deltaMode arms, which is where a port most easily loses a whole
   * input device: a page wheel measured by the cell height would scroll a
   * twenty-fourth of what it asked for.
   */
  it("normalizes the same three delta modes term.html does", () => {
    const src = html();
    expect(src).toContain("(ev.deltaMode === 1) ? ev.deltaY * xtermCellH()");
    expect(src).toContain("(ev.deltaMode === 2) ? ev.deltaY * xtermScreenH()");
    expect(DOM_DELTA_LINE).toBe(1);
    expect(DOM_DELTA_PAGE).toBe(2);
  });

  /**
   * The fact the header's ownership section rests on. term.html's one-finger
   * recognizer (:6490-6556) registers all three touch listeners
   * `{ passive: true }` and never prevents a default, so nothing there stops a
   * browser deriving `wheel` events from a finger pan, and such a wheel would be
   * TRUSTED and clear this module's only gate. Asserted against the source
   * because a comment is only ever as good as the lines it cites, and an earlier
   * draft claimed the opposite with every test still green.
   */
  /**
   * The measurement the two clamp comments rest on. Both helpers return a
   * DOMRect height, and an unlaid-out screen reports 0 for that while
   * `term.rows` is still nonzero, so cellH measures 0 and screenH measures 0.
   * Neither can return NaN, which is what an earlier draft of this port claimed
   * they did.
   */
  it("measures an unlaid-out screen as zero, not NaN (:6094-6101)", () => {
    const src = html();
    expect(src).toContain(
      "return (scr && term.rows) ? scr.getBoundingClientRect().height / term.rows : 16;",
    );
    expect(src).toContain(
      "return scr ? scr.getBoundingClientRect().height : (term.rows || 24) * 16;",
    );
    // The arithmetic those two lines do on a screen with no layout yet.
    const unlaidOut = 0;
    expect(unlaidOut / 24).toBe(0);
    expect(SCROLL_MAX_EVENTS_PER_FEED * (unlaidOut / 1)).toBe(0);
  });

  /**
   * The speed pref is re-read and re-validated at each site rather than held,
   * which is why this module validates inside `speedMultiplier` rather than at
   * its boundary. There are TWO sites, not three: the frame's row size (:6214)
   * and the wheel's cap (:6254), both spelled `xtermCellH() / wheelSpeedMult()`.
   */
  it("re-validates the speed at both of its sites, and there are two", () => {
    const uses = html()
      .split("\n")
      .filter((l) => l.includes("wheelSpeedMult()"));
    expect(uses).toHaveLength(3);
    expect(uses.filter((l) => l.includes("function wheelSpeedMult()"))).toHaveLength(1);
    expect(uses.filter((l) => l.includes("xtermCellH() / wheelSpeedMult()"))).toHaveLength(2);
  });

  /**
   * Which of the page's wheel listeners is on what. The one that hard-cancels a
   * touch coast and clears a selection is registered on the terminal HOST
   * ELEMENT (:6278); the page's only document-level wheel listener is the
   * diagnostics ring buffer (:5883). The header used to call the first one a
   * document listener, which would have sent a component looking for a
   * page-wide listener that is not there.
   */
  it("puts the coast-cancelling wheel listener on the terminal element", () => {
    const src = html();
    expect(src).toContain("document.getElementById('terminal').addEventListener('wheel', (w) => {");
    const onDocument = src.split("\n").filter((l) => /^\s*document\.addEventListener\('wheel'/.test(l));
    expect(onDocument, "document-level wheel listeners").toHaveLength(1);
    expect(onDocument[0], "the only one is the diagnostics ring").toContain("ring({ k: 'wh'");
  });

  it("has three passive touch listeners and no preventDefault in the recognizer", () => {
    // 1-indexed :6490-6556, which is the whole IIFE holding the recognizer.
    const recognizer = html().split("\n").slice(6489, 6556);
    expect(recognizer.filter((l) => /addEventListener\('touch/.test(l))).toHaveLength(3);
    expect(recognizer.filter((l) => l.includes("{ passive: true })"))).toHaveLength(3);
    expect(recognizer.filter((l) => l.includes("preventDefault"))).toEqual([]);
  });
});
