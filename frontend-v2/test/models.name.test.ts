/**
 * What the model button calls a model.
 *
 * The chip it replaced showed the slug verbatim, `claude-opus-5-5 · medium`,
 * and on a phone it ran under Send and read "claude-opus-5-5 · ı" (measured on
 * 0.71.2, memory #13886). The Quiet line prototype shows "Opus 5.5 · High" and
 * moves the slug into the picker and the dial's title. The version stays in
 * the name, so two builds of one family still read as two models, which is
 * what the verbatim rule at models.ts `summarise` was protecting.
 */
import { describe, it, expect } from "vitest";
import { modelName } from "../src/lib/models";

describe("a model's display name", () => {
  it.each([
    ["claude-opus-5-5", "Opus 5.5"],
    ["claude-opus-5", "Opus 5"],
    ["claude-opus-5[1m]", "Opus 5 · 1M"],
    ["claude-sonnet-5", "Sonnet 5"],
    ["claude-opus-4-8", "Opus 4.8"],
    // The date is part of the slug and not of the name; the title keeps it.
    ["claude-haiku-4-5-20251001", "Haiku 4.5"],
  ])("reads %s as %s", (slug, name) => {
    expect(modelName("claude", slug)).toBe(name);
  });

  // Between a /model change and the next turn the only source is the CLI's own
  // receipt, which the server normalises to the family word.
  it("names a bare family word the way the family is written", () => {
    expect(modelName("claude", "opus")).toBe("Opus");
    expect(modelName("claude", "haiku")).toBe("Haiku");
  });

  it("leaves codex's slugs alone, which are already names", () => {
    expect(modelName("codex", "gpt-5.6-terra")).toBe("gpt-5.6-terra");
    expect(modelName("codex", "claude-opus-5")).toBe("claude-opus-5");
  });

  it("passes anything it does not recognise through verbatim", () => {
    expect(modelName("claude", "claude-next-thing-x")).toBe("claude-next-thing-x");
    expect(modelName("claude", "")).toBe("");
  });
});
