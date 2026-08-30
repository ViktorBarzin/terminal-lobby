/**
 * How the session list is ORDERED (Viktor, 2026-08-22).
 *
 * Until now the sidebar had exactly one order — the arrangement saved in the
 * layout, rearranged by dragging. That is the right answer for someone who has
 * curated their list and the wrong one for everybody else: a session started a
 * minute ago landed wherever the layout happened to put it, which for a fresh
 * name is the END of its group, furthest from the eye.
 *
 * So the order is a MODE now: `manual` (the layout, as before), `created`, and
 * `active`. Both time orders run newest-first, and `created` is the default —
 * for a new user and for the existing ones whose layouts are already full of
 * hand-placed sessions, because a saved arrangement is not evidence that
 * somebody wanted it over a fresh list.
 *
 * Everything here is arithmetic over the derived model, so it lives away from
 * the DOM and is tested as such.
 */
import { describe, it, expect } from "vitest";
import {
  applySessionOrder,
  captureVisibleOrder,
  DEFAULT_SESSION_ORDER,
  isSessionOrder,
  lastActiveAt,
  SESSION_ORDERS,
  sortSessions,
  type SessionOrder,
} from "../src/components/order.logic";
import { deriveSidebar } from "../src/components/lobby.logic";
import { emptyLayout, type Layout, type Session } from "../src/types/lobby";

const sess = (name: string, over: Partial<Session> = {}): Session => ({
  name,
  attached: 0,
  lastActivity: 1000,
  created: 1000,
  owner: "wizard",
  ...over,
});

const names = (list: readonly Session[]): string[] => list.map((s) => s.name);

describe("the three orderings", () => {
  it("offers manual, created and active — and nothing else", () => {
    expect([...SESSION_ORDERS].sort()).toEqual(["active", "created", "manual"]);
  });

  it("defaults to created time", () => {
    expect(DEFAULT_SESSION_ORDER).toBe("created");
  });

  it("recognises only those three as an ordering", () => {
    for (const v of SESSION_ORDERS) expect(isSessionOrder(v)).toBe(true);
    // A stored doc is arbitrary JSON: anything else must fall back to the
    // default rather than reach the comparator and sort by nothing.
    for (const v of ["", "Created", "date", 1, null, undefined, {}, []]) {
      expect(isSessionOrder(v)).toBe(false);
    }
  });
});

describe("sorting by created time", () => {
  it("puts the newest session first", () => {
    // A session started a minute ago belongs at the top: it is the one you are
    // most likely to have opened the list to reach.
    const list = [sess("old", { created: 100 }), sess("new", { created: 900 })];
    expect(names(sortSessions(list, "created"))).toEqual(["new", "old"]);
  });

  it("breaks a tie by name, so the list never jitters between polls", () => {
    // /sessions hands the same sessions back in a different order run to run
    // (it spans OS users), and two sessions created in the same second are
    // common — a restore creates a whole layout's worth at once.
    const list = [sess("beta", { created: 500 }), sess("alpha", { created: 500 })];
    expect(names(sortSessions(list, "created"))).toEqual(["alpha", "beta"]);
    expect(names(sortSessions([...list].reverse(), "created"))).toEqual(["alpha", "beta"]);
  });

  it("leaves the caller's array alone", () => {
    const list = [sess("old", { created: 100 }), sess("new", { created: 900 })];
    sortSessions(list, "created");
    expect(names(list)).toEqual(["old", "new"]);
  });
});

describe("sorting by last active", () => {
  /**
   * `lastDrive`, never `lastActivity` — the same choice the card's own relative
   * time makes, and for the same measured reason: tmux bumps
   * `#{session_activity}` on ANY attach, a read-only one included (tmux-api
   * `lastdrive.go`: `tmux attach -r` on an idle session moved it by 1s,
   * measured 2026-08-18). Sorting on it would mean opening a session to WATCH
   * it fired it to the top of the list, and it would disagree with the number
   * printed on the card beside it.
   */
  it("orders by when a human last drove the session, newest first", () => {
    const list = [
      sess("watched", { lastDrive: 100, lastActivity: 9999 }),
      sess("typed-in", { lastDrive: 800, lastActivity: 800 }),
    ];
    expect(names(sortSessions(list, "active"))).toEqual(["typed-in", "watched"]);
  });

  it("does not let a read-only attach move a session", () => {
    // `watched` has the newest activity in the list and the oldest drive: it
    // stays where its driver left it.
    const list = [
      sess("watched", { lastDrive: 100, lastActivity: 9999 }),
      sess("mid", { lastDrive: 400, lastActivity: 400 }),
      sess("newest", { lastDrive: 700, lastActivity: 700 }),
    ];
    expect(names(sortSessions(list, "active"))).toEqual(["newest", "mid", "watched"]);
  });

  it("falls back to creation time for a session with no stamp", () => {
    // tmux-api seeds @last_drive from the session's creation time for exactly
    // this reason (`drivesToStamp`: creating a session attaches read-write, so
    // creation is a truthful lower bound). A server that predates the field
    // sends no stamp at all, and the same rule applied here keeps that list
    // ordered instead of collapsing it onto one tie-break.
    expect(lastActiveAt(sess("x", { created: 400 }))).toBe(400);
    expect(lastActiveAt(sess("x", { created: 400, lastDrive: 900 }))).toBe(900);
    const list = [sess("no-stamp", { created: 900 }), sess("driven", { created: 100, lastDrive: 500 })];
    expect(names(sortSessions(list, "active"))).toEqual(["no-stamp", "driven"]);
  });

  it("breaks a tie by creation time, then by name", () => {
    const list = [
      sess("b", { created: 100, lastDrive: 500 }),
      sess("a", { created: 100, lastDrive: 500 }),
      sess("newer", { created: 300, lastDrive: 500 }),
    ];
    expect(names(sortSessions(list, "active"))).toEqual(["newer", "a", "b"]);
  });
});

describe("manual ordering", () => {
  it("hands the list straight back, untouched and unallocated", () => {
    // Reference-identical on purpose: the render model is reference-keyed all
    // the way to the sidebar's <For>, so a copy here would re-create every card
    // on every poll.
    const list = [sess("b", { created: 900 }), sess("a", { created: 100 })];
    expect(sortSessions(list, "manual")).toBe(list);
  });
});

describe("applying an ordering to the whole render model", () => {
  const layout = (): Layout => ({
    ...emptyLayout(),
    projects: [{ name: "work", sessions: ["w-old", "w-new"] }],
    ungrouped: ["u-old", "u-new"],
    ungroupedIndex: 1,
  });
  const sessions = (): Session[] => [
    sess("w-old", { created: 100 }),
    sess("w-new", { created: 900 }),
    sess("u-old", { created: 200 }),
    sess("u-new", { created: 800 }),
  ];
  const model = () => deriveSidebar(layout(), sessions(), "wizard");
  const groupNames = (m: ReturnType<typeof model>): Record<string, string[]> =>
    Object.fromEntries(
      m.groups.map((g) => [g.kind === "ungrouped" ? "" : g.name, names(g.sessions)]),
    );

  it("sorts WITHIN each group, leaving the groups where they are", () => {
    // Grouping is the arrangement the user made; the ordering is a view over
    // its members. A sort that ran across the whole list would dissolve the
    // projects into one pile.
    const sorted = applySessionOrder(model(), "created");
    expect(sorted.groups.map((g) => g.kind)).toEqual(["project", "ungrouped"]);
    expect(groupNames(sorted)).toEqual({ work: ["w-new", "w-old"], "": ["u-new", "u-old"] });
  });

  it("returns the model untouched for manual", () => {
    const m = model();
    expect(applySessionOrder(m, "manual")).toBe(m);
  });

  it("returns the same model when the sort changes nothing", () => {
    // Already newest-first: no new group objects, so the sidebar's <For> keeps
    // every DOM node it has.
    const m = deriveSidebar(
      { ...emptyLayout(), ungrouped: ["new", "old"] },
      [sess("new", { created: 900 }), sess("old", { created: 100 })],
      "wizard",
    );
    const sorted = applySessionOrder(m, "created");
    expect(sorted).toBe(m);
  });

  it("keeps a group object it did not have to reorder", () => {
    const m = deriveSidebar(
      {
        ...emptyLayout(),
        projects: [{ name: "tidy", sessions: ["t-new", "t-old"] }],
        ungrouped: ["u-old", "u-new"],
        ungroupedIndex: 1,
      },
      [
        sess("t-new", { created: 900 }),
        sess("t-old", { created: 100 }),
        sess("u-old", { created: 200 }),
        sess("u-new", { created: 800 }),
      ],
      "wizard",
    );
    const sorted = applySessionOrder(m, "created");
    expect(sorted.groups[0]).toBe(m.groups[0]); // already in order
    expect(sorted.groups[1]).not.toBe(m.groups[1]); // had to be reordered
  });

  /**
   * Shared-with-me is not the user's list to arrange: it has no manual order
   * (nothing in the layout points at a foreign session) and it is owner-major
   * so you can find whose session you are looking at. Re-sorting it by time
   * would interleave three people's sessions to answer a question about your
   * own list.
   */
  it("leaves the Shared-with-me list owner-major", () => {
    const m = deriveSidebar(
      emptyLayout(),
      [
        sess("theirs-new", { owner: "emo", created: 900 }),
        sess("mine", { created: 500 }),
        sess("theirs-old", { owner: "emo", created: 100 }),
      ],
      "wizard",
    );
    const sorted = applySessionOrder(m, "created");
    expect(names(sorted.foreign)).toEqual(["theirs-new", "theirs-old"]);
    expect(sorted.foreign).toBe(m.foreign);
  });
});

describe("capturing the visible order into the layout", () => {
  /**
   * What a drag does while a time ordering is deciding positions.
   *
   * A drop names a place — "above this card" — and the layout is the only place
   * a position can be written. Writing one while the sort still runs would put
   * the card back where the timestamp says the moment the PUT landed, so the
   * list has to become manual for the drop to mean anything. Freezing what is
   * ON SCREEN first is what makes the switch invisible: every other card keeps
   * the seat it already had, and the only thing that moves is the one the
   * finger moved.
   */
  const layout = (): Layout => ({
    ...emptyLayout(),
    projects: [{ name: "work", sessions: ["w-old", "w-new"] }],
    ungrouped: ["u-old", "u-new"],
    ungroupedIndex: 1,
  });
  const sessions = (): Session[] => [
    sess("w-old", { created: 100 }),
    sess("w-new", { created: 900 }),
    sess("u-old", { created: 200 }),
    sess("u-new", { created: 800 }),
  ];

  it("writes every group's on-screen order, not just the one dragged in", () => {
    // Switching to manual is a whole-list decision. Capturing only the target
    // group would leave every OTHER group snapping back to its stale layout
    // order at the exact moment the finger came up.
    const sorted = applySessionOrder(deriveSidebar(layout(), sessions(), "wizard"), "created");
    const next = captureVisibleOrder(layout(), sorted);
    expect(next.projects[0]!.sessions).toEqual(["w-new", "w-old"]);
    expect(next.ungrouped).toEqual(["u-new", "u-old"]);
  });

  it("keeps the group arrangement and everything else about the document", () => {
    const before = { ...layout(), dock: { session: "scratch", visible: true } };
    const sorted = applySessionOrder(deriveSidebar(before, sessions(), "wizard"), "created");
    const next = captureVisibleOrder(before, sorted);
    expect(next.version).toBe(before.version);
    expect(next.ungroupedIndex).toBe(before.ungroupedIndex);
    expect(next.projects.map((p) => p.name)).toEqual(["work"]);
    expect(next.dock).toEqual(before.dock);
  });

  it("gives a swept-in session the raw entry it never had", () => {
    // A session the layout has never placed renders in the project its own
    // record names (deriveSidebar's leftovers sweep). It occupies a seat backed
    // by no index at all, so a drop anchored on it resolves against nothing —
    // the capture is what gives it one.
    const before: Layout = { ...emptyLayout(), projects: [{ name: "work", sessions: [] }], ungroupedIndex: 1 };
    const live = [sess("swept", { created: 500, project: "work" })];
    const sorted = applySessionOrder(deriveSidebar(before, live, "wizard"), "created");
    expect(captureVisibleOrder(before, sorted).projects[0]!.sessions).toEqual(["swept"]);
  });

  it("preserves a layout entry whose session is not running", () => {
    // A dead-but-assigned ref is deliberate: an OOM restore brings the session
    // back into the project it was in. The capture rewrites the order, so it
    // has to carry those refs rather than treat "not on screen" as "gone".
    const before: Layout = {
      ...emptyLayout(),
      projects: [{ name: "work", sessions: ["w-old", "dead", "w-new"] }],
      ungroupedIndex: 1,
    };
    const sorted = applySessionOrder(deriveSidebar(before, sessions(), "wizard"), "created");
    const next = captureVisibleOrder(before, sorted);
    expect(next.projects[0]!.sessions).toEqual(["w-new", "w-old", "dead"]);
  });

  it("never writes a name into two groups at once", () => {
    // PUT /api/layout rejects a duplicate outright, which would have turned a
    // drag into a "Couldn't save layout" toast. A name listed in two groups
    // renders in exactly one of them (deriveSidebar resolves projects first),
    // so the capture drops the stale copy rather than preserving it as an
    // unrendered ref.
    const before: Layout = {
      ...emptyLayout(),
      projects: [{ name: "work", sessions: ["u-new"] }],
      ungrouped: ["u-new", "u-old"],
      ungroupedIndex: 1,
    };
    const sorted = applySessionOrder(deriveSidebar(before, sessions(), "wizard"), "created");
    const next = captureVisibleOrder(before, sorted);
    const all = [...next.projects.flatMap((p) => p.sessions), ...next.ungrouped];
    expect(new Set(all).size).toBe(all.length);
    expect(next.projects[0]!.sessions).toContain("u-new");
    expect(next.ungrouped).not.toContain("u-new");
  });

  it("is a no-op under manual, where the layout already IS the visible order", () => {
    const before = layout();
    const m = deriveSidebar(before, sessions(), "wizard");
    const next = captureVisibleOrder(before, applySessionOrder(m, "manual"));
    expect(next.projects[0]!.sessions).toEqual(before.projects[0]!.sessions);
    expect(next.ungrouped).toEqual(before.ungrouped);
  });
});

describe("every ordering is total", () => {
  // Property-ish: whatever the order, the same sessions come back — no
  // duplicates, nothing dropped. A comparator that returns 0 too eagerly still
  // has to be a permutation.
  const many: Session[] = Array.from({ length: 24 }, (_, i) =>
    sess(`s${i}`, {
      created: 100 + ((i * 7) % 5) * 10,
      lastDrive: i % 3 === 0 ? undefined : 200 + ((i * 11) % 4) * 10,
    }),
  );

  for (const order of SESSION_ORDERS) {
    it(`keeps every session exactly once under ${order}`, () => {
      const out = sortSessions(many, order as SessionOrder);
      expect(out).toHaveLength(many.length);
      expect(new Set(names(out))).toEqual(new Set(names(many)));
    });
  }
});
