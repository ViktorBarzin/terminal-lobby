/**
 * A Codex session names its model on its pane, and the lobby keeps no
 * transcript for it, so the model button read "Model" ("not reported yet")
 * however long the session ran (deployed review rounds 3 to 5, 2026-09-28).
 * Codex draws the model and effort in its header box and again under its
 * input line (codex-cli 0.144.3, sessionio/testdata/status-codex-idle.txt).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { codexModelFromPane } from "../src/lib/models";

const IDLE = readFileSync(
  resolve(process.cwd(), "../sessionio/testdata/status-codex-idle.txt"),
  "utf8",
);

describe("codexModelFromPane", () => {
  it("reads the model and effort codex draws", () => {
    expect(codexModelFromPane(IDLE)).toEqual({ model: "gpt-5.6-terra", effort: "medium" });
  });

  it("reads the line under the input once the header has scrolled away", () => {
    expect(codexModelFromPane("› hello\n\n  gpt-6-astra high · ~/code\n")).toEqual({
      model: "gpt-6-astra",
      effort: "high",
    });
  });

  // codex-cli 0.158.0, installed here on 2026-09-29, spells its model in
  // capitals under the input and draws no "model: … /model to change" line.
  // Deployed review round 1 of the T3 pass saw the button stay on "Model".
  it("reads the capitalised model codex 0.158 draws under its input", () => {
    const pane = readFileSync(
      resolve(process.cwd(), "../sessionio/testdata/status-codex-0158-idle.txt"),
      "utf8",
    );
    expect(codexModelFromPane(pane)).toEqual({ model: "GPT-6-Astra", effort: "medium" });
  });

  it("says nothing for a pane that names no model", () => {
    expect(codexModelFromPane("$ ls\nfoo bar\n")).toBeUndefined();
  });
});
