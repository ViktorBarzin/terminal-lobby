import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createVisitStore,
  STATES_KEY,
  VISITS_KEY,
  type VisitSession,
} from "../src/store/visits";

/**
 * Most cases pass `visible: () => true` explicitly. The real default is "on
 * screen AND focused", and jsdom reports no focus, so a store left on the
 * default would never stamp anything and every case would be testing the same
 * thing. The focus rule has its own describe at the bottom.
 *
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
    const v = createVisitStore({ now: c.now, visible: () => true });
    v.observe([running("a")], null);
    c.tick();
    v.observe([done("a")], null);
    expect(v.isUnseen(done("a"))).toBe(true);
  });

  it("never counts a running or awaiting session as unseen-done", () => {
    const v = createVisitStore({ now: clock().now, visible: () => true });
    v.observe([running("a"), { name: "b", state: "awaiting" }], null);
    expect(v.isUnseen(running("a"))).toBe(false);
    expect(v.isUnseen({ name: "b", state: "awaiting" })).toBe(false);
  });

  it("clears unseen for the session the user is looking at", () => {
    const c = clock();
    const v = createVisitStore({ now: c.now, visible: () => true });
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
    const v = createVisitStore({ now: c.now, visible: () => true });
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
    const v = createVisitStore({ now: c.now, visible: () => true });
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
    const v = createVisitStore({ now: c.now, visible: () => true });
    v.observe([done("a")], "a");
    // the shape the palette's recents-first sort already reads
    expect(JSON.parse(localStorage.getItem(VISITS_KEY) as string)).toEqual({
      a: c.now(),
    });
  });

  it("survives a reload: a session seen before the reload stays seen", () => {
    const c = clock();
    createVisitStore({ now: c.now, visible: () => true }).observe([done("a")], "a");
    c.tick();
    const reloaded = createVisitStore({ now: c.now, visible: () => true });
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
    const v = createVisitStore({ now: c.now, visible: () => true });
    v.observe([done("a"), done("b")], "a");
    c.tick();
    v.observe([done("b")], null); // 'a' was killed
    expect(JSON.parse(localStorage.getItem(VISITS_KEY) as string)).toEqual({});
  });

  it("degrades quietly on corrupt storage", () => {
    localStorage.setItem(VISITS_KEY, "{not json");
    localStorage.setItem(STATES_KEY, "[]");
    const v = createVisitStore({ now: clock().now, visible: () => true });
    expect(() => v.observe([done("a")], null)).not.toThrow();
    expect(v.isUnseen(done("a"))).toBe(true);
  });
});

describe("createVisitStore — revision (repaint trigger)", () => {
  it("bumps when the unseen set changes, and NOT on a repeated stamp", () => {
    const c = clock();
    const v = createVisitStore({ now: c.now, visible: () => true });
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

/**
 * The boot wipe (found 2026-09-01). `observe` prunes its records against the
 * list it is handed, and the notification effect used to hand it the pre-poll
 * EMPTY list on every mount — deleting every visit and every state stamp, so
 * the first real poll re-stamped each session as freshly finished and the whole
 * account came back unread. On iOS a notification tap cold-launches the PWA,
 * which is a mount, which was a wipe.
 */
describe("createVisitStore — an empty list is 'not known yet'", () => {
  it("prunes nothing when handed an empty session list", () => {
    const c = clock();
    const v = createVisitStore({ now: c.now, visible: () => true });
    v.observe([running("a")], null);
    c.tick();
    v.observe([done("a")], null);
    c.tick();
    v.observe([done("a")], "a"); // looked at it
    expect(v.isUnseen(done("a"))).toBe(false);

    v.observe([], null); // a mount, before the first poll answers

    c.tick();
    v.observe([done("a")], null);
    expect(v.isUnseen(done("a"))).toBe(false); // still seen
  });

  it("keeps the persisted records across an empty observe", () => {
    const c = clock();
    const v = createVisitStore({ now: c.now, visible: () => true });
    v.observe([done("a")], "a");
    const visitsBefore = localStorage.getItem(VISITS_KEY);
    const statesBefore = localStorage.getItem(STATES_KEY);

    v.observe([], null);

    expect(localStorage.getItem(VISITS_KEY)).toBe(visitsBefore);
    expect(localStorage.getItem(STATES_KEY)).toBe(statesBefore);
  });

  it("still prunes a session that a REAL poll no longer lists", () => {
    const c = clock();
    const v = createVisitStore({ now: c.now, visible: () => true });
    v.observe([done("a"), done("b")], "a");
    v.observe([done("b")], null); // a genuinely shorter list
    const visits = JSON.parse(localStorage.getItem(VISITS_KEY) || "{}");
    expect(Object.keys(visits)).not.toContain("a");
  });
});

/**
 * Seen means LOOKED AT. `!document.hidden` alone was true for a desktop window
 * sitting behind an editor, so a turn that finished while the user was in
 * another app was stamped read and never reached the unread count.
 */
describe("createVisitStore — seen requires focus, not just visibility", () => {
  it("does not stamp a session while the window is visible but unfocused", () => {
    const c = clock();
    const v = createVisitStore({ now: c.now, visible: () => false });
    v.observe([running("a")], "a");
    c.tick();
    v.observe([done("a")], "a");
    expect(v.isUnseen(done("a"))).toBe(true);
  });

  it("stamps it once the window has focus", () => {
    const c = clock();
    const v = createVisitStore({ now: c.now, visible: () => true });
    v.observe([running("a")], "a");
    c.tick();
    v.observe([done("a")], "a");
    expect(v.isUnseen(done("a"))).toBe(false);
  });
});

/**
 * Records follow the SESSION, not its name. A rename made in another tab, on the
 * phone, or with `tmux rename-session` used to look like one session vanishing
 * and a stranger arriving: the visit was pruned, and a completion the user had
 * already read came back unread. Only a rename made in the same tab was carried,
 * by a listener that no longer needs to exist.
 */
describe("createVisitStore — keyed by tmux session id", () => {
  const withId = (name: string, id: string, state = "done"): VisitSession =>
    ({ name, id, state });

  it("carries a visit across a rename nothing told it about", () => {
    const c = clock();
    const v = createVisitStore({ now: c.now, visible: () => true });
    v.observe([{ name: "old", id: "$1", state: "running" }], null);
    c.tick();
    v.observe([withId("old", "$1")], "old"); // finished, and read
    expect(v.isUnseen(withId("old", "$1"))).toBe(false);

    // The next poll shows the same session under a new name.
    v.observe([withId("new", "$1")], null);
    expect(v.isUnseen(withId("new", "$1"))).toBe(false);
  });

  it("carries records written before the switch, once, without a flash of unread", () => {
    const c = clock(1_000);
    // A record from the old scheme: keyed by NAME.
    localStorage.setItem(VISITS_KEY, JSON.stringify({ alpha: 2_000 }));
    localStorage.setItem(STATES_KEY, JSON.stringify({ alpha: { state: "done", at: 1_000 } }));
    const v = createVisitStore({ now: c.now, visible: () => true });

    v.observe([withId("alpha", "$7")], null);

    expect(v.isUnseen(withId("alpha", "$7"))).toBe(false); // still seen
    const visits = JSON.parse(localStorage.getItem(VISITS_KEY) || "{}");
    expect(visits["$7"]).toBe(2_000);
    expect(visits.alpha).toBeUndefined();
  });

  it("still works for a session with no id at all", () => {
    const c = clock();
    const v = createVisitStore({ now: c.now, visible: () => true });
    v.observe([running("plain")], null);
    c.tick();
    v.observe([done("plain")], null);
    expect(v.isUnseen(done("plain"))).toBe(true);
    v.observe([done("plain")], "plain");
    expect(v.isUnseen(done("plain"))).toBe(false);
  });

  it("does not let a new session inherit a dead session's record by name", () => {
    const c = clock();
    const v = createVisitStore({ now: c.now, visible: () => true });
    v.observe([withId("work", "$1", "running")], null);
    c.tick();
    v.observe([withId("work", "$1")], "work"); // read
    // The session is killed and a NEW one is created with the same name.
    c.tick();
    v.observe([withId("work", "$2")], null);
    expect(v.isUnseen(withId("work", "$2"))).toBe(true);
  });
});
