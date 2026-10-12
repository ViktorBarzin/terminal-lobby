import { describe, expect, it } from "vitest";

import { LOBBY_CLAUDE_MODELS, providerModels } from "../src/models.ts";

describe("providerModels", () => {
  it("lists the catalogue, its first model as the default", () => {
    const rows = providerModels([]);
    expect(rows.map((r) => r.slug)).toEqual(LOBBY_CLAUDE_MODELS.map((m) => m.slug));
    expect(rows.filter((r) => r.isDefault === true).map((r) => r.slug)).toEqual([
      "claude-opus-5-5",
    ]);
  });

  it("adds a model a live session is on that the catalogue lacks, named by its slug", () => {
    const rows = providerModels(["claude-haiku-5-5", "claude-opus-5-5"]);
    expect(rows.map((r) => r.slug)).toEqual([
      ...LOBBY_CLAUDE_MODELS.map((m) => m.slug),
      "claude-haiku-5-5",
    ]);
    expect(rows.at(-1)).toEqual({
      slug: "claude-haiku-5-5",
      name: "claude-haiku-5-5",
      isCustom: false,
      capabilities: { optionDescriptors: [] },
    });
  });
});
