import { describe, expect, it } from "vitest";
import { leadingThrottle } from "../src/terminal/claim";

/**
 * The rate limit on the pointer's grid claim.
 *
 * A mouse crossing a terminal fires `pointermove` at roughly 100 Hz (the
 * measurement TerminalNative's own drag code carries), and every one of those
 * is a device saying "I am here, give me the window". Unthrottled, one sweep
 * would be a hundred calls into the claim path.
 *
 * LEADING EDGE, which is the half worth testing. The whole point of claiming on
 * a pointer move is that the window comes back the instant you touch the
 * device, so the FIRST move of a sweep has to pass and the rest of the quarter
 * second has to be dropped. A trailing throttle would put 250 ms of lag on
 * exactly the interaction it exists to make feel immediate.
 *
 * Clock injected rather than faked globally, so this stays a unit: the
 * component's own tests already own the timer-faking.
 */
describe("the pointer claim's throttle", () => {
  const clockFrom = (start: number) => {
    let t = start;
    return { now: () => t, advance: (ms: number) => void (t += ms) };
  };

  it("passes the first call, before any time has gone by", () => {
    const c = clockFrom(0);
    const may = leadingThrottle(250, c.now);
    expect(may()).toBe(true);
  });

  it("drops everything inside the window", () => {
    const c = clockFrom(1_000);
    const may = leadingThrottle(250, c.now);
    expect(may()).toBe(true);
    c.advance(1);
    expect(may()).toBe(false);
    c.advance(248);
    expect(may()).toBe(false);
  });

  it("passes again once the window is over", () => {
    const c = clockFrom(1_000);
    const may = leadingThrottle(250, c.now);
    expect(may()).toBe(true);
    c.advance(250);
    expect(may()).toBe(true);
  });

  /** A dropped call must not push the window out, or a continuous sweep would
   *  never claim again after its first move. */
  it("measures the window from the last call that PASSED", () => {
    const c = clockFrom(0);
    const may = leadingThrottle(250, c.now);
    expect(may()).toBe(true);
    // A sweep: ten moves inside the window, all dropped.
    for (let i = 0; i < 10; i++) {
      c.advance(20);
      expect(may()).toBe(false);
    }
    // 200 ms of moves have gone by. 50 ms more and the window is up.
    c.advance(50);
    expect(may()).toBe(true);
  });

  it("cuts a one-second 100 Hz sweep to four claims", () => {
    const c = clockFrom(0);
    const may = leadingThrottle(250, c.now);
    let passed = 0;
    for (let i = 0; i < 100; i++) {
      if (may()) passed++;
      c.advance(10);
    }
    expect(passed).toBe(4);
  });

  /** Two terminals in a workspace each hold their own, so a sweep over one
   *  tile cannot spend the other's budget. */
  it("keeps one window per throttle, not one globally", () => {
    const c = clockFrom(0);
    const a = leadingThrottle(250, c.now);
    const b = leadingThrottle(250, c.now);
    expect(a()).toBe(true);
    expect(b()).toBe(true);
    c.advance(10);
    expect(a()).toBe(false);
    expect(b()).toBe(false);
  });
});
