import { describe, it, expect } from "vitest";
import {
  buildGroups,
  normalizeSearchText,
  rankField,
  rankItem,
  recentsFirst,
  type PaletteItem,
} from "../src/keybindings/palette.logic";

const item = (title: string, terms?: string[]): PaletteItem => ({
  title,
  terms: terms ?? [title],
});

describe("rankField", () => {
  it("scores exact=3, prefix=2, substring=1, no-match=-Infinity", () => {
    expect(rankField("api", "api")).toBe(3);
    expect(rankField("api-server", "api")).toBe(2);
    expect(rankField("my-api", "api")).toBe(1);
    expect(rankField("web", "api")).toBe(-Infinity);
    expect(rankField("", "api")).toBe(-Infinity);
  });
});

describe("rankItem", () => {
  it("first matching term wins; earlier terms outrank later ones", () => {
    const it0 = item("x", ["api", "server"]);
    const it1 = item("y", ["server", "api"]);
    // both contain "api" but it0 matches on term 0 (prefix/exact) => higher.
    expect(rankItem(it0, "api")).toBeGreaterThan(rankItem(it1, "api"));
  });

  it("exact beats prefix beats substring at the same term position", () => {
    expect(rankItem(item("api"), "api")).toBe(1000 + 3);
    expect(rankItem(item("api-x"), "api")).toBe(1000 + 2);
    expect(rankItem(item("z-api"), "api")).toBe(1000 + 1);
  });

  it("returns 0 when no term matches", () => {
    expect(rankItem(item("nope"), "api")).toBe(0);
  });
});

describe("recentsFirst", () => {
  it("orders by last-attach epoch desc, stable for never-visited", () => {
    const sessions = [{ name: "a" }, { name: "b" }, { name: "c" }];
    const visits = { b: 300, a: 100 }; // c never visited
    expect(recentsFirst(sessions, visits).map((s) => s.name)).toEqual(["b", "a", "c"]);
  });

  it("does not mutate the input", () => {
    const sessions = [{ name: "a" }, { name: "b" }];
    recentsFirst(sessions, { b: 1 });
    expect(sessions.map((s) => s.name)).toEqual(["a", "b"]);
  });
});

describe("buildGroups", () => {
  const sessionItems = [item("api"), item("web"), item("db-api")];
  const actionItems = [item("New session"), item("Kill current session")];

  it("empty query keeps both groups in natural order", () => {
    const groups = buildGroups("", { sessionItems, actionItems, sessionsLoaded: true });
    expect(groups.map((g) => g.label)).toEqual(["Sessions", "Actions"]);
    expect(groups[0]!.items.map((i) => i.title)).toEqual(["api", "web", "db-api"]);
  });

  it("shows the loading note until sessions are loaded", () => {
    const groups = buildGroups("", { sessionItems: [], actionItems, sessionsLoaded: false });
    expect(groups[0]!.note).toBe("Loading sessions…");
    const loaded = buildGroups("", { sessionItems, actionItems, sessionsLoaded: true });
    expect(loaded[0]!.note).toBeNull();
  });

  it("a '>' prefix restricts to the Actions group only", () => {
    const groups = buildGroups(">kill", { sessionItems, actionItems, sessionsLoaded: true });
    expect(groups.map((g) => g.label)).toEqual(["Actions"]);
    expect(groups[0]!.items.map((i) => i.title)).toEqual(["Kill current session"]);
  });

  it("filters + ranks a non-empty query (prefix 'api' before substring 'db-api')", () => {
    const groups = buildGroups("api", { sessionItems, actionItems, sessionsLoaded: true });
    const sessions = groups.find((g) => g.label === "Sessions")!;
    expect(sessions.items.map((i) => i.title)).toEqual(["api", "db-api"]);
    // "web" filtered out; the Actions group (no match) drops out entirely.
    expect(groups.find((g) => g.label === "Actions")).toBeUndefined();
  });

  it("sort is rank-desc then original-index-asc for ties", () => {
    const items = [item("a-session"), item("b-session"), item("session")];
    const groups = buildGroups("session", {
      sessionItems: items,
      actionItems: [],
      sessionsLoaded: true,
    });
    // "session" is an exact match (rank 3) -> first; the two prefixes tie on
    // rank 1 and keep their original order.
    expect(groups[0]!.items.map((i) => i.title)).toEqual([
      "session",
      "a-session",
      "b-session",
    ]);
  });
});

describe("normalizeSearchText", () => {
  it("lowercases and trims", () => {
    expect(normalizeSearchText("  ApI  ")).toBe("api");
    expect(normalizeSearchText(123)).toBe("123");
  });
});
