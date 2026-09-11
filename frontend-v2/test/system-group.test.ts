import { describe, it, expect } from "vitest";
import {
  deriveSidebar,
  groupSeqTokens,
  groupToken,
  isGroupVisible,
  isSystemSession,
  moveGroup,
  reorderGroups,
  SYSTEM_GROUP_NAME,
  visibleGroupSeqTokens,
} from "../src/components/lobby.logic";
import type { Layout, Session } from "../src/types/lobby";
import { emptyLayout } from "../src/types/lobby";

/**
 * The System group (design doc `docs/plans/2026-09-06-test-session-origin-design.md`).
 *
 * A session the lobby's own create path made carries `@tl_origin=user`; a
 * harness stamps `test`, and anything nobody stamped arrives with no origin at
 * all. Everything that is not `user` collects at the foot of the sidebar
 * instead of sitting in the list beside a person's own work.
 */

const ME = "wizard";

const sess = (name: string, over: Partial<Session> = {}): Session => ({
  name,
  attached: 0,
  lastActivity: 1000,
  created: 1000,
  owner: ME,
  origin: "user",
  ...over,
});

/** A session the lobby did not make: unstamped, which is what the four strays
 *  measured on 2026-09-06 looked like. */
const stray = (name: string, over: Partial<Session> = {}): Session => {
  const s = sess(name, over);
  delete s.origin;
  return s;
};

function layout(over: Partial<Layout> = {}): Layout {
  return { ...emptyLayout(), ...over };
}

const systemGroup = (l: Layout, sessions: Session[]) =>
  deriveSidebar(l, sessions, ME).groups.find((g) => g.kind === "system")!;

const names = (ss: Session[]) => ss.map((s) => s.name);

describe("isSystemSession", () => {
  it("is true for anything the lobby did not stamp", () => {
    expect(isSystemSession(stray("shell-2"))).toBe(true);
    expect(isSystemSession(sess("qa-slug", { origin: "test" }))).toBe(true);
  });

  it("is false for a session the lobby's own create path made", () => {
    expect(isSystemSession(sess("mine"))).toBe(false);
  });

  it("does not second-guess the server on reserved prefixes", () => {
    // reservedName() is tmux-api's rule and it is already reflected in the
    // origin the server sends, so a `qa-` name stamped `user` (the rescue) is a
    // user session here rather than being dragged back by its name.
    expect(isSystemSession(sess("qa-rescued", { origin: "user" }))).toBe(false);
  });
});

describe("deriveSidebar / System", () => {
  it("sweeps a system leftover into System rather than Ungrouped", () => {
    const m = deriveSidebar(layout(), [sess("mine"), stray("shell-2")], ME);
    const ungrouped = m.groups.find((g) => g.kind === "ungrouped")!;
    expect(names(ungrouped.sessions)).toEqual(["mine"]);
    expect(names(m.groups.find((g) => g.kind === "system")!.sessions)).toEqual(["shell-2"]);
  });

  it("takes a system session OUT of layout.ungrouped", () => {
    // The motivating case: qa-harness drives the lobby's own create flow, so the
    // session is filed in the layout exactly like a person's before the harness
    // overwrites its origin to `test`.
    const l = layout({ ungrouped: ["mine", "qa-slug"] });
    const m = deriveSidebar(l, [sess("mine"), sess("qa-slug", { origin: "test" })], ME);
    expect(names(m.groups.find((g) => g.kind === "ungrouped")!.sessions)).toEqual(["mine"]);
    expect(names(m.groups.find((g) => g.kind === "system")!.sessions)).toEqual(["qa-slug"]);
  });

  it("leaves a system session where the layout explicitly put it (the rescue)", () => {
    const l = layout({ projects: [{ name: "work", sessions: ["t3e2e-1"] }], ungroupedIndex: 1 });
    const m = deriveSidebar(l, [sess("t3e2e-1", { origin: "test" })], ME);
    expect(names(m.groups.find((g) => g.name === "work")!.sessions)).toEqual(["t3e2e-1"]);
    expect(m.groups.find((g) => g.kind === "system")!.sessions).toEqual([]);
  });

  it("does not let a system session's own project claim it", () => {
    // `session.project` is what tmux-api stamped, not an arrangement anybody
    // made, so it does not count as a placement the way the layout does.
    const l = layout({ projects: [{ name: "work", sessions: [] }], ungroupedIndex: 1 });
    const m = deriveSidebar(l, [stray("probe", { project: "work" })], ME);
    expect(m.groups.find((g) => g.name === "work")!.sessions).toEqual([]);
    expect(names(m.groups.find((g) => g.kind === "system")!.sessions)).toEqual(["probe"]);
  });

  it("orders System by creation time then name, like the other sweeps", () => {
    const g = systemGroup(layout(), [
      stray("b", { created: 300 }),
      stray("a", { created: 100 }),
      stray("c", { created: 100 }),
    ]);
    expect(names(g.sessions)).toEqual(["a", "c", "b"]);
  });

  it("never shows a foreign session in System", () => {
    const m = deriveSidebar(layout(), [stray("theirs", { owner: "emo", origin: "test" })], ME);
    expect(m.groups.find((g) => g.kind === "system")!.sessions).toEqual([]);
    expect(names(m.foreign)).toEqual(["theirs"]);
  });

  it("keeps the dock's scratch shell out of System", () => {
    const l = layout({ dock: { session: "dock1", visible: true } });
    const m = deriveSidebar(l, [stray("dock1")], ME);
    expect(m.groups.find((g) => g.kind === "system")!.sessions).toEqual([]);
  });
});

describe("the System group's place in the sequence", () => {
  it("sorts last, after every project and after the Ungrouped sentinel", () => {
    const l = layout({
      projects: [
        { name: "a", sessions: [] },
        { name: "b", sessions: [] },
      ],
      ungroupedIndex: 1,
    });
    expect(groupSeqTokens(l)).toEqual(["p:a", "u", "p:b", "s"]);
    const m = deriveSidebar(l, [stray("x")], ME);
    expect(m.groups.map(groupToken)).toEqual(["p:a", "u", "p:b", "s"]);
    expect(m.groups.at(-1)!.kind).toBe("system");
  });

  it("hides while empty and shows once something lands in it", () => {
    const empty = systemGroup(layout(), [sess("mine")]);
    expect(isGroupVisible(empty)).toBe(false);
    expect(isGroupVisible(systemGroup(layout(), [stray("shell-2")]))).toBe(true);
  });

  it("is not a slot the reorder controls can step onto", () => {
    // A Move item measured in a token space that carries the pinned System slot
    // comes up enabled and does nothing on the first click, which is the bug
    // visibleGroupSeqTokens exists to prevent.
    const l = layout({ projects: [{ name: "a", sessions: [] }], ungroupedIndex: 1 });
    const model = deriveSidebar(l, [sess("mine"), stray("shell-2")], ME);
    expect(visibleGroupSeqTokens(model)).toEqual(["p:a", "u"]);
  });

  it("cannot be moved, and nothing can be moved onto its slot", () => {
    const l = layout({ projects: [{ name: "a", sessions: [] }], ungroupedIndex: 1 });
    // "s" sits at index 2; dragging the Ungrouped sentinel down onto it must
    // leave the layout exactly as it was rather than round-tripping through a
    // token the layout cannot store.
    expect(reorderGroups(l, 1, 2)).toEqual(l);
    expect(reorderGroups(l, 2, 0)).toEqual(l);
    expect(moveGroup(l, SYSTEM_GROUP_NAME, -1)).toEqual(l);
    // The moves that were always legal still are.
    expect(groupSeqTokens(reorderGroups(l, 0, 1))).toEqual(["u", "p:a", "s"]);
  });

  it("carries a name no project can take, so it keys the collapse store", () => {
    // ProjectGroup's collapse key and lobby.ts's auto-expand both read
    // `group.name` for anything that is not Ungrouped. A name matching
    // [a-zA-Z0-9_-]{1,32} cannot start with ':', so this collides with nothing.
    expect(SYSTEM_GROUP_NAME).toBe(":system");
    expect(systemGroup(layout(), []).name).toBe(SYSTEM_GROUP_NAME);
  });
});
