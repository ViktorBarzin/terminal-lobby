import { describe, it, expect } from "vitest";
import {
  addProject,
  addSessionToGroup,
  countStates,
  deleteProject,
  deriveSidebar,
  formatWorking,
  groupSeqTokens,
  isOwn,
  materializeUngrouped,
  moveGroup,
  moveSession,
  moveSessionToAnchor,
  removeSessionFromLayout,
  renameProject,
  renameSessionInLayout,
  reorderGroups,
  sameLayout,
  stateLabel,
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
  it("addSessionToGroup then rename then remove", () => {
    let l = addSessionToGroup(emptyLayout(), "sess", "");
    expect(l.ungrouped).toEqual(["sess"]);
    l = renameSessionInLayout(l, "sess", "sess2");
    expect(l.ungrouped).toEqual(["sess2"]);
    l = removeSessionFromLayout(l, "sess2");
    expect(l.ungrouped).toEqual([]);
  });

  it("rename follows the dock session too", () => {
    const l = layout({ dock: { session: "d", visible: true } });
    expect(renameSessionInLayout(l, "d", "d2").dock!.session).toBe("d2");
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
