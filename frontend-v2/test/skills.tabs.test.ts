import { describe, it, expect } from "vitest";
import {
  emptyReason,
  matches,
  mineRows,
  peerRows,
  pluginRows,
  resolveTab,
  tabsFor,
} from "../src/store/skills.tabs";
import type { Inventory } from "../src/lib/skills-api";

const skill = (name: string, description = "") => ({
  name,
  description,
  files: 1,
  executable: 0,
  bytes: 100,
  hash: "h-" + name,
  enabled: true,
});

const inv = (over: Partial<Inventory> = {}): Inventory => ({
  user: "wizard",
  skills: [skill("grilling", "Grill a plan"), skill("tdd", "Test first")],
  plugins: [
    { id: "superpowers@official", name: "superpowers", marketplace: "official", version: "5.1.0", enabled: true },
  ],
  peers: [
    {
      user: "bob",
      skills: [
        { ...skill("diagnose", "Debug it"), verdict: "absent" as const },
        { ...skill("tdd"), verdict: "differs" as const },
        { ...skill("file-issue"), verdict: "same" as const },
      ],
    },
  ],
  ...over,
});

describe("tabsFor", () => {
  it("puts the caller first, then each account, then plugins and sessions", () => {
    const tabs = tabsFor(inv(), [{}, {}]);
    expect(tabs.map((t) => t.id)).toEqual(["mine", "peer:bob", "plugins", "sessions"]);
    expect(tabs.map((t) => t.label)).toEqual(["Mine", "bob", "Plugins", "Sessions"]);
  });

  it("counts a peer tab by what is takeable, not by what they have", () => {
    // Three skills, but the identical one is not takeable.
    const bob = tabsFor(inv())[1]!;
    expect(bob.count).toBe(2);
  });

  it("keeps a tab for an account it could not read, with no count", () => {
    const tabs = tabsFor(inv({ peers: [{ user: "bob", unreachable: true }] }));
    expect(tabs.map((t) => t.id)).toContain("peer:bob");
    expect(tabs.find((t) => t.id === "peer:bob")!.count).toBe(0);
  });

  it("drops the tabs that would be empty", () => {
    const tabs = tabsFor(inv({ plugins: [], peers: [] }), []);
    expect(tabs.map((t) => t.id)).toEqual(["mine"]);
  });

  it("has nothing to show before an inventory arrives", () => {
    expect(tabsFor(null)).toEqual([]);
  });
});

describe("resolveTab", () => {
  it("keeps the selected tab while it exists", () => {
    const tabs = tabsFor(inv(), [{}]);
    expect(resolveTab(tabs, "plugins")).toBe("plugins");
  });

  it("falls back to the first when the selection is gone", () => {
    // The peer left the roster while their tab was open.
    const tabs = tabsFor(inv({ peers: [] }), []);
    expect(resolveTab(tabs, "peer:bob")).toBe("mine");
  });

  it("selects the first when nothing is selected yet", () => {
    expect(resolveTab(tabsFor(inv()), "")).toBe("mine");
  });

  it("answers nothing when there are no tabs", () => {
    expect(resolveTab([], "mine")).toBe("");
  });
});

describe("the filter", () => {
  it("matches a name or a description, case-insensitively", () => {
    const s = skill("grill-with-docs", "A relentless interview that writes ADRs");
    expect(matches(s, "")).toBe(true);
    expect(matches(s, "GRILL")).toBe(true);
    expect(matches(s, "relentless")).toBe(true);
    expect(matches(s, "  adr ")).toBe(true);
    expect(matches(s, "kubernetes")).toBe(false);
  });

  it("applies to each list", () => {
    expect(mineRows(inv(), "tdd").map((s) => s.name)).toEqual(["tdd"]);
    expect(peerRows(inv(), "bob", "diag").skills.map((s) => s.name)).toEqual(["diagnose"]);
    expect(pluginRows(inv(), "super").map((p) => p.name)).toEqual(["superpowers"]);
    expect(pluginRows(inv(), "nope")).toEqual([]);
  });

  it("returns the peer's block so the caller can tell empty from unreachable", () => {
    const { block } = peerRows(inv({ peers: [{ user: "bob", unreachable: true }] }), "bob", "");
    expect(block?.unreachable).toBe(true);
  });
});

describe("emptyReason", () => {
  it("distinguishes an empty account from an unmatched filter", () => {
    expect(emptyReason("mine", false, "")).toContain("No skills in this account");
    expect(emptyReason("mine", true, "zzz")).toContain("Nothing matches");
    expect(emptyReason("plugins", false, "")).toContain("No marketplace plugins");
    expect(emptyReason("peer", false, "")).toContain("no skills");
  });

  it("says unreachable ahead of everything else, because it is a different problem", () => {
    expect(emptyReason("peer", false, "zzz", true)).toContain("Could not read");
  });

  it("says nothing when the list is not empty", () => {
    expect(emptyReason("mine", true, "")).toBe("");
  });
});
