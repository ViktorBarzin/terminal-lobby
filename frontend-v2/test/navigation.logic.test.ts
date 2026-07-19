import { describe, it, expect } from "vitest";
import {
  attachIndex,
  badgeLabel,
  cycleTarget,
  flatSessionOrder,
  nextAwaitingTarget,
  type OrderedSession,
} from "../src/keybindings/navigation.logic";
import type { SidebarModel } from "../src/components/lobby.logic";
import type { Session } from "../src/types/lobby";

const sess = (name: string, over: Partial<Session> = {}): Session => ({
  name,
  attached: 0,
  lastActivity: 1000,
  created: 1000,
  owner: "wizard",
  ...over,
});

describe("attachIndex — Alt-jump index mapping", () => {
  it("maps session.attach.N to a 0-based index", () => {
    expect(attachIndex("session.attach.1")).toBe(0);
    expect(attachIndex("session.attach.9")).toBe(8);
    // Alt+0 binds to session.attach.10 -> the tenth card (index 9).
    expect(attachIndex("session.attach.10")).toBe(9);
  });

  it("returns null for non-attach or malformed commands", () => {
    expect(attachIndex("session.next")).toBeNull();
    expect(attachIndex("session.attach.0")).toBeNull();
    expect(attachIndex("session.attach.x")).toBeNull();
    expect(attachIndex("session.attach.")).toBeNull();
  });
});

describe("badgeLabel", () => {
  it("labels 1..9 then 0 on the tenth card", () => {
    expect([0, 1, 8, 9].map(badgeLabel)).toEqual(["1", "2", "9", "0"]);
  });
});

describe("flatSessionOrder", () => {
  it("concatenates own group members (groupSeq order) then the foreign list", () => {
    const model: SidebarModel = {
      groups: [
        { kind: "project", name: "work", sessions: [sess("w1"), sess("w2")] },
        { kind: "ungrouped", name: "", sessions: [sess("u1")] },
      ],
      foreign: [sess("f1", { owner: "alice" }), sess("f2", { owner: "bob" })],
    };
    expect(flatSessionOrder(model)).toEqual([
      { name: "w1" },
      { name: "w2" },
      { name: "u1" },
      { name: "f1", owner: "alice" },
      { name: "f2", owner: "bob" },
    ]);
  });

  it("carries owner only for foreign entries", () => {
    const model: SidebarModel = {
      groups: [{ kind: "ungrouped", name: "", sessions: [sess("a")] }],
      foreign: [],
    };
    const flat = flatSessionOrder(model);
    expect(flat[0]).toEqual({ name: "a" });
    expect("owner" in flat[0]!).toBe(false);
  });
});

describe("cycleTarget", () => {
  const order: OrderedSession[] = [{ name: "a" }, { name: "b" }, { name: "c" }];

  it("moves next/prev with wraparound", () => {
    expect(cycleTarget(order, "a", 1)?.name).toBe("b");
    expect(cycleTarget(order, "c", 1)?.name).toBe("a"); // wrap forward
    expect(cycleTarget(order, "a", -1)?.name).toBe("c"); // wrap backward
    expect(cycleTarget(order, "b", -1)?.name).toBe("a");
  });

  it("with no current: next -> first, prev -> last", () => {
    expect(cycleTarget(order, null, 1)?.name).toBe("a");
    expect(cycleTarget(order, null, -1)?.name).toBe("c");
    // current not in the list behaves like no current
    expect(cycleTarget(order, "ghost", 1)?.name).toBe("a");
  });

  it("returns null for an empty order", () => {
    expect(cycleTarget([], "a", 1)).toBeNull();
  });
});

describe("nextAwaitingTarget", () => {
  const order: OrderedSession[] = [
    { name: "a" },
    { name: "b" },
    { name: "c" },
    { name: "d" },
  ];
  const states: Record<string, string> = { b: "awaiting", d: "awaiting", a: "running" };
  const stateOf = (n: string) => states[n];

  it("hops to the next awaiting session AFTER current, wrapping", () => {
    expect(nextAwaitingTarget(order, stateOf, "a")?.name).toBe("b");
    expect(nextAwaitingTarget(order, stateOf, "b")?.name).toBe("d");
    expect(nextAwaitingTarget(order, stateOf, "d")?.name).toBe("b"); // wrap
  });

  it("starts from the top when there is no current", () => {
    expect(nextAwaitingTarget(order, stateOf, null)?.name).toBe("b");
  });

  it("can return current itself if it is the only awaiting one", () => {
    const only = (n: string) => (n === "c" ? "awaiting" : undefined);
    expect(nextAwaitingTarget(order, only, "c")?.name).toBe("c");
  });

  it("returns null when none are awaiting", () => {
    expect(nextAwaitingTarget(order, () => "running", "a")).toBeNull();
    expect(nextAwaitingTarget([], stateOf, null)).toBeNull();
  });
});
