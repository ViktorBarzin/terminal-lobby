import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createNotificationSystem } from "../src/notify/notifications";
import type { TitleSession } from "../src/notify/title";
import { VISITS_KEY, STATES_KEY } from "../src/store/visits";

/**
 * The app-icon badge, driven through the REAL notification system and the REAL
 * visit store — the seam where both reported bugs actually lived.
 *
 * Neither could be caught by the existing suites: appbadge.test.ts always
 * injects the unseen predicate, so it never exercises the visit store, and
 * visits.store.test.ts never mounts the effect that folds a poll in. The bugs
 * were in the CALLER both times.
 */
vi.mock("../src/notify/favicon", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/notify/favicon")>();
  return { ...actual, createFaviconBadger: () => ({ apply: () => {} }) };
});

const badges: number[] = [];

beforeEach(() => {
  localStorage.clear();
  badges.length = 0;
  // The visit store only stamps a session seen while the tab is on screen AND
  // focused. jsdom reports no focus, so say the user is looking at the app.
  Object.defineProperty(document, "hasFocus", { value: () => true, configurable: true });
  Object.defineProperty(navigator, "setAppBadge", {
    value: (n: number) => {
      badges.push(n);
      return Promise.resolve();
    },
    configurable: true,
  });
  Object.defineProperty(navigator, "clearAppBadge", {
    value: () => {
      badges.push(0);
      return Promise.resolve();
    },
    configurable: true,
  });
});
afterEach(() => {
  localStorage.clear();
  Reflect.deleteProperty(navigator as object, "setAppBadge");
  Reflect.deleteProperty(navigator as object, "clearAppBadge");
});

const done = (name: string): TitleSession => ({ name, state: "done" });

/** Mount the system the way App does, with the signals a caller controls. */
function mount(init: {
  sessions: TitleSession[];
  selected?: string | null;
  polls?: number;
  loading?: boolean;
}) {
  const [sessions, setSessions] = createSignal<TitleSession[]>(init.sessions);
  const [selected, setSelected] = createSignal<string | null>(init.selected ?? null);
  const [polls, setPolls] = createSignal(init.polls ?? 0);
  const [loading, setLoading] = createSignal(init.loading ?? true);
  let dispose!: () => void;
  createRoot((d) => {
    dispose = d;
    createNotificationSystem({
      sessions,
      selected,
      osUser: () => "wizard",
      notifyPrefs: () => ({ onDone: true, onAwaiting: true }),
      loading,
      polls,
      toast: () => {},
      onActivateSession: () => {},
    });
  });
  return { setSessions, setSelected, setPolls, setLoading, dispose };
}

/** Records that say: eight sessions finished, and all eight have been read. */
function seedAllRead(names: string[], at = 1_000) {
  const visits: Record<string, number> = {};
  const states: Record<string, { state: string; at: number }> = {};
  for (const n of names) {
    states[n] = { state: "done", at };
    visits[n] = at + 1; // looked at it AFTER it finished
  }
  localStorage.setItem(VISITS_KEY, JSON.stringify(visits));
  localStorage.setItem(STATES_KEY, JSON.stringify(states));
}

const EIGHT = ["a", "b", "c", "d", "e", "f", "g", "h"];

describe("the app-icon badge, end to end", () => {
  it("counts only unread work: eight finished sessions you have read plus one asking = 1", () => {
    seedAllRead(EIGHT);
    const list = [...EIGHT.map(done), { name: "i", state: "awaiting" }];
    const m = mount({ sessions: list, polls: 1, loading: false });
    expect(badges.at(-1)).toBe(1);
    m.dispose();
  });

  it("does not wipe the seen records when it mounts before the first poll", () => {
    seedAllRead(EIGHT);
    const before = localStorage.getItem(VISITS_KEY);

    // Mount with nothing known yet — exactly what an app launch looks like.
    const m = mount({ sessions: [], polls: 0, loading: true });
    expect(localStorage.getItem(VISITS_KEY)).toBe(before);

    // Now the first poll answers with the same eight, all still read.
    m.setSessions([...EIGHT.map(done), { name: "i", state: "awaiting" }]);
    m.setLoading(false);
    m.setPolls(1);

    expect(badges.at(-1)).toBe(1); // NOT 9
    m.dispose();
  });

  it("paints nothing at all until a poll has returned", () => {
    seedAllRead(EIGHT);
    const m = mount({ sessions: [], polls: 0, loading: true });
    expect(badges).toEqual([]);
    m.dispose();
  });

  it("does not clear a correct badge when the first poll FAILS", () => {
    seedAllRead(EIGHT);
    // loading goes false on a rejected poll while the list stays empty, and
    // polls never ticks. Nothing may be painted from that.
    const m = mount({ sessions: [], polls: 0, loading: false });
    expect(badges).toEqual([]);
    m.dispose();
  });

  it("repaints on every poll, even when the session list has not changed", () => {
    seedAllRead(EIGHT);
    const list = [...EIGHT.map(done), { name: "i", state: "awaiting" }];
    const m = mount({ sessions: list, polls: 1, loading: false });
    const painted = badges.length;
    m.setPolls(2);
    m.setPolls(3);
    // An unchanged payload writes nothing to the store, so without a poll
    // counter a badge painted too high by a push would stand indefinitely.
    expect(badges.length).toBeGreaterThan(painted);
    m.dispose();
  });

  it("drops a session from the count once you look at it", () => {
    const list = [done("a"), done("b")];
    const m = mount({ sessions: list, polls: 1, loading: false });
    expect(badges.at(-1)).toBe(2);
    m.setSelected("a"); // attached, tab visible
    m.setPolls(2);
    expect(badges.at(-1)).toBe(1);
    m.dispose();
  });
});
