/**
 * `/` offers the session's OWN skills and commands, not just the built-ins.
 *
 * Viktor asked for skills and slash commands in text mode (2026-08-17). The
 * shapes here are real: 37 personal skills, 16 from enabled plugins, and 95
 * built-ins, measured on this box by scrolling the CLI's own slash menu and
 * reading every row back.
 */
import { describe, it, expect } from "vitest";
import {
  BUILTIN_COMMANDS,
  commandRank,
  completionFor,
  WEAK_RANK,
  mergeCommands,
  type SlashCommand,
} from "../src/components/compose.logic";

const values = (c: { items: { value: string }[] } | null): string[] =>
  (c?.items ?? []).map((i) => i.value);

const skill = (name: string, description = ""): SlashCommand => ({
  name,
  description,
  source: "skill",
});

describe("the built-in table", () => {
  it("is the set the CLI actually has", () => {
    const names = BUILTIN_COMMANDS.map((c) => c.name);
    // Present in the live menu and missing from the old hand-written list.
    for (const n of ["/btw", "/fork", "/keybindings", "/effort", "/fast", "/goal"]) {
      expect(names, `${n} is a real built-in`).toContain(n);
    }
    // In the old list, gone from the CLI — offering them types something dead.
    for (const n of ["/cost", "/pr-comments", "/review", "/vim"]) {
      expect(names, `${n} is no longer a command`).not.toContain(n);
    }
  });

  it("describes them", () => {
    const undescribed = BUILTIN_COMMANDS.filter((c) => !c.description);
    expect(undescribed, "every built-in carries the CLI's own description").toEqual([]);
  });
});

describe("merging the session's catalogue with the built-ins", () => {
  it("offers both", () => {
    const merged = mergeCommands(BUILTIN_COMMANDS, [skill("/doc-tone", "A tone-only pass")]);
    const names = merged.map((c) => c.name);
    expect(names).toContain("/doc-tone");
    expect(names).toContain("/help");
  });

  it("lets the session's own entry win a name collision", () => {
    // What the CLI would run is the user's, so it is what the menu must describe.
    const merged = mergeCommands(
      [{ name: "/review", description: "built-in", source: "builtin" }],
      [{ name: "/review", description: "mine", source: "command" }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.description).toBe("mine");
    expect(merged[0]!.source).toBe("command");
  });

  it("is sorted, and survives an empty or absent catalogue", () => {
    const merged = mergeCommands([skill("/zeta"), skill("/alpha")], []);
    expect(merged.map((c) => c.name)).toEqual(["/alpha", "/zeta"]);
  });
});

describe("ranking what the menu offers", () => {
  it("puts a name prefix first", () => {
    expect(commandRank(skill("/doc-tone"), "/doc")).toBe(0);
  });

  it("finds a plugin skill by its bare name", () => {
    // Nobody remembers to type the namespace: /brainstorming has to find
    // /superpowers:brainstorming, which is how it is actually spelled.
    expect(commandRank(skill("/superpowers:brainstorming"), "/brain")).toBe(1);
  });

  it("matches inside the name", () => {
    expect(commandRank(skill("/grill-with-docs"), "/docs")).toBe(2);
  });

  it("matches on what a command DOES", () => {
    // The CLI's own menu does this — typing /help there offers /debug, whose
    // description reads "…help diagnose issues".
    expect(commandRank(skill("/debug", "help diagnose issues"), "/help")).toBe(WEAK_RANK);
    expect(commandRank(skill("/debug", "help diagnose issues"), "/zzz")).toBe(-1);
  });

  it("offers everything for a bare slash, so the menu is browsable", () => {
    // On a phone this IS the discovery surface: there is no other way to find
    // out that /wrap-up exists.
    const c = completionFor("/", 1, [], [skill("/a"), skill("/b")]);
    expect(values(c)).toEqual(["/a", "/b"]);
  });
});

describe("`/` completion over a real-shaped catalogue", () => {
  const catalogue = mergeCommands(BUILTIN_COMMANDS, [
    skill("/doc-tone", "A tone-only revision pass"),
    skill("/publish-page", "Publish a page"),
    { name: "/superpowers:brainstorming", description: "Before any creative work", source: "plugin" },
    { name: "/git:sync", description: "Sync the fork", source: "command" },
  ]);

  it("offers a personal skill", () => {
    expect(values(completionFor("/doc", 4, [], catalogue))).toContain("/doc-tone");
  });

  it("offers a namespaced command by its own name", () => {
    expect(values(completionFor("/sync", 5, [], catalogue))).toContain("/git:sync");
  });

  it("ranks the exact prefix above a description match", () => {
    const got = values(completionFor("/publish", 8, [], catalogue));
    expect(got[0]).toBe("/publish-page");
  });

  it("still offers the built-ins when the session has no catalogue of its own", () => {
    expect(values(completionFor("/hel", 4, [], mergeCommands(BUILTIN_COMMANDS, [])))).toContain(
      "/help",
    );
  });
});
