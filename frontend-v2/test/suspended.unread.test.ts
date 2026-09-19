import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createVisitStore, type VisitSession } from "../src/store/visits";

/**
 * What suspending a session does to "have I read this yet".
 *
 * The answer chosen: NOTHING. Suspension is the sweep's decision about memory,
 * taken 72 hours after anybody last touched the session, and reading is
 * something a person does. So the latch a session carries into a suspend is
 * the latch it carries out of one.
 *
 * Both directions matter, and the second is the one that would have broken by
 * accident. `isUnseen` keys off `state === "done"`, and a suspended session
 * reports `suspended` instead — so the mark would drop on the way in. Worse,
 * the state STAMP would be rewritten twice (done → suspended → done), and the
 * second rewrite lands after the visit that had already marked it read, so a
 * session the user had finished with would come back unread on resume. Leaving
 * the stamp alone for a suspended session fixes both with one rule.
 */

const s = (name: string, state: string): VisitSession => ({ name, state });

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, tick: (ms = 1000) => (t += ms) };
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("the unread latch across a suspend", () => {
  it("keeps the mark on work that finished and was never looked at", () => {
    const c = clock();
    const v = createVisitStore({ now: c.now, visible: () => true });
    v.observe([s("a", "running")], null);
    c.tick();
    v.observe([s("a", "done")], null);
    expect(v.isUnseen(s("a", "done"))).toBe(true);

    c.tick(72 * 3600 * 1000);
    v.observe([s("a", "suspended")], null);
    expect(v.isUnseen(s("a", "suspended"))).toBe(true);
  });

  it("does not invent an unread on a session that was already read", () => {
    const c = clock();
    const v = createVisitStore({ now: c.now, visible: () => true });
    v.observe([s("a", "running")], null);
    c.tick();
    v.observe([s("a", "done")], "a"); // looked at it
    expect(v.isUnseen(s("a", "done"))).toBe(false);

    c.tick(72 * 3600 * 1000);
    v.observe([s("a", "suspended")], null);
    expect(v.isUnseen(s("a", "suspended"))).toBe(false);

    c.tick();
    v.observe([s("a", "done")], null); // resumed, nobody watching
    expect(v.isUnseen(s("a", "done"))).toBe(false);
  });

  it("claims nothing about a session it first met suspended", () => {
    const v = createVisitStore({ now: clock().now, visible: () => true });
    v.observe([s("a", "suspended")], null);
    expect(v.isUnseen(s("a", "suspended"))).toBe(false);
  });

  it("still prunes a suspended session that goes away", () => {
    // The stamp is left alone, not made immortal: a killed session's records
    // must still be collected.
    const c = clock();
    const v = createVisitStore({ now: c.now, visible: () => true });
    v.observe([s("a", "done"), s("b", "done")], null);
    c.tick();
    v.observe([s("b", "done")], null);
    expect(JSON.parse(localStorage.getItem("tl:session-states:v1") ?? "{}")).not.toHaveProperty(
      "a",
    );
  });
});
