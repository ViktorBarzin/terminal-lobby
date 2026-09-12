import { describe, it, expect } from "vitest";
import {
  MAX_PLAUSIBLE_ECHO_MS,
  TypingLatency,
} from "../src/diagnostics/typing";


describe("TypingLatency", () => {
  it("measures the gap from a keystroke to the next output frame", () => {
    let now = 1000;
    const tl = new TypingLatency(() => now);
    tl.onInput();
    now = 1042;
    tl.onOutput();
    expect(tl.takeRollup()).toMatchObject({ n: 1, p50: 42, max: 42 });
  });

  // The whole reason this is a class and not a subtraction. A TUI writes
  // constantly, so only the FIRST frame after a keystroke can be attributed
  // to it; everything after is the app redrawing on its own schedule.
  it("attributes only the first output after a keystroke", () => {
    let now = 0;
    const tl = new TypingLatency(() => now);
    tl.onInput();
    now = 20; tl.onOutput();
    now = 500; tl.onOutput();
    now = 900; tl.onOutput();
    expect(tl.takeRollup()).toMatchObject({ n: 1, max: 20 });
  });

  // Holding a key or pasting produces a burst. The pending mark must not be
  // overwritten by a later keystroke, or the measured gap shrinks to the time
  // between the LAST key and the frame and every burst reads as fast.
  it("keeps the first pending keystroke across a burst", () => {
    let now = 0;
    const tl = new TypingLatency(() => now);
    tl.onInput();
    now = 10; tl.onInput();
    now = 20; tl.onInput();
    now = 300; tl.onOutput();
    expect(tl.takeRollup()).toMatchObject({ n: 1, max: 300 });
  });

  // Output with no keystroke behind it is the app talking to itself, which is
  // most of what a Claude session emits. It must not enter the distribution.
  it("ignores output that no keystroke preceded", () => {
    let now = 0;
    const tl = new TypingLatency(() => now);
    tl.onOutput();
    now = 50; tl.onOutput();
    expect(tl.takeRollup()).toBeNull();
  });

  // Someone types, walks away, and something prints ten minutes later. That
  // is not typing latency and would wreck a p95.
  it("discards an implausibly long gap instead of recording it", () => {
    let now = 0;
    const tl = new TypingLatency(() => now);
    tl.onInput();
    now = MAX_PLAUSIBLE_ECHO_MS + 1;
    tl.onOutput();
    expect(tl.takeRollup()).toBeNull();
  });

  it("reports p50 and p95 over the window", () => {
    let now = 0;
    const tl = new TypingLatency(() => now);
    for (const ms of [10, 20, 30, 40, 50, 60, 70, 80, 90, 1000]) {
      tl.onInput();
      now += ms;
      tl.onOutput();
    }
    const r = tl.takeRollup()!;
    expect(r.n).toBe(10);
    expect(r.p50).toBeGreaterThanOrEqual(50);
    expect(r.p50).toBeLessThanOrEqual(60);
    expect(r.max).toBe(1000);
    expect(r.p95).toBe(1000);
  });

  it("resets after a rollup so windows do not overlap", () => {
    let now = 0;
    const tl = new TypingLatency(() => now);
    tl.onInput(); now = 5; tl.onOutput();
    expect(tl.takeRollup()!.n).toBe(1);
    expect(tl.takeRollup()).toBeNull();
  });

  // This sits on the terminal's hottest path, every keystroke and every frame.
  // It must never grow without bound if a rollup is never taken.
  it("bounds memory when nothing ever collects a rollup", () => {
    let now = 0;
    const tl = new TypingLatency(() => now);
    for (let i = 0; i < 100_000; i++) {
      tl.onInput(); now += 1; tl.onOutput();
    }
    expect(tl.sampleCount()).toBeLessThanOrEqual(2048);
  });
});
