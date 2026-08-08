import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createVisitStore,
  STATES_KEY,
  VISITS_KEY,
  type VisitSession,
} from "../src/store/visits";

/**
 * Seen/visit tracking (inventory Cat.2) — the store the v2 port was missing, so
 * the tab-title `(N✓)` badge counted every `done` session forever instead of the
 * ones the user has not looked at yet.
 */

const done = (name: string): VisitSession => ({ name, state: "done" });
const running = (name: string): VisitSession => ({ name, state: "running" });

/** A clock the test drives, so "the state changed AFTER my visit" is exact. */
function clock(start = 1_000) {
  let t = start;
  return { now: () => t, tick: (ms = 1000) => (t += ms) };
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("createVisitStore — unseen-done", () => {
  it("counts a finished session the user has never looked at as unseen", () => {
    const c = clock();
    const v = createVisitStore({ now: c.now });
    v.observe([running("a")], null);
    c.tick();
    v.observe([done("a")], null);
    expect(v.isUnseen(done("a"))).toBe(true);
  });

  it("never counts a running or awaiting session as unseen-done", () => {
    const v = createVisitStore({ now: clock().now });
    v.observe([running("a"), { name: "b", state: "awaiting" }], null);
    expect(v.isUnseen(running("a"))).toBe(false);
    expect(v.isUnseen({ name: "b", state: "awaiting" })).toBe(false);
  });

  it("clears unseen for the session the user is looking at", () => {
    const c = clock();
    const v = createVisitStore({ now: c.now });
    v.observe([running("a"), running("b")], null);
    c.tick();
    v.observe([done("a"), done("b")], null);
    expect(v.isUnseen(done("a"))).toBe(true);
    // the user selects/attaches 'a' — the next poll folds the visit in
    c.tick();
    v.observe([done("a"), done("b")], "a");
    expect(v.isUnseen(done("a"))).toBe(false);
    expect(v.isUnseen(done("b"))).toBe(true); // untouched sessions still badge
  });

  it("re-badges a session that finishes AGAIN after the last visit", () => {
    const c = clock();
    const v = createVisitStore({ now: c.now });
    v.observe([done("a")], "a"); // seen while attached
    expect(v.isUnseen(done("a"))).toBe(false);
    c.tick();
    v.observe([running("a")], null); // detached, new turn starts
    c.tick();
    v.observe([done("a")], null); // finishes while away
    expect(v.isUnseen(done("a"))).toBe(true);
  });

  it("does NOT stamp a visit while the tab is hidden (an away completion still badges)", () => {
    const c = clock();
    const v = createVisitStore({ now: c.now, visible: () => false });
    v.observe([running("a")], "a");
    c.tick();
    v.observe([done("a")], "a"); // attached, but the tab is in the background
    expect(v.isUnseen(done("a"))).toBe(true);
  });

  it("stamp() marks a session seen straight away (visibility/focus return)", () => {
    const c = clock();
    const v = createVisitStore({ now: c.now });
    v.observe([running("a")], null);
    c.tick();
    v.observe([done("a")], null);
    expect(v.isUnseen(done("a"))).toBe(true);
    c.tick();
    v.stamp("a");
    expect(v.isUnseen(done("a"))).toBe(false);
    expect(() => v.stamp(null)).not.toThrow();
  });
});

describe("createVisitStore — persistence", () => {
  it("persists visits under tl:session-visits:v1 as name → epoch ms", () => {
    const c = clock();
    const v = createVisitStore({ now: c.now });
    v.observe([done("a")], "a");
    // the shape the palette's recents-first sort already reads
    expect(JSON.parse(localStorage.getItem(VISITS_KEY) as string)).toEqual({
      a: c.now(),
    });
  });

  it("survives a reload: a session seen before the reload stays seen", () => {
    const c = clock();
    createVisitStore({ now: c.now }).observe([done("a")], "a");
    c.tick();
    const reloaded = createVisitStore({ now: c.now });
    expect(reloaded.isUnseen(done("a"))).toBe(false);
  });

  it("seeds state stamps from the lobby store's tl:session-states:v1", () => {
    // the lobby store owns that key; a reload must not lose the unseen latch
    localStorage.setItem(STATES_KEY, JSON.stringify({ a: { state: "done", at: 2000 } }));
    localStorage.setItem(VISITS_KEY, JSON.stringify({ a: 1000 }));
    const v = createVisitStore({ now: clock(3000).now });
    expect(v.isUnseen(done("a"))).toBe(true); // finished at 2000, last looked at 1000
  });

  it("prunes sessions that no longer exist", () => {
    const c = clock();
    const v = createVisitStore({ now: c.now });
    v.observe([done("a"), done("b")], "a");
    c.tick();
    v.observe([done("b")], null); // 'a' was killed
    expect(JSON.parse(localStorage.getItem(VISITS_KEY) as string)).toEqual({});
  });

  it("degrades quietly on corrupt storage", () => {
    localStorage.setItem(VISITS_KEY, "{not json");
    localStorage.setItem(STATES_KEY, "[]");
    const v = createVisitStore({ now: clock().now });
    expect(() => v.observe([done("a")], null)).not.toThrow();
    expect(v.isUnseen(done("a"))).toBe(true);
  });
});

describe("createVisitStore — revision (repaint trigger)", () => {
  it("bumps when the unseen set changes, and NOT on a repeated stamp", () => {
    const c = clock();
    const v = createVisitStore({ now: c.now });
    v.observe([running("a")], null);
    const seed = v.revision();

    c.tick();
    v.observe([done("a")], null); // 'a' becomes unseen → repaint
    const afterDone = v.revision();
    expect(afterDone).toBeGreaterThan(seed);

    c.tick();
    v.observe([done("a")], "a"); // the user looks → repaint (badge clears)
    const afterVisit = v.revision();
    expect(afterVisit).toBeGreaterThan(afterDone);

    // Re-stamping an already-seen session is NOT a change: the paint effect
    // stamps inside itself, so a bump here would loop forever.
    c.tick();
    v.observe([done("a")], "a");
    v.stamp("a");
    expect(v.revision()).toBe(afterVisit);
  });
});
