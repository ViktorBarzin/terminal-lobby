/**
 * Which of 130 entries the `/` menu puts first.
 *
 * Measured on this box 2026-09-04 against a live session: 95 built-ins the page
 * ships plus 34 skills and 1 plugin command from GET /commands/{session}. With
 * every tier weighted the same, typing `/grill` returned `/grill-me`,
 * `/grill-with-docs`, `/grilling`, `/improve-codebase-architecture` and
 * `/publish-page` — the last two because "grill" appears in their descriptions.
 */
import { describe, it, expect } from "vitest";
import {
  commandRank,
  completionFor,
  rankCommands,
  type SlashCommand,
} from "../src/components/compose.logic";

const cmd = (name: string, source: string, description = ""): SlashCommand => ({
  name,
  description,
  source,
});

const names = (c: { items: { value: string }[] } | null): string[] =>
  (c?.items ?? []).map((i) => i.value);

// The real rows, as GET /commands and the built-in table carry them.
const CORPUS: SlashCommand[] = [
  cmd("/grilling", "skill", "Interview the user relentlessly until you reach a shared understanding."),
  cmd("/grill-me", "skill", "Turn the tables and be interviewed."),
  cmd("/grill-with-docs", "skill", "A grilling that ends in a published design doc."),
  cmd("/domain-modeling", "skill", "Build and sharpen a project's domain model."),
  cmd("/doc-tone", "skill", "Tone-only revision pass for a document."),
  cmd(
    "/improve-codebase-architecture",
    "skill",
    "Grill the codebase about its own structure and propose deep modules.",
  ),
  cmd("/publish-page", "skill", "Render a design doc and grill it for tone before publishing."),
  cmd("/superpowers:brainstorming", "plugin", "Diverge then converge on an idea."),
  cmd("/help", "builtin", "Show help and available commands"),
  cmd("/debug", "builtin", "Help diagnose issues"),
  cmd("/doctor", "builtin", "Diagnose and verify your Claude Code installation"),
];

describe("subsequence matching", () => {
  it("finds a skill from the consonants of its name", () => {
    expect(commandRank(cmd("/domain-modeling", "skill"), "/dmod")).toBeGreaterThanOrEqual(0);
    expect(commandRank(cmd("/grilling", "skill"), "/grllng")).toBeGreaterThanOrEqual(0);
  });

  it("does not match letters that are out of order", () => {
    expect(commandRank(cmd("/domain-modeling", "skill"), "/gnilom")).toBe(-1);
  });

  it("ranks a prefix above a subsequence", () => {
    const prefix = commandRank(cmd("/domain-modeling", "skill"), "/domain");
    const sub = commandRank(cmd("/domain-modeling", "skill"), "/dmod");
    expect(prefix).toBeLessThan(sub);
  });

  it("still ranks a description match last", () => {
    const byName = commandRank(cmd("/grilling", "skill", "Interview relentlessly."), "/grill");
    const byDesc = commandRank(cmd("/publish-page", "skill", "…grill it for tone…"), "/grill");
    expect(byName).toBeLessThan(byDesc);
  });
});

describe("rankCommands", () => {
  it("puts the three grill skills before the two description matches", () => {
    const ranked = rankCommands(CORPUS, "/grill").map((c) => c.name);
    expect(ranked.slice(0, 3).sort()).toEqual([
      "/grill-me",
      "/grill-with-docs",
      "/grilling",
    ]);
    expect(ranked).toContain("/publish-page");
    expect(ranked).toContain("/improve-codebase-architecture");
    expect(ranked.indexOf("/publish-page")).toBeGreaterThan(2);
  });

  it("puts a skill above a built-in that matches the same way", () => {
    const both = [cmd("/doctor", "builtin", ""), cmd("/doc-tone", "skill", "")];
    expect(rankCommands(both, "/doc").map((c) => c.name)).toEqual(["/doc-tone", "/doctor"]);
  });

  it("keeps a plugin above a built-in, and below a skill", () => {
    // All three match by prefix, so only provenance separates them. A weaker
    // match still wins on rank — `/superpowers:brainstorming` matches after its
    // namespace, which is tier 1 — so the comparison has to be made at one tier.
    const rows = [
      cmd("/brainstorm-builtin", "builtin", ""),
      cmd("/brainstorm-plugin", "plugin", ""),
      cmd("/brainstorm-skill", "skill", ""),
    ];
    expect(rankCommands(rows, "/brainstorm").map((c) => c.source)).toEqual([
      "skill",
      "plugin",
      "builtin",
    ]);
  });

  it("is stable by name inside one tier and source", () => {
    const rows = [cmd("/zeta", "skill", ""), cmd("/alpha", "skill", "")];
    expect(rankCommands(rows, "/").map((c) => c.name)).toEqual(["/alpha", "/zeta"]);
  });

  it("offers everything for a bare slash", () => {
    expect(rankCommands(CORPUS, "/")).toHaveLength(CORPUS.length);
  });
});

describe("the menu at index 0", () => {
  it("carries the source through so a row can say what it is", () => {
    const c = completionFor("/grill", 6, [], CORPUS);
    expect(c?.items[0]?.source).toBe("skill");
  });

  it("marks where the description-only matches begin", () => {
    const c = completionFor("/grill", 6, [], CORPUS);
    const first = c!.items.findIndex((i) => i.weak);
    expect(first).toBe(3);
    expect(names(c).slice(0, 3)).not.toContain("/publish-page");
  });

  it("marks nothing weak when every match is by name", () => {
    const c = completionFor("/domain", 7, [], CORPUS);
    expect(c!.items.some((i) => i.weak)).toBe(false);
  });
});
