import { afterEach, describe, it, expect, vi } from "vitest";
import {
  addProject,
  addSessionToGroup,
  countStates,
  deleteProject,
  deriveSidebar,
  formatWorking,
  groupSeqTokens,
  isOwn,
  materializeGroup,
  materializeUngrouped,
  moveGroup,
  moveSession,
  moveSessionToAnchor,
  relativeTime,
  removeSessionFromLayout,
  renameProject,
  reorderGroups,
  sameLayout,
  stabilizeModel,
  stateLabel,
  visibleGroupSeqTokens,
  type SidebarModel,
} from "../src/components/lobby.logic";
import type { Layout, Session } from "../src/types/lobby";
import { emptyLayout } from "../src/types/lobby";

const ME = "wizard";

const sess = (name: string, over: Partial<Session> = {}): Session => ({
  name,
  attached: 0,
  lastActivity: 1000,
  created: 1000,
  owner: ME,
  ...over,
});

function layout(over: Partial<Layout> = {}): Layout {
  return { ...emptyLayout(), ...over };
}

describe("deriveSidebar", () => {
  it("puts unreferenced live own sessions in Ungrouped, ordered by created", () => {
    const l = layout();
    const sessions = [
      sess("b", { created: 200 }),
      sess("a", { created: 100 }),
    ];
    const m = deriveSidebar(l, sessions, ME);
    expect(m.groups).toHaveLength(1);
    expect(m.groups[0]!.kind).toBe("ungrouped");
    expect(m.groups[0]!.sessions.map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("renders projects in groupSeq order with the Ungrouped slot honored", () => {
    const l = layout({
      projects: [
        { name: "work", sessions: ["w1"] },
        { name: "play", sessions: ["p1"] },
      ],
      ungrouped: ["u1"],
      ungroupedIndex: 1, // between the two projects
    });
    const sessions = [sess("w1"), sess("p1"), sess("u1")];
    const m = deriveSidebar(l, sessions, ME);
    expect(m.groups.map((g) => g.name || "<ungrouped>")).toEqual([
      "work",
      "<ungrouped>",
      "play",
    ]);
    expect(m.groups[0]!.sessions.map((s) => s.name)).toEqual(["w1"]);
    expect(m.groups[1]!.sessions.map((s) => s.name)).toEqual(["u1"]);
    expect(m.groups[2]!.sessions.map((s) => s.name)).toEqual(["p1"]);
  });

  it("keeps dead-but-assigned refs out of the render (only live sessions show)", () => {
    const l = layout({ projects: [{ name: "work", sessions: ["live", "dead"] }] });
    const m = deriveSidebar(l, [sess("live")], ME);
    expect(m.groups.find((g) => g.name === "work")!.sessions.map((s) => s.name)).toEqual([
      "live",
    ]);
  });

  it("splits foreign sessions into a Shared-with-me list, owner-major", () => {
    const l = layout();
    const sessions = [
      sess("mine"),
      sess("theirs", { owner: "bob", access: "ro" }),
      sess("alices", { owner: "alice", access: "rw" }),
    ];
    const m = deriveSidebar(l, sessions, ME);
    expect(m.foreign.map((s) => s.name)).toEqual(["alices", "theirs"]);
    // own session stays in the groups, not foreign
    const ownNames = m.groups.flatMap((g) => g.sessions.map((s) => s.name));
    expect(ownNames).toContain("mine");
    expect(ownNames).not.toContain("theirs");
  });

  it("excludes the dock session from the sidebar", () => {
    const l = layout({ dock: { session: "scratch", visible: true } });
    const m = deriveSidebar(l, [sess("scratch"), sess("real")], ME);
    const names = m.groups.flatMap((g) => g.sessions.map((s) => s.name));
    expect(names).toEqual(["real"]);
  });

  it("never lists a session in two groups", () => {
    const l = layout({
      projects: [
        { name: "a", sessions: ["dup"] },
        { name: "b", sessions: ["dup"] },
      ],
    });
    const m = deriveSidebar(l, [sess("dup")], ME);
    const count = m.groups
      .flatMap((g) => g.sessions.map((s) => s.name))
      .filter((n) => n === "dup").length;
    expect(count).toBe(1);
  });

  it("files an unplaced session under the project its own record names", () => {
    // tmux-api stamps `project` on the session itself; the layout is the
    // per-user arrangement of it. A session the layout does not place fell
    // through to Ungrouped even when it said which project it belonged to —
    // the project then sat right beside it reading 0.
    const l = layout({ projects: [{ name: "t3-code", sessions: [] }] });
    const m = deriveSidebar(l, [sess("t3", { project: "t3-code" })], ME);
    const proj = m.groups.find((g) => g.name === "t3-code")!;
    expect(proj.sessions.map((s) => s.name)).toEqual(["t3"]);
    expect(m.groups.find((g) => g.kind === "ungrouped")!.sessions).toEqual([]);
  });

  it("keeps the layout's placement when it disagrees with the session's project", () => {
    // The layout is the arrangement the user made by hand; the session record
    // is only the fallback for one it has never placed.
    const l = layout({
      projects: [
        { name: "here", sessions: ["s"] },
        { name: "there", sessions: [] },
      ],
    });
    const m = deriveSidebar(l, [sess("s", { project: "there" })], ME);
    expect(m.groups.find((g) => g.name === "here")!.sessions.map((s) => s.name)).toEqual(["s"]);
    expect(m.groups.find((g) => g.name === "there")!.sessions).toEqual([]);
  });

  it("falls back to Ungrouped when the named project does not exist", () => {
    const m = deriveSidebar(layout(), [sess("orphan", { project: "gone" })], ME);
    expect(m.groups.find((g) => g.kind === "ungrouped")!.sessions.map((s) => s.name)).toEqual([
      "orphan",
    ]);
  });
});

/**
 * The sidebar's <For> keys on REFERENCE, and deriveSidebar builds fresh
 * RenderGroup objects on every recompute — so any poll that recomputed the model
 * tore down and re-created every group and card node, taking the double-click
 * that was mid-flight on one of them with it. The manifest does not have to
 * change for that: tmux-api spans OS users, so the same sessions come back in a
 * different ORDER, and any session appearing anywhere (even a foreign one)
 * shifts the array.
 */
describe("stabilizeModel", () => {
  const model = (l: Layout, sessions: Session[]) => deriveSidebar(l, sessions, ME);

  it("returns the previous model outright when the derivation says the same thing", () => {
    const l = layout({ projects: [{ name: "work", sessions: ["a"] }], ungrouped: ["b"] });
    const a = sess("a");
    const b = sess("b");
    const prev = model(l, [a, b]);
    // same sessions, re-parsed layout, different manifest order
    const next = model(JSON.parse(JSON.stringify(l)) as Layout, [b, a]);
    expect(next).not.toBe(prev); // control: the derivation really did re-run
    expect(stabilizeModel(prev, next)).toBe(prev);
  });

  it("keeps the untouched groups when one of them changes", () => {
    const l = layout({
      projects: [
        { name: "alpha", sessions: ["a"] },
        { name: "bravo", sessions: ["b"] },
      ],
    });
    const a = sess("a");
    const b = sess("b");
    const prev = stabilizeModel(undefined, model(l, [a, b]));
    const l2 = layout({
      projects: [
        { name: "alpha", sessions: ["a"] },
        { name: "bravo", sessions: ["b", "b2"] },
      ],
    });
    const out = stabilizeModel(prev, model(l2, [a, b, sess("b2")]));
    const at = (m: typeof out, name: string) => m.groups.findIndex((g) => g.name === name);

    expect(out).not.toBe(prev);
    expect(out.groups[at(out, "alpha")]).toBe(prev.groups[at(prev, "alpha")]); // untouched
    expect(out.groups[at(out, "bravo")]).not.toBe(prev.groups[at(prev, "bravo")]);
    expect(out.groups[at(out, "bravo")]!.sessions.map((s) => s.name)).toEqual(["b", "b2"]);
  });

  it("keeps every own group when only the Shared-with-me list moves", () => {
    // Somebody else's session appearing must not re-create this user's rows.
    const l = layout({ ungrouped: ["a"] });
    const a = sess("a");
    const prev = stabilizeModel(undefined, model(l, [a]));
    const out = stabilizeModel(prev, model(l, [a, sess("theirs", { owner: "bob" })]));

    expect(out).not.toBe(prev);
    expect(out.groups[0]).toBe(prev.groups[0]);
    expect(out.foreign.map((s) => s.name)).toEqual(["theirs"]);
  });

  it("does not reuse a group whose members were reordered", () => {
    const l = layout({ ungrouped: ["a", "b"] });
    const a = sess("a");
    const b = sess("b");
    const prev = stabilizeModel(undefined, model(l, [a, b]));
    const out = stabilizeModel(prev, model(layout({ ungrouped: ["b", "a"] }), [a, b]));
    expect(out.groups[0]).not.toBe(prev.groups[0]);
    expect(out.groups[0]!.sessions.map((s) => s.name)).toEqual(["b", "a"]);
  });

  it("does not reuse a group whose project directory changed", () => {
    const work = (m: SidebarModel) => m.groups.find((g) => g.name === "work")!;
    const prev = stabilizeModel(
      undefined,
      model(layout({ projects: [{ name: "work", sessions: [] }] }), []),
    );
    const out = stabilizeModel(
      prev,
      model(layout({ projects: [{ name: "work", sessions: [], dir: "/code" }] }), []),
    );
    expect(work(out)).not.toBe(work(prev));
    expect(work(out).project!.dir).toBe("/code");
  });

  it("passes the first derivation straight through", () => {
    const first = model(layout(), [sess("a")]);
    expect(stabilizeModel(undefined, first)).toBe(first);
  });
});

describe("groupSeqTokens", () => {
  it("places the ungrouped sentinel at ungroupedIndex", () => {
    const l = layout({
      projects: [{ name: "a", sessions: [] }, { name: "b", sessions: [] }],
      ungroupedIndex: 1,
    });
    expect(groupSeqTokens(l)).toEqual(["p:a", "u", "p:b"]);
  });
  it("top slot (0) and last slot", () => {
    const l0 = layout({ projects: [{ name: "a", sessions: [] }], ungroupedIndex: 0 });
    expect(groupSeqTokens(l0)).toEqual(["u", "p:a"]);
    const l1 = layout({ projects: [{ name: "a", sessions: [] }], ungroupedIndex: 1 });
    expect(groupSeqTokens(l1)).toEqual(["p:a", "u"]);
  });
});

describe("visibleGroupSeqTokens", () => {
  it("drops the empty sentinel the sidebar hides, without touching the raw sequence", () => {
    const l = layout({
      projects: [{ name: "a", sessions: ["a1"] }, { name: "b", sessions: ["b1"] }],
      ungroupedIndex: 1,
    });
    const m = deriveSidebar(l, [sess("a1"), sess("b1")], ME);
    // The slot survives — capture and reorder still need somewhere to put it…
    expect(groupSeqTokens(l)).toEqual(["p:a", "u", "p:b"]);
    // …but the user is looking at two groups, so that is what Move up/down counts.
    expect(visibleGroupSeqTokens(m)).toEqual(["p:a", "p:b"]);
  });

  it("keeps the sentinel in the visible sequence once it has a member", () => {
    const l = layout({
      projects: [{ name: "a", sessions: ["a1"] }],
      ungrouped: ["u1"],
      ungroupedIndex: 0,
    });
    const m = deriveSidebar(l, [sess("a1"), sess("u1")], ME);
    expect(visibleGroupSeqTokens(m)).toEqual(["u", "p:a"]);
  });

  it("keeps an EMPTY project visible — only Ungrouped hides", () => {
    const l = layout({ projects: [{ name: "a", sessions: [] }], ungroupedIndex: 1 });
    const m = deriveSidebar(l, [], ME);
    expect(visibleGroupSeqTokens(m)).toEqual(["p:a"]);
  });
});

describe("moveSession", () => {
  it("moves a session between groups and de-dups the prior reference", () => {
    const l = layout({
      projects: [{ name: "a", sessions: ["x"] }, { name: "b", sessions: [] }],
      ungrouped: [],
    });
    const out = moveSession(l, "x", "b");
    expect(out.projects[0]!.sessions).toEqual([]);
    expect(out.projects[1]!.sessions).toEqual(["x"]);
  });

  it("inserts at an index within Ungrouped", () => {
    const l = layout({ ungrouped: ["a", "b", "c"] });
    expect(moveSession(l, "c", "", 1).ungrouped).toEqual(["a", "c", "b"]);
  });

  it("moves an unreferenced session into a project (adds it to the layout)", () => {
    const l = layout({ projects: [{ name: "a", sessions: [] }] });
    expect(moveSession(l, "new", "a").projects[0]!.sessions).toEqual(["new"]);
  });
});

// A drop lands on a CARD, and a card's position is a RENDERED one: deriveSidebar
// has already filtered dead refs out and swept leftovers in, so a rendered index
// is NOT a layout index. These cover the translation both ways.
describe("materializeUngrouped", () => {
  it("folds the leftovers into layout.ungrouped without changing the render", () => {
    const l = layout({ ungrouped: ["alpha"] });
    const live = [
      sess("alpha", { created: 1 }),
      sess("beta", { created: 2 }),
      sess("gamma", { created: 3 }),
    ];
    const rendered = deriveSidebar(l, live, ME).groups[0]!.sessions.map((s) => s.name);
    expect(rendered).toEqual(["alpha", "beta", "gamma"]);

    const out = materializeUngrouped(l, rendered);
    expect(out.ungrouped).toEqual(["alpha", "beta", "gamma"]);
    expect(deriveSidebar(out, live, ME).groups[0]!.sessions.map((s) => s.name)).toEqual(rendered);
  });

  it("keeps dead refs and returns the same layout when nothing is missing", () => {
    const l = layout({ ungrouped: ["dead", "alpha"] });
    expect(materializeUngrouped(l, ["alpha"])).toBe(l);
  });
});

describe("materializeGroup", () => {
  it("folds a project's swept-in members into its layout list", () => {
    // Sessions whose own record names the project, which the layout has never
    // placed: they render in the project with no raw index behind them.
    const l = layout({ projects: [{ name: "work", sessions: ["a"] }] });
    const live = [
      sess("a", { created: 1 }),
      sess("b", { created: 2, project: "work" }),
    ];
    const rendered = deriveSidebar(l, live, ME)
      .groups.find((g) => g.name === "work")!
      .sessions.map((s) => s.name);
    expect(rendered).toEqual(["a", "b"]);

    const out = materializeGroup(l, "work", rendered);
    expect(out.projects[0]!.sessions).toEqual(["a", "b"]);
    expect(
      deriveSidebar(out, live, ME)
        .groups.find((g) => g.name === "work")!
        .sessions.map((s) => s.name),
    ).toEqual(rendered);
  });

  it("delegates the ungrouped case and no-ops on an unknown group", () => {
    const l = layout({ ungrouped: ["a"] });
    expect(materializeGroup(l, "", ["a", "b"]).ungrouped).toEqual(["a", "b"]);
    expect(materializeGroup(l, "nosuch", ["b"])).toBe(l);
  });
});

describe("moveSessionToAnchor", () => {
  it("lands below the anchor when dead refs precede the drop point", () => {
    // raw ['d1','d2','a','b','c'] renders as ['a','b','c'] — a rendered index of
    // 2 would splice between the two dead refs.
    const l = layout({ projects: [{ name: "work", sessions: ["d1", "d2", "a", "b", "c"] }] });
    const out = moveSessionToAnchor(l, "a", "work", { name: "b", side: "below" });
    expect(out.projects[0]!.sessions).toEqual(["d1", "d2", "b", "a", "c"]);

    const live = [sess("a"), sess("b"), sess("c")];
    expect(
      deriveSidebar(out, live, ME).groups.find((g) => g.name === "work")!.sessions.map((s) => s.name),
    ).toEqual(["b", "a", "c"]);
  });

  it("lands above the anchor when dead refs precede the drop point", () => {
    const l = layout({ projects: [{ name: "work", sessions: ["d1", "d2", "a", "b", "c"] }] });
    const out = moveSessionToAnchor(l, "c", "work", { name: "b", side: "above" });
    expect(out.projects[0]!.sessions).toEqual(["d1", "d2", "a", "c", "b"]);
  });

  it("places a materialized leftover where it was dropped in Ungrouped", () => {
    const l = layout({ ungrouped: ["alpha"] });
    const live = [
      sess("alpha", { created: 1 }),
      sess("beta", { created: 2 }),
      sess("gamma", { created: 3 }),
    ];
    const rendered = deriveSidebar(l, live, ME).groups[0]!.sessions.map((s) => s.name);
    const out = moveSessionToAnchor(
      materializeUngrouped(l, rendered),
      "beta",
      "",
      { name: "gamma", side: "below" },
    );
    expect(out.ungrouped).toEqual(["alpha", "gamma", "beta"]);
    expect(deriveSidebar(out, live, ME).groups[0]!.sessions.map((s) => s.name)).toEqual([
      "alpha",
      "gamma",
      "beta",
    ]);
  });

  it("a cross-group drop onto a card lands at the anchor, not at the end", () => {
    const l = layout({
      projects: [
        { name: "a", sessions: ["x"] },
        { name: "b", sessions: ["dead", "p", "q"] },
      ],
    });
    const out = moveSessionToAnchor(l, "x", "b", { name: "p", side: "above" });
    expect(out.projects[0]!.sessions).toEqual([]);
    expect(out.projects[1]!.sessions).toEqual(["dead", "x", "p", "q"]);
  });

  it("appends when the anchor is not in the target list", () => {
    const l = layout({ projects: [{ name: "work", sessions: ["a", "b"] }] });
    const out = moveSessionToAnchor(l, "a", "work", { name: "ghost", side: "below" });
    expect(out.projects[0]!.sessions).toEqual(["b", "a"]);
  });
});

describe("reorderGroups / moveGroup", () => {
  it("reorders projects past the ungrouped slot", () => {
    const l = layout({
      projects: [{ name: "a", sessions: [] }, { name: "b", sessions: [] }],
      ungroupedIndex: 0, // [u, a, b]
    });
    // move ungrouped (seq 0) to the end (seq 2): [a, b, u]
    const out = reorderGroups(l, 0, 2);
    expect(groupSeqTokens(out)).toEqual(["p:a", "p:b", "u"]);
    expect(out.ungroupedIndex).toBe(2);
  });

  it("moveGroup down moves a project past ungrouped", () => {
    const l = layout({
      projects: [{ name: "a", sessions: [] }],
      ungroupedIndex: 0, // [u, a]
    });
    const out = moveGroup(l, "", 1); // ungrouped down → [a, u]
    expect(groupSeqTokens(out)).toEqual(["p:a", "u"]);
  });
});

describe("project CRUD", () => {
  it("adds, renames, and refuses duplicate names", () => {
    let l = addProject(emptyLayout(), "work", "/home/wizard/code");
    expect(l.projects[0]).toEqual({ name: "work", sessions: [], dir: "/home/wizard/code" });
    l = addProject(l, "work"); // dup → no-op
    expect(l.projects).toHaveLength(1);
    l = renameProject(l, "work", "job");
    expect(l.projects[0]!.name).toBe("job");
  });

  it("puts a new project ABOVE Ungrouped, leaving the other groups in place", () => {
    // ungroupedIndex counts the projects above the sentinel, so appending to
    // `projects` filed a brand-new project underneath Ungrouped — below the
    // loose sessions, where the user who just named it was not looking.
    const l = layout({
      projects: [{ name: "old", sessions: [] }],
      ungrouped: ["loose"],
      ungroupedIndex: 0, // Ungrouped on top, "old" below it
    });
    const out = addProject(l, "fresh");
    expect(groupSeqTokens(out)).toEqual(["p:fresh", "u", "p:old"]);
  });

  it("keeps a new project above Ungrouped when the sentinel sits last", () => {
    const l = layout({ projects: [{ name: "old", sessions: [] }], ungroupedIndex: 1 });
    expect(groupSeqTokens(addProject(l, "fresh"))).toEqual(["p:old", "p:fresh", "u"]);
  });

  it("delete moves members to Ungrouped and clamps the slot", () => {
    const l = layout({
      projects: [{ name: "a", sessions: ["s1"] }, { name: "b", sessions: ["s2"] }],
      ungrouped: ["u"],
      ungroupedIndex: 2, // last
    });
    const out = deleteProject(l, "a");
    expect(out.projects.map((p) => p.name)).toEqual(["b"]);
    expect(out.ungrouped).toEqual(["u", "s1"]);
    expect(out.ungroupedIndex).toBe(1); // shifted left past the removed project
  });
});

describe("session CRUD in layout", () => {
  it("addSessionToGroup then remove", () => {
    let l = addSessionToGroup(emptyLayout(), "sess", "");
    expect(l.ungrouped).toEqual(["sess"]);
    l = removeSessionFromLayout(l, "sess");
    expect(l.ungrouped).toEqual([]);
  });
});

describe("display helpers", () => {
  it("formatWorking renders m:ss and h:mm:ss", () => {
    expect(formatWorking(0)).toBe("0:00");
    expect(formatWorking(65_000)).toBe("1:05");
    expect(formatWorking(3_661_000)).toBe("1:01:01");
  });
  it("stateLabel maps states to phrases", () => {
    expect(stateLabel("running")).toBe("Working");
    expect(stateLabel("awaiting")).toBe("Awaiting input");
    expect(stateLabel("done")).toBe("Done");
    expect(stateLabel("")).toBe("");
  });
  it("countStates tallies the three states", () => {
    const c = countStates([
      sess("a", { state: "running" }),
      sess("b", { state: "awaiting" }),
      sess("c", { state: "done" }),
      sess("d", { state: "running" }),
      sess("e", { state: "" }),
    ]);
    expect(c).toEqual({ running: 2, awaiting: 1, done: 1 });
  });
  it("isOwn treats missing owner as own", () => {
    expect(isOwn(sess("a", { owner: undefined }), ME)).toBe(true);
    expect(isOwn(sess("a", { owner: "bob" }), ME)).toBe(false);
  });
});

describe("relativeTime", () => {
  const NOW_MS = Date.parse("2026-08-06T10:00:00Z");
  const NOW = Math.floor(NOW_MS / 1000);
  const at = (epochSec: number): string => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);
    return relativeTime(epochSec);
  };
  afterEach(() => vi.useRealTimers());

  it("renders the four buckets for a past timestamp", () => {
    expect(at(NOW - 30)).toBe("30s ago");
    expect(at(NOW - 300)).toBe("5m ago");
    expect(at(NOW - 7200)).toBe("2h ago");
    expect(at(NOW - 172_800)).toBe("2d ago");
  });

  it("clamps a future timestamp to 0 instead of counting backwards", () => {
    // lastActivity comes off the server clock, Date.now() off the viewer's. A
    // viewer whose clock trails the server's puts every freshly-active card in
    // its own future; the age must floor at zero, not render "-239s ago".
    expect(at(NOW + 240)).toBe("0s ago");
    expect(at(NOW + 1)).toBe("0s ago");
    expect(at(NOW)).toBe("0s ago");
    expect(at(NOW + 86_400)).toBe("0s ago");
  });

  it("keeps the blank render for a missing timestamp", () => {
    // Deliberate no-timestamp guard, ported from the vanilla helper: an unknown
    // time renders as an empty cell, never as "0s ago".
    expect(at(0)).toBe("");
  });
});

describe("sameLayout", () => {
  const base = (): Layout => ({
    version: 1,
    projects: [{ name: "work", sessions: ["a", "b"], dir: "/srv" }],
    ungrouped: ["c"],
    ungroupedIndex: 1,
    dock: { session: "dock", visible: false },
  });

  it("is true for two freshly-parsed copies of the same document", () => {
    const a = base();
    const b = JSON.parse(JSON.stringify(a)) as Layout;
    expect(a).not.toBe(b);
    expect(sameLayout(a, b)).toBe(true);
  });

  it("is false for every field that changes the render", () => {
    const changes: ((l: Layout) => void)[] = [
      (l) => (l.version = 2),
      (l) => (l.ungroupedIndex = 0),
      (l) => l.ungrouped.push("d"),
      (l) => (l.ungrouped = ["d"]),
      (l) => (l.projects[0]!.name = "play"),
      (l) => (l.projects[0]!.dir = "/other"),
      (l) => (l.projects[0]!.sessions = ["b", "a"]),
      (l) => l.projects.push({ name: "extra", sessions: [] }),
      (l) => (l.dock = { session: "dock", visible: true }),
      (l) => delete l.dock,
    ];
    for (const mutate of changes) {
      const b = base();
      mutate(b);
      expect(sameLayout(base(), b)).toBe(false);
    }
  });

  it("treats an absent optional as equal to an absent optional", () => {
    const a: Layout = { version: 1, projects: [{ name: "p", sessions: [] }], ungrouped: [], ungroupedIndex: 0 };
    expect(sameLayout(a, JSON.parse(JSON.stringify(a)) as Layout)).toBe(true);
  });
});
