import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  COAST_FRAME_CAP_MS,
  GAP_ATTEN_TAU_MS,
  GAP_STILL_MS,
  MOMENTUM_MAX_COAST_SCREENS,
  MOMENTUM_MIN_START_ROWS_PER_S,
  MOMENTUM_STOP_ROWS_PER_S,
  MOMENTUM_TAU_MS,
  NO_TOUCH_SCROLL,
  SCROLL_MAX_EVENTS_PER_FEED,
  SWIPE_THRESHOLD_PX,
  VEL_SAMPLES_MAX,
  VEL_WINDOW_MS,
  WHEEL_CLIENT_X,
  reduce,
  releaseVelocity,
  scrollSpeedMult,
  type LineWheel,
  type TouchScrollAction,
  type TouchScrollEvent,
  type TouchScrollState,
  type TouchScrollWorld,
  type VelocitySample,
} from "../src/terminal/touchscroll";

/**
 * Touch scroll, as frontend/term.html:6056-6171 and :6478-6556 paid for it.
 *
 * WHAT IS AT STAKE. This is the only way to scroll a terminal with a finger.
 * The drag becomes a run of discrete deltaMode=LINE wheels, one row each, which
 * is what makes tmux enter copy-mode and what lets a mouse-tracking app such as
 * Claude Code scroll its own view. Measured on a real phone 2026-08-16: an
 * 18-touchmove drag produced 15 one-line wheels, tmux copy-mode scrolled 14
 * lines, and vim with mouse=a scrolled itself from line 1 to line 46.
 *
 * The recognizer's range starts at :6478 and not a line later, because :6478 is
 * `if (isCoarsePointer) {` and everything below it is inside that gate. Two
 * cases at the bottom of this file are about the gate alone: the module's owes
 * list has to name it, or a component built from that list attaches these
 * listeners on hardware term.html leaves alone.
 *
 * The expected momentum counts below were derived by transcribing
 * term.html:6117-6170 into a standalone simulation and running it, so they come
 * from the page's arithmetic rather than from this port agreeing with itself.
 */

/** 16px rows, 24 of them: the geometry every number below is derived against. */
const CELL_H = 16;
const SCREEN_H = 384;

/** The frame cadence the coast is driven at, near enough to 60Hz. */
const FRAME_MS = 16;

const world = (over: Partial<TouchScrollWorld> = {}): TouchScrollWorld => ({
  cellHeightPx: CELL_H,
  screenHeightPx: SCREEN_H,
  scrollSpeed: 1,
  momentum: true,
  mounted: true,
  ...over,
});

const start = (y: number, touches = 1): TouchScrollEvent => ({ type: "touchstart", touches, y });

const move = (y: number, t: number, touches = 1): TouchScrollEvent => ({
  type: "touchmove",
  touches,
  y,
  t,
  // Both clocks agree unless a test is specifically about them disagreeing.
  th: t,
});

const end = (t: number, th = t): TouchScrollEvent => ({ type: "touchend", t, th });

interface Played {
  readonly state: TouchScrollState;
  readonly wheels: readonly LineWheel[];
  readonly focuses: number;
  readonly coasting: boolean;
}

/** Play a sequence through `reduce`, collecting what the component would perform. */
const play = (
  events: readonly TouchScrollEvent[],
  w: TouchScrollWorld = world(),
  from: TouchScrollState = NO_TOUCH_SCROLL,
): Played => {
  let state = from;
  let coasting = false;
  const wheels: LineWheel[] = [];
  let focuses = 0;
  for (const e of events) {
    const r = reduce(state, e, w);
    state = r.state;
    coasting = r.coasting;
    for (const a of r.actions) collect(a, wheels, () => focuses++);
  }
  return { state, wheels, focuses, coasting };
};

const collect = (a: TouchScrollAction, wheels: LineWheel[], onFocus: () => void): void => {
  if (a.kind === "wheel") wheels.push(a.wheel);
  else onFocus();
};

/** One finger down at `y0`, then a move every 16ms by `step` px. */
const dragBy = (y0: number, step: number, moves: number): TouchScrollEvent[] => {
  const events: TouchScrollEvent[] = [start(y0)];
  for (let i = 1; i <= moves; i++) events.push(move(y0 + step * i, 16 * i));
  return events;
};

/**
 * A swipe mid-flight, one moment before the finger lifts: two samples `dy`
 * apart over 100ms, and a gesture that has already emitted, which is the only
 * kind allowed to coast.
 *
 * The sample ys start at 0 so the release velocity is exactly dy/100 px/ms.
 * Anchoring them at a plausible clientY instead costs the gate its exactness:
 * `300 + 4.8 - 300` is 4.800000000000011, and the 3 rows/s boundary then reads
 * 3.000000000000007 rather than 3.
 */
const released = (dy: number, over: Partial<TouchScrollState> = {}): TouchScrollState => ({
  startY: 300,
  lastY: 350,
  moved: true,
  accumPx: 0,
  samples: [
    { y: 0, t: 0, th: 0 },
    { y: dy, t: 100, th: 100 },
  ],
  emitY: 350,
  emitted: true,
  coast: null,
  ...over,
});

interface Coasted {
  readonly wheels: readonly LineWheel[];
  readonly frames: number;
  readonly stopped: boolean;
}

/**
 * Pump frames at `frameMs` until the coast stops, and report whether it did.
 * The 2000-frame guard is the "does not run forever" assertion: at 16ms that is
 * 32 seconds of coast, and the longest flick below finishes in 126 frames.
 */
const coastOut = (
  state: TouchScrollState,
  w: TouchScrollWorld,
  at: number,
  frameMs = FRAME_MS,
): Coasted => {
  let s = state;
  const wheels: LineWheel[] = [];
  let frames = 0;
  let now = at;
  for (;;) {
    now += frameMs;
    const r = reduce(s, { type: "frame", now }, w);
    s = r.state;
    for (const a of r.actions) collect(a, wheels, () => undefined);
    if (!r.coasting) return { wheels, frames, stopped: true };
    frames++;
    if (frames > 2000) return { wheels, frames, stopped: false };
  }
};

/** Lift after a drag, then coast to a halt. Momentum wheels only. */
const flick = (dy: number, w: TouchScrollWorld = world(), gap = 0): Coasted => {
  const r = reduce(released(dy), end(100 + gap), w);
  expect(r.actions.filter((a) => a.kind === "wheel")).toHaveLength(0);
  if (!r.coasting) return { wheels: [], frames: 0, stopped: true };
  return coastOut(r.state, w, 100 + gap);
};

describe("tap versus swipe", () => {
  /**
   * The whole reason the focus call waits for the lift: a swipe that summoned
   * the soft keyboard would cover the scrollback it just revealed.
   */
  it("focuses on a tap that never moved", () => {
    const r = play([start(200), end(50)]);
    expect(r.focuses).toBe(1);
    expect(r.wheels).toHaveLength(0);
  });

  it("focuses on a tap that wobbled inside the threshold", () => {
    const r = play([start(200), move(200 + SWIPE_THRESHOLD_PX, 16), end(32)]);
    expect(r.focuses).toBe(1);
    expect(r.wheels).toHaveLength(0);
  });

  it("does not focus after a swipe", () => {
    const r = play([...dragBy(200, 8, 3), end(64)]);
    expect(r.focuses).toBe(0);
    expect(r.wheels.length).toBeGreaterThan(0);
  });

  /**
   * The threshold is `> 6`, not `>= 6` (term.html:6507). One pixel either side
   * of it decides whether a press is a keyboard or a scroll.
   */
  it.each([
    { travel: SWIPE_THRESHOLD_PX, swipe: false },
    { travel: SWIPE_THRESHOLD_PX + 1, swipe: true },
    { travel: -SWIPE_THRESHOLD_PX, swipe: false },
    { travel: -SWIPE_THRESHOLD_PX - 1, swipe: true },
  ])("travel of $travel px is a swipe: $swipe", ({ travel, swipe }) => {
    const w = world();
    const down = reduce(NO_TOUCH_SCROLL, start(200), w);
    expect(reduce(down.state, move(200 + travel, 16), w).state.moved).toBe(swipe);
    // And the consequence the threshold exists for: a tap raises the keyboard,
    // a swipe must not.
    expect(play([start(200), move(200 + travel, 16), end(32)]).focuses).toBe(swipe ? 0 : 1);
  });

  /**
   * Distance from where the finger LANDED, not distance travelled: a jitter
   * that oscillates inside the threshold covers plenty of ground without ever
   * meaning to scroll, and must still raise the keyboard on lift.
   */
  it("measures the threshold from the landing point, not along the path", () => {
    const wobble = [start(200), move(205, 16), move(200, 32), move(205, 48), move(200, 64)];
    const r = play([...wobble, end(80)]);
    expect(r.wheels).toHaveLength(0);
    expect(r.focuses).toBe(1);
  });

  /** Once a gesture is a swipe it stays one, even coming back over the start. */
  it("keeps scrolling after the finger returns near where it landed", () => {
    const r = play([start(200), move(240, 16), move(202, 32)]);
    expect(r.wheels.length).toBeGreaterThan(0);
    const back = r.wheels[r.wheels.length - 1];
    expect(back?.deltaY).toBe(1);
  });

  /**
   * The travel spent proving the gesture is a swipe is not scrolled. Only the
   * delta of the crossing move onwards reaches the accumulator
   * (term.html:6506 updates lastY before :6507 sets `moved`).
   */
  it("does not scroll the travel that came before the threshold", () => {
    // 16px from the landing point, but only 12px of it after the crossing.
    const r = play([start(200), move(204, 16), move(212, 32), move(216, 48)]);
    expect(r.wheels).toHaveLength(0);
  });

  /**
   * The classification runs even with nothing to dispatch on. term.html:6506
   * and :6507 come BEFORE the :6508 mounted gate, so a swipe made while the
   * terminal is unmounted still counts as a swipe: `lastY` tracks the finger,
   * `moved` sticks, and the lift takes no focus even though not one wheel went
   * out. The lobby keeps every visited session mounted and CSS-hides the rest,
   * so an unmounted terminal is a real state a finger can land in.
   */
  it("still classifies a swipe made while the terminal is unmounted", () => {
    const hidden = world({ mounted: false });
    const mid = play(dragBy(200, 8, 4), hidden);
    expect(mid.state.moved).toBe(true);
    expect(mid.state.lastY).toBe(232);
    const lifted = play([...dragBy(200, 8, 4), end(80)], hidden);
    expect(lifted.wheels).toHaveLength(0);
    expect(lifted.focuses).toBe(0);
  });
});

describe("one wheel per row crossed", () => {
  /** rowPx = cellHeight / scrollSpeed, so at speed 1 a 16px row is one wheel. */
  it("emits one wheel per row of finger travel and no more", () => {
    const r = play(dragBy(200, 8, 4));
    expect(r.wheels).toHaveLength(2);
  });

  it("keeps the sub-row remainder across moves", () => {
    // The first 5px move is under the swipe threshold, so four moves feed 15px:
    // one pixel short of a row, and nothing is owed yet.
    expect(play(dragBy(200, 5, 4)).wheels).toHaveLength(0);
    const more = play(dragBy(200, 5, 5));
    expect(more.wheels).toHaveLength(1);
    expect(more.state.accumPx).toBeCloseTo(-4, 10);
  });

  it("carries the remainder from the drag into the coast", () => {
    const r = reduce(released(50, { accumPx: -15 }), end(100), world());
    const coast = coastOut(r.state, world(), 100);
    // The 9 rows a 0.5px/ms flick coasts, plus the row the 15px remainder was
    // one pixel short of.
    expect(coast.wheels).toHaveLength(10);
  });

  it.each([
    { speed: 1, wheels: 2 },
    { speed: 1.5, wheels: 3 },
    { speed: 2, wheels: 4 },
    { speed: 3, wheels: 6 },
  ])("emits $wheels wheels for two rows at scroll speed $speed", ({ speed, wheels }) => {
    const r = play(dragBy(200, 8, 4), world({ scrollSpeed: speed }));
    expect(r.wheels).toHaveLength(wheels);
  });

  /** A move that lands where the last one did feeds nothing and samples nothing. */
  it("ignores a move with no delta", () => {
    const r = play([start(200), move(240, 16), move(240, 32)]);
    expect(r.state.samples).toHaveLength(1);
  });

  /** term.html:6508 gives up on the whole move when the terminal is not mounted. */
  it("emits nothing and samples nothing while the terminal is unmounted", () => {
    const r = play(dragBy(200, 8, 4), world({ mounted: false }));
    expect(r.wheels).toHaveLength(0);
    expect(r.state.samples).toHaveLength(0);
    expect(r.state.accumPx).toBe(0);
  });

  /** The ring buffer is bounded at 24 samples (term.html:6521). */
  it("keeps at most the last 24 velocity samples", () => {
    const r = play(dragBy(200, 8, 30));
    expect(r.state.samples).toHaveLength(VEL_SAMPLES_MAX);
    expect(r.state.samples[0]?.y).toBe(200 + 8 * 7);
  });

  /**
   * A row the screen box cannot measure BANKS the px rather than spending
   * them: term.html:6118 adds the delta to the accumulator before the :6120
   * guard returns, so travel taken while the screen measures 0 is owed, not
   * lost. Restoring the row size spends it.
   *
   * The counts are term.html's own, transcribed and run: 0 wheels and 50px
   * banked, then four wheels and 2px still owed.
   */
  it("banks a drag's px while the row is unmeasurable", () => {
    const zero = world({ cellHeightPx: 0, screenHeightPx: 0 });
    const down = reduce(NO_TOUCH_SCROLL, start(200), zero).state;
    const stalled = reduce(down, move(250, 16), zero);
    expect(stalled.actions).toHaveLength(0);
    expect(stalled.state.accumPx).toBe(-50);
    // 50 banked px plus 16 more is four rows, not the one this move covered.
    const spent = reduce(stalled.state, move(266, 32), world());
    expect(spent.actions).toHaveLength(4);
    expect(spent.state.accumPx).toBeCloseTo(-2, 10);
  });
});

describe("the wheel the component dispatches", () => {
  /**
   * The whole init, pinned. A pixel-mode delta is damped to 0.3 by xterm 6 and
   * capped at one report per DOM event in a mouse-tracking pane, which is why
   * this is a one-row LINE wheel and not a pixel delta (term.html:6059-6072).
   */
  it("is a discrete one-row LINE wheel at the finger's y", () => {
    const r = play(dragBy(200, 16, 1));
    expect(r.wheels).toEqual([
      {
        deltaY: -1,
        deltaMode: 1,
        bubbles: true,
        cancelable: true,
        clientX: WHEEL_CLIENT_X,
        clientY: 216,
      },
    ]);
  });

  /**
   * Sign: finger DOWN the screen scrolls UP into scrollback, which is what a
   * touchscreen does everywhere else (term.html:6073-6075).
   */
  it.each([
    { direction: "down the screen", step: 16, deltaY: -1 },
    { direction: "up the screen", step: -16, deltaY: 1 },
  ])("dragging $direction emits deltaY $deltaY", ({ step, deltaY }) => {
    const r = play(dragBy(200, step, 3));
    expect(r.wheels).toHaveLength(3);
    expect(r.wheels.every((wl) => wl.deltaY === deltaY)).toBe(true);
  });

  it("carries the y of the move that produced it", () => {
    const r = play(dragBy(200, 16, 3));
    expect(r.wheels.map((wl) => wl.clientY)).toEqual([216, 232, 248]);
  });

  it("carries the last drag y through the whole coast", () => {
    const w = world();
    const lift = reduce(released(50), end(100), w);
    const coast = coastOut(lift.state, w, 100);
    expect(coast.wheels.length).toBeGreaterThan(0);
    expect(coast.wheels.every((wl) => wl.clientY === 350)).toBe(true);
  });

  /**
   * One frame cannot spray hundreds of events (term.html:6082). A coalesced
   * jump is capped, and the untouched px stay in the accumulator for the next
   * feed rather than being thrown away.
   */
  it("caps one feed at 10 wheels and keeps the rest", () => {
    const r = play([start(200), move(700, 16)]);
    expect(r.wheels).toHaveLength(SCROLL_MAX_EVENTS_PER_FEED);
    expect(r.state.accumPx).toBeCloseTo(-340, 10);
    const next = reduce(r.state, move(716, 32), world());
    expect(next.actions).toHaveLength(SCROLL_MAX_EVENTS_PER_FEED);
  });
});

describe("scroll speed is an enumeration", () => {
  /**
   * term.html:6089-6092 accepts four values and falls back to 1 for anything
   * else, because the pref roams and an older document can hold a value from a
   * retired key with different semantics (#9642).
   */
  it.each([
    { pref: 1, mult: 1 },
    { pref: 1.5, mult: 1.5 },
    { pref: 2, mult: 2 },
    { pref: 3, mult: 3 },
    { pref: 0, mult: 1 },
    { pref: -2, mult: 1 },
    { pref: 2.5, mult: 1 },
    { pref: 10, mult: 1 },
    { pref: Number.NaN, mult: 1 },
  ])("reads a pref of $pref as $mult", ({ pref, mult }) => {
    expect(scrollSpeedMult(pref)).toBe(mult);
  });
});

describe("release velocity", () => {
  const sample = (y: number, t: number): VelocitySample => ({ y, t, th: t });

  it("is zero with fewer than two samples", () => {
    expect(releaseVelocity([])).toBe(0);
    expect(releaseVelocity([sample(0, 0)])).toBe(0);
  });

  it("is zero when the window collapses to one instant", () => {
    expect(releaseVelocity([sample(0, 40), sample(10, 40)])).toBe(0);
  });

  /** Only the last VEL_WINDOW_MS counts, so a slow approach cannot dilute a flick. */
  it("measures across the last 100ms of samples only", () => {
    const v = releaseVelocity([sample(0, 0), sample(10, 50), sample(20, 100), sample(30, 200)]);
    expect(v).toBeCloseTo(0.1, 10);
  });

  it("is positive for a finger moving down the screen", () => {
    expect(releaseVelocity([sample(0, 0), sample(50, 100)])).toBeCloseTo(0.5, 10);
    expect(releaseVelocity([sample(50, 0), sample(0, 100)])).toBeCloseTo(-0.5, 10);
  });

  /**
   * Both the window boundary and the dt walk the EVENT clock.
   * term.html:6140-6142 reads `.t` for both, and `.th` exists only for the
   * touchend gap (:6547). Nothing else in this file can tell the two apart,
   * because every other sample here is written with `t === th`, and on real iOS
   * they are exactly what diverges: `t` is the event's creation stamp and
   * survives coalesced delivery, `th` is when the handler ran.
   *
   * Both numbers below come from term.html's own arithmetic transcribed and
   * run, not from this port.
   */
  it("walks the event clock for the window and the dt, never the handling clock", () => {
    // The window: on `t` all three samples are inside 100ms of the newest, so
    // the secant spans the whole 30px. On `th` the oldest is 1000ms out, which
    // would span 20px instead and read 0.2 or 0.4 depending on which clock the
    // dt then used.
    expect(
      releaseVelocity([
        { y: 0, t: 0, th: 0 },
        { y: 10, t: 50, th: 900 },
        { y: 30, t: 100, th: 1000 },
      ]),
    ).toBeCloseTo(0.3, 10);
    // The dt: 100ms of event time against 200ms of handling time. A late
    // handler must not halve the flick it is reporting.
    expect(
      releaseVelocity([
        { y: 0, t: 0, th: 0 },
        { y: 50, t: 100, th: 200 },
      ]),
    ).toBeCloseTo(0.5, 10);
  });
});

describe("lift-off momentum", () => {
  /**
   * The table. `dy` is how far the finger moved over the last 100ms, so the
   * release velocity is dy/100 px/ms; `wheels` is what term.html's own
   * arithmetic produces for it at 16ms frames, 16px rows and a 384px screen.
   *
   * 4.5px is 2.81 rows/s and never coasts. 4.8px is exactly the 3 rows/s gate,
   * so it coasts, and still owes nothing: 12.6px of coast is short of one row.
   */
  it.each([
    { dy: 4.5, wheels: 0, coasts: false },
    { dy: 4.8, wheels: 0, coasts: true },
    { dy: 5, wheels: 0, coasts: true },
    { dy: 10, wheels: 1, coasts: true },
    { dy: 25, wheels: 4, coasts: true },
    { dy: 50, wheels: 9, coasts: true },
    { dy: 100, wheels: 19, coasts: true },
    { dy: 200, wheels: 39, coasts: true },
    { dy: 400, wheels: 79, coasts: true },
    { dy: -50, wheels: 9, coasts: true },
    { dy: -200, wheels: 39, coasts: true },
  ])("a release of $dy px per 100ms coasts $wheels wheels", ({ dy, wheels, coasts }) => {
    const lift = reduce(released(dy), end(100), world());
    expect(lift.coasting).toBe(coasts);
    const c = flick(dy);
    expect(c.stopped).toBe(true);
    expect(c.wheels).toHaveLength(wheels);
  });

  /**
   * The counts above are not the port read back to itself: they follow from a
   * closed form.
   *
   * Each frame spends the velocity it has AFTER decaying, so the coast is a
   * geometric sum, `(|v0| - stopVel) * dt * r / (1 - r)` px with
   * `r = exp(-dt/tau)`, not the continuous integral `tau * (|v0| - stopVel)`.
   * At a 16ms cadence that is 2.4% shorter, which is the whole gap between 79
   * wheels and the integral's 81.
   */
  it.each([10, 25, 50, 100, 200, 400])("coasts as far as the decay sum says (%i)", (dy) => {
    const stopVel = (MOMENTUM_STOP_ROWS_PER_S * CELL_H) / 1000;
    const r = Math.exp(-FRAME_MS / MOMENTUM_TAU_MS);
    const px = ((Math.abs(dy) / 100 - stopVel) * FRAME_MS * r) / (1 - r);
    expect(flick(dy).wheels).toHaveLength(Math.trunc(px / CELL_H));
  });

  /**
   * Decaying, not constant. The wheels have to thin out as the coast slows, or
   * a flick would read as a scroll that carries on at full speed and then cuts
   * out.
   */
  it("thins the wheels out as the coast decays", () => {
    const w = world();
    let s = reduce(released(400), end(100), w).state;
    const perFrame: number[] = [];
    const speeds: number[] = [];
    for (let i = 1; i <= 40; i++) {
      const r = reduce(s, { type: "frame", now: 100 + FRAME_MS * i }, w);
      s = r.state;
      perFrame.push(r.actions.length);
      speeds.push(Math.abs(s.coast?.velPxPerMs ?? 0));
    }
    // A 4px/ms flick coasts for 126 frames, so 40 is still mid-coast.
    expect(s.coast).not.toBeNull();
    const first = perFrame.slice(0, 5).reduce((a, b) => a + b, 0);
    const last = perFrame.slice(-5).reduce((a, b) => a + b, 0);
    expect(first).toBeGreaterThan(last);
    // Every frame is slower than the one before it, throughout.
    expect(speeds.every((v, i) => i === 0 || v < speeds[i - 1]!)).toBe(true);
  });

  it("keeps the direction of the flick", () => {
    expect(flick(200).wheels.every((wl) => wl.deltaY === -1)).toBe(true);
    expect(flick(-200).wheels.every((wl) => wl.deltaY === 1)).toBe(true);
  });

  /** A flick past the cap stops on distance rather than on speed (term.html:6078). */
  it("stops at four screens of coast", () => {
    const w = world({ screenHeightPx: 40 });
    const c = flick(400, w);
    expect(c.stopped).toBe(true);
    expect(c.frames).toBe(3);
    expect(c.wheels).toHaveLength(10);
    expect(MOMENTUM_MAX_COAST_SCREENS * 40).toBe(160);
  });

  /**
   * A finger held still before lifting must not coast. It cannot be detected
   * from the samples, because browsers dedupe identical-coordinate touchmoves
   * and a held finger produces none: the newest sample is the last MOVING one.
   * So the test is the gap between that sample and the lift (term.html:6537-6542).
   */
  it("does not coast when the finger was held still before lifting", () => {
    const r = reduce(released(400), end(100 + GAP_STILL_MS + 1), world());
    expect(r.coasting).toBe(false);
  });

  it("coasts when the lift came within the still window", () => {
    const r = reduce(released(400), end(100 + GAP_STILL_MS), world());
    expect(r.coasting).toBe(true);
  });

  /**
   * Inside the window the velocity is attenuated smoothly rather than zeroed,
   * so WKWebView delivery latency trims a fast flick instead of killing it.
   * v1's binary 80ms cutoff killed every flick on real iOS.
   */
  it("attenuates the release velocity by the delivery gap", () => {
    expect(flick(100, world(), 0).wheels).toHaveLength(19);
    expect(flick(100, world(), 50).wheels).toHaveLength(17);
    expect(Math.exp(-50 / GAP_ATTEN_TAU_MS)).toBeCloseTo(0.8825, 4);
  });

  /** The attenuated velocity is what faces the start gate, not the raw one. */
  it("lets the attenuation take a marginal flick below the start gate", () => {
    expect(reduce(released(5), end(100), world()).coasting).toBe(true);
    expect(reduce(released(5), end(220), world()).coasting).toBe(false);
  });

  /**
   * Two clocks per sample, and the gap takes the MIN of them: event time is the
   * true finger timing and survives coalesced delivery, while performance.now()
   * at handling stays sane for synthetic events whose creation stamps batch
   * unreliably. A genuine hold is long on both (term.html:6509-6519).
   */
  it("takes the flick-favourable reading of the two clocks", () => {
    const late = released(400);
    // Event time says the lift was 400ms after the last move; the handling
    // clock says 20ms. The smaller gap wins, so the flick survives.
    expect(reduce(late, { type: "touchend", t: 500, th: 120 }, world()).coasting).toBe(true);
    // Long on both clocks: held still, no coast.
    expect(reduce(late, { type: "touchend", t: 500, th: 400 }, world()).coasting).toBe(false);
  });

  it("never coasts with the momentum pref off", () => {
    expect(reduce(released(400), end(100), world({ momentum: false })).coasting).toBe(false);
  });

  /**
   * A gesture that never fed the scroller has nothing to continue
   * (term.html:6543). The flag says the move passed the gates, not that a wheel
   * went out, so a drag too short to owe one still coasts.
   */
  it("never coasts a gesture that never fed the scroller", () => {
    expect(reduce(released(400, { emitted: false }), end(100), world()).coasting).toBe(false);
    // 15px of travel: one pixel short of a single wheel, and still a flick.
    const fed = play([start(200), move(208, 16), move(215, 32), end(48)]);
    expect(fed.wheels).toHaveLength(0);
    expect(fed.coasting).toBe(true);
  });

  /**
   * A frame that arrives late decays by at most 64ms (term.html:6159), so a
   * backgrounded tab returning does not silently swallow the whole coast in one
   * step.
   */
  it("clamps a late frame to 64ms of decay", () => {
    const w = world();
    const lift = reduce(released(400), end(100), w);
    const late = reduce(lift.state, { type: "frame", now: 100 + 5000 }, w);
    expect(late.coasting).toBe(true);
    const clamped = 4 * Math.exp(-COAST_FRAME_CAP_MS / MOMENTUM_TAU_MS);
    expect(late.state.coast?.velPxPerMs).toBeCloseTo(-clamped, 10);
  });

  /**
   * The stop speed and the distance cap are frozen when the coast starts
   * (term.html:6150-6156 reads the cell height once, outside the step), while
   * the row size is re-read every feed (:6119). A font change mid-coast
   * therefore changes the row size and not the finish line.
   */
  it("freezes the stop speed at the moment of the lift", () => {
    const w = world();
    const lift = reduce(released(400), end(100), w);
    // A row of 20000px would put the stop speed at 10px/ms, well above the
    // 3.8px/ms this coast still has, so a port that re-read it would stop here.
    const next = reduce(lift.state, { type: "frame", now: 116 }, world({ cellHeightPx: 20000 }));
    expect(next.coasting).toBe(true);
    expect(next.state.coast?.stopVelPxPerMs).toBeCloseTo(
      (MOMENTUM_STOP_ROWS_PER_S * CELL_H) / 1000,
      12,
    );
  });

  /**
   * The other half of that: the row size IS re-read on every feed (:6119), so a
   * font change mid-coast changes what the remaining pixels are worth and NOT
   * where the coast ends. Same flick, same 126 frames, 79 wheels at a 16px row
   * against 3 at a 320px one, from term.html's arithmetic transcribed and run.
   *
   * A port that froze the row size at the lift alongside the stop speed would
   * pass the test above and fail this one.
   */
  it.each([
    { cellHeightPx: CELL_H, wheels: 79 },
    { cellHeightPx: 320, wheels: 3 },
  ])(
    "re-reads the row size per coast feed: $cellHeightPx px gives $wheels wheels",
    ({ cellHeightPx, wheels }) => {
      const lift = reduce(released(400), end(100), world());
      const c = coastOut(lift.state, world({ cellHeightPx }), 100);
      expect(c.stopped).toBe(true);
      // The finish line does not move: the stop speed and the cap were frozen
      // at the lift, so both row sizes coast for exactly as long.
      expect(c.frames).toBe(126);
      expect(c.wheels).toHaveLength(wheels);
    },
  );

  /**
   * The momentum pref is read once, at the lift (:6543). The step (:6158-6168)
   * never looks at it again, so turning momentum off mid-coast does not stop
   * the coast already in flight, and the same 79 wheels over 126 frames come
   * out either way.
   */
  it("does not stop a coast when the momentum pref goes off mid-flight", () => {
    const lift = reduce(released(400), end(100), world());
    const c = coastOut(lift.state, world({ momentum: false }), 100);
    expect(c.stopped).toBe(true);
    expect(c.frames).toBe(126);
    expect(c.wheels).toHaveLength(79);
  });

  /**
   * The burst cap lives in the shared feed, so it holds inside a coast frame
   * exactly as it holds on a drag (:6082, :6123-6124). One coalesced 64ms frame
   * off a 16px/ms flick is worth 52 rows: 10 go out and the other 681px stay
   * banked for the next frame rather than being dropped.
   */
  it("caps one coast frame at 10 wheels and banks the rest", () => {
    // Four screens of a 384px screen would end this coast on distance before
    // the cap could be reached, so give it room.
    const w = world({ screenHeightPx: 4000 });
    const lift = reduce(released(1600), end(100), w);
    const frame = reduce(lift.state, { type: "frame", now: 164 }, w);
    expect(frame.actions).toHaveLength(SCROLL_MAX_EVENTS_PER_FEED);
    expect(frame.state.coast?.velPxPerMs).toBeCloseTo(-13.14006, 5);
    expect(frame.state.accumPx).toBeCloseTo(-680.9639, 4);
  });

  /**
   * And the speed pref reaches the coast for the same reason: `rowPx` is
   * `cellHeight / scrollSpeed` in the shared feed. The counts are term.html's
   * for one 0.5px/ms flick, and 2.5 is not an accepted value, so it falls back
   * to 1 and coasts what speed 1 coasts.
   */
  it.each([
    { speed: 1, wheels: 9 },
    { speed: 1.5, wheels: 14 },
    { speed: 2, wheels: 19 },
    { speed: 3, wheels: 29 },
    { speed: 2.5, wheels: 9 },
  ])("coasts $wheels wheels at scroll speed $speed", ({ speed, wheels }) => {
    const w = world({ scrollSpeed: speed });
    const lift = reduce(released(50), end(100), w);
    const c = coastOut(lift.state, w, 100);
    expect(c.stopped).toBe(true);
    expect(c.frames).toBe(83);
    expect(c.wheels).toHaveLength(wheels);
  });

  /**
   * A coast frame stamped BEFORE the lift. `Math.min(COAST_FRAME_CAP_MS, now -
   * at)` has no lower clamp, exactly as term.html:6159 has none, so the dt goes
   * negative, `Math.exp(-dt/tau)` GROWS the velocity, and `vel * dt` comes out
   * with the opposite sign to the flick: the drag's wheels were deltaY -1 and
   * these are +1.
   *
   * Pinned rather than tidied. Clamping the dt at 0 looks like an obvious
   * cleanup and is a behaviour change, and rAF timestamps can precede a
   * `performance.now()` read taken in the same turn.
   */
  it("lets a frame stamped before the lift run the coast backwards", () => {
    const w = world();
    const lift = reduce(released(400), end(100), w);
    const back = reduce(lift.state, { type: "frame", now: 90 }, w);
    expect(back.state.coast?.velPxPerMs).toBeCloseTo(-4 * Math.exp(10 / MOMENTUM_TAU_MS), 10);
    expect(back.actions).toHaveLength(2);
    expect(back.actions.every((a) => a.kind === "wheel" && a.wheel.deltaY === 1)).toBe(true);
    expect(back.state.accumPx).toBeCloseTo(9.2499, 4);
  });

  /**
   * A hidden terminal measures 0 by 0, which makes both the stop speed and the
   * coast cap 0. The cap is what ends it: nothing has coasted yet and 0 already
   * meets the cap, so the first frame stops without emitting.
   */
  it("stops immediately when the screen has no height", () => {
    const w = world({ cellHeightPx: 0, screenHeightPx: 0 });
    const lift = reduce(released(400), end(100), w);
    expect(lift.coasting).toBe(true);
    const c = coastOut(lift.state, w, 100);
    expect(c.stopped).toBe(true);
    expect(c.frames).toBe(0);
    expect(c.wheels).toHaveLength(0);
  });

  it("stops when the terminal goes away mid-coast", () => {
    const w = world();
    const lift = reduce(released(400), end(100), w);
    const gone = reduce(lift.state, { type: "frame", now: 116 }, world({ mounted: false }));
    expect(gone.coasting).toBe(false);
    expect(gone.actions).toHaveLength(0);
  });

  it("does nothing with a frame when nothing is coasting", () => {
    const r = reduce(NO_TOUCH_SCROLL, { type: "frame", now: 1000 }, world());
    expect(r.state).toBe(NO_TOUCH_SCROLL);
    expect(r.actions).toHaveLength(0);
    expect(r.coasting).toBe(false);
  });

  /** The gate is 3 rows/s exactly, and 16px rows make that 0.048px/ms. */
  it("reads the start gate in rows per second, not pixels", () => {
    const dy = (MOMENTUM_MIN_START_ROWS_PER_S * CELL_H) / 10;
    expect(reduce(released(dy), end(100), world()).coasting).toBe(true);
    expect(reduce(released(dy), end(100), world({ cellHeightPx: 24 })).coasting).toBe(false);
  });
});

describe("what stops a scroll", () => {
  /**
   * A second finger is a hard cancel, not a competitor. term.html:6496-6498
   * cancels the coast and clears the accumulator BEFORE it tests the touch
   * count, then disarms the drag, so nothing about the two-finger sequence can
   * feed a wheel or start a coast.
   */
  it("disarms the drag when a second finger lands", () => {
    const r = play([...dragBy(200, 16, 2), start(400, 2), move(500, 48, 2), move(600, 64)]);
    // Two wheels from the one-finger leg, and nothing after the second finger:
    // the moves that follow have no armed lastY to measure from.
    expect(r.wheels).toHaveLength(2);
  });

  it("cancels an in-flight coast when a finger lands", () => {
    const w = world();
    const lift = reduce(released(400), end(100), w);
    expect(lift.coasting).toBe(true);
    const touched = reduce(lift.state, start(200), w);
    expect(touched.coasting).toBe(false);
    expect(touched.actions).toHaveLength(0);
    expect(coastOut(touched.state, w, 200).wheels).toHaveLength(0);
  });

  it("does not coast on the lift that follows a second finger", () => {
    const r = play([...dragBy(200, 16, 4), start(400, 2), end(96)]);
    expect(r.coasting).toBe(false);
  });

  it("does not focus on the lift that follows a second finger", () => {
    const r = play([start(200), start(400, 2), end(48)]);
    expect(r.focuses).toBe(0);
  });

  /**
   * `moved` SURVIVES a disarming touchstart, because :6498 returns before the
   * `moved = false` on :6500. The TouchScrollState doc claims this, so here it
   * is asserted, along with the reason it is invisible: the only reader left is
   * the focus gate, and the null `startY` has already settled that.
   */
  it("keeps moved across a touchstart that disarms the drag", () => {
    const swiped = play(dragBy(200, 16, 2));
    expect(swiped.state.moved).toBe(true);
    const second = reduce(swiped.state, start(400, 2), world());
    expect(second.state.moved).toBe(true);
    expect(second.state.startY).toBeNull();
    expect(second.state.lastY).toBeNull();
    expect(reduce(second.state, end(64), world()).actions).toHaveLength(0);
  });

  it("clears the accumulator when a new gesture starts", () => {
    const r = play([...dragBy(200, 8, 1), start(300)]);
    expect(r.state.accumPx).toBe(0);
    expect(r.state.samples).toHaveLength(0);
    expect(r.state.emitted).toBe(false);
  });

  /**
   * A cancel ends the gesture with nothing on the wire: no wheel, no focus, no
   * coast. See the module header for how this differs from term.html, which
   * registers no touchcancel on the terminal element.
   */
  it("ends the gesture on a touchcancel", () => {
    const r = play([...dragBy(200, 16, 2), { type: "touchcancel" }]);
    expect(r.wheels).toHaveLength(2);
    expect(r.focuses).toBe(0);
    expect(r.coasting).toBe(false);
    expect(r.state.startY).toBeNull();
    expect(r.state.lastY).toBeNull();
    expect(r.state.moved).toBe(false);
    expect(r.state.emitted).toBe(false);
  });

  it("neither scrolls nor coasts after a touchcancel", () => {
    const after = play(
      [...dragBy(200, 16, 2), { type: "touchcancel" }, move(400, 48), end(64)],
      world(),
    );
    expect(after.wheels).toHaveLength(2);
    expect(after.focuses).toBe(0);
    expect(after.coasting).toBe(false);
  });

  /**
   * The five hard-cancel sites term.html spends on the coast: a trusted wheel
   * (:6281), a soft key (:6823), any byte typed at the pty (:8269, :8341) and a
   * reattach or session switch (:10294). All of them are one event here.
   */
  it("cancels the coast on an interrupt", () => {
    const w = world();
    const lift = reduce(released(400), end(100), w);
    const stopped = reduce(lift.state, { type: "interrupt" }, w);
    expect(stopped.coasting).toBe(false);
    expect(coastOut(stopped.state, w, 200).wheels).toHaveLength(0);
  });

  it("leaves an interrupt alone when nothing is coasting", () => {
    const r = reduce(NO_TOUCH_SCROLL, { type: "interrupt" }, world());
    expect(r.state).toBe(NO_TOUCH_SCROLL);
    expect(r.actions).toHaveLength(0);
  });

  /** A drag with no touchstart behind it has nothing to measure from. */
  it("ignores a move that no touchstart armed", () => {
    const r = reduce(NO_TOUCH_SCROLL, move(400, 16), world());
    expect(r.state).toBe(NO_TOUCH_SCROLL);
    expect(r.actions).toHaveLength(0);
  });

  it("ignores a two-finger move", () => {
    const r = play([start(200), move(400, 16, 2)]);
    expect(r.wheels).toHaveLength(0);
    expect(r.state.lastY).toBe(200);
  });
});

/**
 * The page and the port, as text, read once each.
 *
 * Citations are resolved by LINE NUMBER rather than grepped for anywhere in a
 * 1.5MB file, because a citation that has drifted to another line is one a
 * reader cannot follow, and `toContain` over the whole page cannot tell the
 * difference.
 */
const TERM_HTML = resolve(__dirname, "../..", "frontend/term.html");
let cachedHtml: string | null = null;
const html = (): string => (cachedHtml ??= readFileSync(TERM_HTML, "utf8"));
let cachedLines: readonly string[] | null = null;
const htmlLines = (): readonly string[] => (cachedLines ??= html().split("\n"));
/** One 1-indexed line of term.html, trimmed of its indentation. */
const lineAt = (n: number): string => (htmlLines()[n - 1] ?? "").trim();
/** An inclusive 1-indexed line range of term.html. */
const span = (from: number, to: number): string =>
  htmlLines()
    .slice(from - 1, to)
    .join("\n");
/**
 * Every 1-indexed line of term.html mentioning `needle`, in file order.
 *
 * For the claims that assert COMPLETENESS: "only the touch path writes this",
 * "these are its two callers". A `toContain` over the page cannot check those,
 * and a new caller added later is exactly what would make them false.
 */
const linesWith = (needle: string): readonly number[] =>
  htmlLines()
    .map((line, i) => [i + 1, line] as const)
    .filter(([, line]) => line.includes(needle))
    .map(([n]) => n);
let cachedSource: string | null = null;
const source = (): string =>
  (cachedSource ??= readFileSync(resolve(__dirname, "../src/terminal/touchscroll.ts"), "utf8"));
/** One named paragraph of the module header, by the two markers around it. */
const headerBlock = (from: string, to: string): string => {
  const src = source();
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  expect(a, from).toBeGreaterThan(-1);
  expect(b, to).toBeGreaterThan(a);
  return src.slice(a, b);
};

/**
 * These cases read the module's own header rather than calling `reduce`, and
 * that is all they can do: the DOM work lives in no code here, because the
 * module is pure and a different agent wires it. They are documentation guards,
 * so do not read them as behaviour coverage.
 */
describe("what the component is told to do", () => {
  const owes = (): string =>
    headerBlock("WHAT THE COMPONENT STILL OWES", "WHERE THIS IS NOT term.html LINE FOR LINE");

  /**
   * A pure module decides and the component performs, so this comment is the
   * only carrier for the DOM work. An action missing from that list is one
   * nobody performs.
   */
  it.each(["wheel", "focus"])("describes what to do with %s", (kind) => {
    expect(owes()).toContain(kind);
  });

  /**
   * The five easiest to wire wrongly: a non-passive touch listener taxes every
   * scroll's latency, the wheels have to land on `term.element`, only a TRUSTED
   * wheel may cancel the coast (our own are untrusted and would cancel
   * themselves), the frames come from requestAnimationFrame, and its timestamps
   * share a clock with `performance.now()` only if the lift used that clock too.
   */
  it.each(["passive", "term.element", "isTrusted", "requestAnimationFrame", "performance.now"])(
    "names %s among the wiring it depends on",
    (needle) => {
      expect(owes()).toContain(needle);
    },
  );

  /** The prefs are not in the SPA's Prefs type yet, so the wiring has to be told. */
  it.each(["scrollSpeedV2", "scrollMomentum"])("names the %s pref it needs read", (needle) => {
    expect(owes()).toContain(needle);
  });

  /**
   * THE GATE, which is the item on this list that decides whether the rest of
   * it is wired at all, and the one the list went two rounds of review without.
   * term.html's whole recognizer sits inside `if (isCoarsePointer)` (:6478), so
   * a component built from a list that names the three listeners and not the
   * gate attaches them everywhere, and on a machine answering `(pointer:
   * coarse)` false it then feeds line wheels to a pty term.html leaves alone.
   * That is a bug on hardware people own rather than a documentation nit, so
   * the citation, the query and the repo's own helper are pinned here.
   */
  it.each(["isCoarsePointer", "(pointer: coarse)", ":6478", ":6350", "mobile/pointer.ts"])(
    "names %s, the gate that decides whether the listeners exist at all",
    (needle) => {
      expect(owes()).toContain(needle);
    },
  );

  /**
   * And the helper the list points at is real, so the pointer cannot rot into a
   * file that does not export it. Read as text rather than imported: this suite
   * covers a pure module and importing pointer.ts would pull Solid in for a
   * documentation guard.
   */
  it("points at a coarse-pointer helper this repo actually exports", () => {
    const ptr = readFileSync(resolve(__dirname, "../src/mobile/pointer.ts"), "utf8");
    expect(ptr).toContain("export function isCoarsePointer()");
    expect(ptr).toContain('"(pointer: coarse)"');
  });

  /**
   * The world list says WHEN the page reads each field, not just that it reads
   * them fresh. Two of the five term.html reads at the lift alone, and a
   * blanket "fresh at each event" would have a wiring call
   * getBoundingClientRect on every touchmove for a number only the lift uses.
   */
  it.each(["LIFT", ":6156", ":6543", ":6119"])(
    "qualifies the world reads per field, naming %s",
    (needle) => {
      expect(owes()).toContain(needle);
    },
  );

  /**
   * And the screen box is measured per HOST. Several terminals are mounted at
   * once, so the bare `document.querySelector` term.html can afford would hand
   * every instance the same element, and a hidden one measures 0.
   */
  it.each(["ITS OWN host", "document.querySelector", "display: none"])(
    "scopes the screen-box read to the host, naming %s",
    (needle) => {
      expect(owes()).toContain(needle);
    },
  );
});

describe("what comes back", () => {
  /**
   * The identity contract, both halves. `TouchScrollReduction.state` used to
   * promise the same object back "whenever nothing moved", which is false for
   * every one of the three lifecycle events: they clear fields whether or not
   * those fields already held the cleared value, so they always allocate.
   */
  it("keeps identity on the paths that decide nothing", () => {
    const w = world();
    // A move no touchstart armed.
    expect(reduce(NO_TOUCH_SCROLL, move(400, 16), w).state).toBe(NO_TOUCH_SCROLL);
    // A move a second finger took.
    const armed = reduce(NO_TOUCH_SCROLL, start(200), w).state;
    expect(reduce(armed, move(400, 16, 2), w).state).toBe(armed);
    // A frame and an interrupt with no coast.
    expect(reduce(NO_TOUCH_SCROLL, { type: "frame", now: 1000 }, w).state).toBe(NO_TOUCH_SCROLL);
    expect(reduce(NO_TOUCH_SCROLL, { type: "interrupt" }, w).state).toBe(NO_TOUCH_SCROLL);
  });

  it("allocates on every touchstart, touchend and touchcancel", () => {
    const w = world();
    const lifecycle: readonly TouchScrollEvent[] = [
      start(200, 2),
      end(16),
      { type: "touchcancel" },
    ];
    for (const e of lifecycle) {
      const after = reduce(NO_TOUCH_SCROLL, e, w).state;
      expect(after).not.toBe(NO_TOUCH_SCROLL);
      // Equal by value, so identity is the ONLY difference and a caller that
      // compared by identity would see a change that is not one.
      expect(after).toEqual(NO_TOUCH_SCROLL);
    }
  });
});

describe("which world fields an event consults", () => {
  /**
   * The header says the screen box and the momentum pref are read at the LIFT
   * only, so a wiring may pass anything for them on a touchmove or a frame
   * rather than forcing a layout per move. That is a claim about THIS module
   * and not only about term.html, so it gets exercised: junk in both fields
   * changes nothing off the lift path.
   */
  it("ignores the screen box and the momentum pref off the lift path", () => {
    const sane = world();
    const junk = world({ screenHeightPx: Number.NaN, momentum: false });
    expect(play(dragBy(200, 16, 3), junk).wheels).toEqual(play(dragBy(200, 16, 3), sane).wheels);
    const lift = reduce(released(400), end(100), sane);
    expect(coastOut(lift.state, junk, 100)).toEqual(coastOut(lift.state, sane, 100));
  });

  /** And the other half, or the test above would pass on a module that read neither. */
  it("reads both at the lift, where they decide the coast", () => {
    const sane = world();
    // The cap is frozen at the lift: a 40px screen there ends this flick after
    // 3 frames, and the same 40px handed only to the frames does nothing.
    const tight = reduce(released(400), end(100), world({ screenHeightPx: 40 }));
    expect(coastOut(tight.state, sane, 100).frames).toBe(3);
    const loose = reduce(released(400), end(100), sane);
    expect(coastOut(loose.state, world({ screenHeightPx: 40 }), 100).frames).toBe(126);
    // Same shape for the pref: off at the lift is no coast at all.
    expect(reduce(released(400), end(100), world({ momentum: false })).coasting).toBe(false);
  });
});

describe("parity with term.html", () => {
  /**
   * Nine numbers tuned on a real phone, living in two places until term.html
   * retires: the eight below, and the swipe threshold in the test after them. A
   * port that quietly moved one hands back the feel it was tuned to.
   */
  it.each([
    ["MOMENTUM_TAU_MS", MOMENTUM_TAU_MS],
    ["MOMENTUM_STOP_ROWS_PER_S", MOMENTUM_STOP_ROWS_PER_S],
    ["MOMENTUM_MAX_COAST_SCREENS", MOMENTUM_MAX_COAST_SCREENS],
    ["MOMENTUM_MIN_START_ROWS_PER_S", MOMENTUM_MIN_START_ROWS_PER_S],
    ["GAP_STILL_MS", GAP_STILL_MS],
    ["GAP_ATTEN_TAU_MS", GAP_ATTEN_TAU_MS],
    ["SCROLL_MAX_EVENTS_PER_FEED", SCROLL_MAX_EVENTS_PER_FEED],
    ["VEL_WINDOW_MS", VEL_WINDOW_MS],
  ] as const)("uses the %s term.html ships", (name, value) => {
    const m = new RegExp(`const ${name} = ([\\d.]+);`).exec(html());
    expect(m, `${name} in term.html`).toBeTruthy();
    expect(Number(m?.[1])).toBe(value);
  });

  it("uses the swipe threshold term.html ships", () => {
    const m = /const SWIPE_THRESHOLD = (\d+);/.exec(html());
    expect(m, "SWIPE_THRESHOLD in term.html").toBeTruthy();
    expect(Number(m?.[1])).toBe(SWIPE_THRESHOLD_PX);
  });

  it("keeps the ring buffer and frame caps term.html ships", () => {
    const src = html();
    const ring = /scrollSamples\.length > (\d+)/.exec(src);
    expect(Number(ring?.[1])).toBe(VEL_SAMPLES_MAX);
    const frame = /Math\.min\((\d+), now - last\)/.exec(src);
    expect(Number(frame?.[1])).toBe(COAST_FRAME_CAP_MS);
  });

  /**
   * The classification lines, each pinned at the line the module header cites
   * AND paired with what the port does for it. Quoting the page alone would
   * pass a port that classified differently, which is the risk that matters
   * most here: these four are the part momentum was not allowed to change, so a
   * divergence is a regression in the oldest behaviour on the page.
   */
  it.each([
    {
      at: 6498,
      line: "if (e.touches.length !== 1) { startY = lastY = null; return; }",
      port: (): void => {
        const two = reduce(NO_TOUCH_SCROLL, start(200, 2), world());
        expect(two.state.startY).toBeNull();
        expect(two.state.lastY).toBeNull();
        const one = reduce(NO_TOUCH_SCROLL, start(200), world());
        expect(one.state.startY).toBe(200);
        expect(one.state.lastY).toBe(200);
      },
    },
    {
      at: 6507,
      line: "if (!moved && Math.abs(startY - y) > SWIPE_THRESHOLD) moved = true;",
      port: (): void => {
        const down = reduce(NO_TOUCH_SCROLL, start(200), world()).state;
        // Strictly greater, and measured from the landing point in both
        // directions.
        expect(reduce(down, move(206, 16), world()).state.moved).toBe(false);
        expect(reduce(down, move(207, 16), world()).state.moved).toBe(true);
        expect(reduce(down, move(194, 16), world()).state.moved).toBe(false);
        expect(reduce(down, move(193, 16), world()).state.moved).toBe(true);
      },
    },
    {
      at: 6508,
      line: "if (!moved || delta === 0 || !term.element) return;",
      port: (): void => {
        // All three gates, in the page's order.
        expect(play([start(200), move(204, 16)]).wheels).toHaveLength(0);
        const armed = play([start(200), move(240, 16)]);
        expect(armed.wheels).toHaveLength(2);
        const still = reduce(armed.state, move(240, 32), world());
        expect(still.actions).toHaveLength(0);
        expect(still.state.samples).toHaveLength(1);
        expect(play(dragBy(200, 8, 4), world({ mounted: false })).wheels).toHaveLength(0);
      },
    },
    {
      at: 6527,
      line: "if (!moved && startY !== null) tapFocus();",
      port: (): void => {
        expect(play([start(200), end(16)]).focuses).toBe(1);
        expect(play([...dragBy(200, 8, 3), end(64)]).focuses).toBe(0);
        expect(reduce(NO_TOUCH_SCROLL, end(16), world()).actions).toHaveLength(0);
      },
    },
  ])("classifies with term.html:$at, and so does the port", ({ at, line, port }) => {
    expect(lineAt(at)).toBe(line);
    port();
  });

  /**
   * Which comment marks those four as untouchable, and where it lives. The
   * note inside the touchstart handler covers the three lines under it and
   * stops there; the fourth line the port counts is in the touchend handler,
   * past the end of that note. What covers all four is the banner over the
   * whole scroller, so that is what the module header cites.
   */
  it("cites the comment that covers all four classification lines", () => {
    expect(span(6492, 6495)).toContain("The three CLASSIFICATION lines below");
    expect(lineAt(6527)).toBe("if (!moved && startY !== null) tapFocus();");
    expect(span(6070, 6071)).toContain("Only EMISSION/MOMENTUM changed; tap-vs-swipe");
    expect(span(6070, 6071)).toContain("CLASSIFICATION is byte-identical");
    const redLine = headerBlock(
      "THE CLASSIFICATION IS THE RED LINE",
      "One thing is deliberately NOT gated",
    );
    expect(redLine).toContain(":6070-6071");
  });

  /**
   * The wheel init, field for field on both sides, and the accumulator
   * arithmetic the count comes from. A port that shipped deltaMode 0, or lost
   * the carried clientY, or floored the count instead of truncating it, would
   * still satisfy a grep of the page.
   */
  it("emits the wheel term.html emits, field for field", () => {
    const init = span(6107, 6112);
    expect(init).toContain("deltaY: sign < 0 ? -1 : 1,");
    expect(init).toContain("deltaMode: 1,");
    expect(init).toContain("bubbles: true, cancelable: true,");
    expect(init).toContain("clientX: 0, clientY: scrollLastEmitY,");
    expect(play(dragBy(200, 16, 1)).wheels).toEqual([
      {
        deltaY: -1,
        deltaMode: 1,
        bubbles: true,
        cancelable: true,
        clientX: 0,
        clientY: 216,
      },
    ]);
    // :6121 carries a trailing comment, so it is matched rather than compared.
    expect(lineAt(6121)).toContain("let k = Math.trunc(scrollAccumPx / rowPx);");
    expect(lineAt(6125)).toBe("scrollAccumPx -= k * rowPx;");
    // Truncation and the kept remainder, which is what those two lines are:
    // 53px of travel is three rows and 5px owed, not four rows.
    const kept = play([start(200), move(253, 16)]);
    expect(kept.wheels).toHaveLength(3);
    expect(kept.state.accumPx).toBeCloseTo(-5, 10);
  });

  /** The starting y of a synthetic wheel before any drag has set one (:6087). */
  it("starts from the same carried clientY", () => {
    const m = /let scrollLastEmitY = (\d+);/.exec(html());
    expect(Number(m?.[1])).toBe(NO_TOUCH_SCROLL.emitY);
  });

  /**
   * The gate, pinned at the two lines the owes list cites, plus the three
   * listeners sitting inside it. Everything in the ported range is under this
   * `if`, so a component that attaches unconditionally diverges from the page
   * on every machine where the query answers false.
   */
  it("gates the whole recognizer on the coarse-pointer query, at :6350 and :6478", () => {
    expect(lineAt(6350)).toBe("const isCoarsePointer = matchMedia('(pointer: coarse)').matches;");
    expect(lineAt(6478)).toBe("if (isCoarsePointer) {");
    // The three listeners the owes list asks for, all below that line.
    expect(lineAt(6491)).toContain("terminalEl.addEventListener('touchstart'");
    expect(lineAt(6502)).toContain("terminalEl.addEventListener('touchmove'");
    expect(lineAt(6526)).toContain("terminalEl.addEventListener('touchend'");
    // No fourth: term.html registers no touchcancel on the terminal element,
    // which is the divergence the header's own note owns.
    expect(html()).not.toContain("terminalEl.addEventListener('touchcancel'");
    // And the page's reason for leaving a fine-pointer machine alone.
    expect(span(6399, 6400)).toContain("touch-capable desktops keep native 2-finger");
    expect(span(6399, 6400)).toContain("scrolling latency-free");
  });

  /**
   * The carried clientY is SHARED with the desktop wheel pacer, which the OUT
   * OF SCOPE note used to call private ("shares emitLineWheel and nothing
   * else"). One `emitLineWheel` reads one `scrollLastEmitY` for its clientY,
   * and both the touch feed and `pumpWheel` call it, so the y this module owns
   * as `emitY` is the y a trackpad's wheels carry too. wheel.ts keeps that
   * deliberately, because the mouse report's cell is derived from the
   * coordinate: a wiring that gave the desktop path the wheel's own clientY
   * would change which tmux pane a trackpad report lands in.
   */
  it("shares the carried clientY with the desktop wheel pacer", () => {
    expect(span(6105, 6113)).toContain("clientX: 0, clientY: scrollLastEmitY,");
    // Three mentions in the whole page: the declaration, the read inside
    // emitLineWheel, and the touch path as its only writer.
    expect(linesWith("scrollLastEmitY")).toEqual([6087, 6111, 6522]);
    expect(lineAt(6522)).toBe("scrollLastEmitY = y;");
    // Both callers of the one primitive.
    expect(lineAt(6127)).toContain("emitLineWheel(sign)");
    expect(lineAt(6222)).toContain("emitLineWheel(sign)");
    expect(lineAt(6212)).toBe("function pumpWheel() {");
    // The other three the note names as shared, each pinned by its FULL caller
    // list, because the note claims completeness for them.
    expect(lineAt(6082)).toContain("const SCROLL_MAX_EVENTS_PER_FEED = 10;");
    expect(linesWith("SCROLL_MAX_EVENTS_PER_FEED")).toEqual([6082, 6123, 6124, 6218, 6219, 6254]);
    // 6119/6150/6551 touch, 6214/6239/6254 desktop, 6290 the selection
    // wheel-clear the note routes to selection.ts.
    expect(linesWith("xtermCellH()")).toEqual([6094, 6119, 6150, 6214, 6239, 6254, 6290, 6551]);
    expect(linesWith("xtermScreenH()")).toEqual([6098, 6156, 6240]);
    // And the note says so, rather than calling the coupling private.
    const scope = headerBlock("OUT OF SCOPE, on purpose.", "*/");
    for (const needle of ["emitLineWheel", "scrollLastEmitY", "SCROLL_MAX_EVENTS_PER_FEED"]) {
      expect(scope, needle).toContain(needle);
    }
  });

  /**
   * Where the page reads each world field, which is what the per-field notes in
   * the header now claim. Inside the ported range the screen box is measured at
   * the lift and nowhere else, and so is the momentum pref.
   */
  it("reads the screen box and the momentum pref at the lift only", () => {
    // Inside the scroller's own range: the definition, and one read at the
    // coast cap.
    expect(linesWith("xtermScreenH()").filter((n) => n >= 6056 && n <= 6171)).toEqual([6098, 6156]);
    expect(lineAt(6156)).toBe("const capPx = MOMENTUM_MAX_COAST_SCREENS * xtermScreenH();");
    // The momentum pref: its definition and one caller, in the touchend.
    expect(linesWith("scrollMomentumOn()")).toEqual([6093, 6543]);
    expect(lineAt(6543)).toContain("if (scrollEmittedGesture && scrollMomentumOn()) {");
    // The three that ARE read per event, at the sites the header cites.
    expect(lineAt(6119)).toBe("const rowPx = xtermCellH() / scrollSpeedMult();");
    expect(lineAt(6508)).toBe("if (!moved || delta === 0 || !term.element) return;");
    expect(lineAt(6161)).toContain("!term.element");
    // Both box helpers query the document, which is what one terminal per
    // document can afford and several mounted at once cannot.
    expect(lineAt(6095)).toBe("const scr = document.querySelector('.xterm-screen');");
    expect(lineAt(6099)).toBe("const scr = document.querySelector('.xterm-screen');");
  });

  /**
   * The scroll-speed enumeration, taken OUT of the page rather than restated
   * here, and then fed to the port: the four values the ternary accepts pass
   * through unchanged, and anything else lands on the fallback the page names.
   */
  it("accepts the scroll speeds term.html accepts", () => {
    const m =
      /\(v === ([\d.]+) \|\| v === ([\d.]+) \|\| v === ([\d.]+) \|\| v === ([\d.]+)\) \? v : ([\d.]+)/.exec(
        html(),
      );
    expect(m, "the scrollSpeedV2 ternary in term.html").toBeTruthy();
    const accepted = [m?.[1], m?.[2], m?.[3], m?.[4]].map(Number);
    expect(accepted).toEqual([1, 1.5, 2, 3]);
    for (const v of accepted) expect(scrollSpeedMult(v)).toBe(v);
    const fallback = Number(m?.[5]);
    for (const v of [0, -2, 2.5, 10, Number.NaN]) expect(scrollSpeedMult(v)).toBe(fallback);
  });
});
