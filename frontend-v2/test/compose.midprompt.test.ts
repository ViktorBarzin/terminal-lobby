/**
 * `/` mid-prompt.
 *
 * Viktor, 2026-09-04, on the phone: *"it appears but only when not starting the
 * prompt. if it's in the middle of a prompt text then it doesn't show"*. That is
 * `completionFor`'s index-0 guard, which exists so `cd /usr` does not open a
 * command menu, and it behaves the same on a desktop — reproduced at 1280x900
 * and 390x844 the same day.
 *
 * Mid-prompt the menu offers the session's OWN skills and commands and never the
 * 95 built-ins: `/help` inside a sentence means nothing, and the shorter list is
 * what should keep a path from opening a menu.
 */
import { describe, it, expect } from "vitest";
import { completionFor, type SlashCommand } from "../src/components/compose.logic";

const cmd = (name: string, source: string, description = ""): SlashCommand => ({
  name,
  description,
  source,
});

const CORPUS: SlashCommand[] = [
  cmd("/grilling", "skill", "Interview the user relentlessly."),
  cmd("/grill-me", "skill", "Turn the tables."),
  cmd("/grill-with-docs", "skill", "A grilling that ends in a doc."),
  cmd("/domain-modeling", "skill", "Build a domain model."),
  cmd("/implement", "skill", "Work a plan to done."),
  cmd("/cluster-health", "project", "Check the cluster."),
  cmd("/superpowers:brainstorming", "plugin", "Diverge then converge."),
  cmd("/help", "builtin", "Show help and available commands"),
  cmd("/usr-something", "builtin", "A built-in that would match a path"),
  cmd("/init", "builtin", "Initialise a CLAUDE.md"),
];

const names = (c: { items: { value: string }[] } | null): string[] =>
  (c?.items ?? []).map((i) => i.value);

// caret at the end of the text, which is where typing leaves it
const at = (text: string) => completionFor(text, text.length, [], CORPUS);

describe("at index 0, nothing changes", () => {
  it("offers built-ins as well as skills", () => {
    expect(names(at("/"))).toContain("/help");
    expect(names(at("/"))).toContain("/grilling");
  });

  it("still matches a description", () => {
    expect(names(at("/relentlessly"))).toContain("/grilling");
  });
});

describe("mid-prompt", () => {
  it("opens for a skill, which is the whole ask", () => {
    expect(names(at("let's use /gri"))).toEqual([
      "/grill-me",
      "/grill-with-docs",
      "/grilling",
    ]);
  });

  it("stays shut for a path", () => {
    expect(at("cd /usr")).toBeNull();
    expect(at("rm -rf /var/tmp")).toBeNull();
    expect(at("look in /etc")).toBeNull();
  });

  it("stays shut for a built-in, which means nothing inside a sentence", () => {
    expect(at("then run /hel")).toBeNull();
    expect(at("then run /ini")).toBeNull();
  });

  it("does not offer a built-in that happens to match a path", () => {
    // `/usr-something` is a built-in, so `cd /usr` must not surface it.
    expect(at("cd /usr")).toBeNull();
  });

  it("needs two characters, so a single letter cannot open it", () => {
    expect(at("in /g")).toBeNull();
    expect(at("in /gr")).not.toBeNull();
  });

  it("offers a project command and a plugin command too", () => {
    expect(names(at("run /clus"))).toEqual(["/cluster-health"]);
    expect(names(at("try /brainst"))).toEqual(["/superpowers:brainstorming"]);
  });

  it("matches names only, never descriptions", () => {
    // "/relentlessly" is in a description and opens the menu at index 0.
    expect(at("something /relentlessly")).toBeNull();
  });

  it("wants whitespace before the slash, so a path segment is not a trigger", () => {
    expect(at("src/gri")).toBeNull();
    expect(at("~/code/gri")).toBeNull();
  });

  it("completes to the invocation, leaving the rest of the sentence alone", () => {
    const text = "let's design this /dom";
    const c = completionFor(text, text.length, [], CORPUS);
    expect(c?.start).toBe("let's design this ".length);
    expect(c?.items[0]?.value).toBe("/domain-modeling");
  });
});
