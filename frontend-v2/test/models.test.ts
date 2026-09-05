import { describe, it, expect } from "vitest";
import {
  DEFAULT_CHOICE,
  effortsFor,
  isEffortFor,
  isModelFor,
  labelFor,
  modelsFor,
  modelHarness,
  phraseFor,
  summarise,
  type ModelHarness,
} from "../src/lib/models";

/**
 * The catalogue behind both pickers: the new-session row, and the chip on a
 * thread. Every list here is what the CLI itself offered on 2026-09-05 — Claude
 * Code 2.1.261 and codex-cli 0.144.3 — read off their own pickers.
 */
describe("the model catalogue", () => {
  it("offers each harness its own models", () => {
    expect(modelsFor("claude").map((m) => m.id)).toEqual([
      "default",
      "opus",
      "sonnet",
      "haiku",
    ]);
    expect(modelsFor("codex").map((m) => m.id)).toEqual([
      "default",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4-mini",
    ]);
  });

  // The ladders are the same six steps up to the top one, where the two CLIs
  // part: Claude's is `ultracode`, codex's is `ultra`. Offering either in the
  // other's list is a change the session refuses.
  it("offers each harness its own effort ladder", () => {
    expect(effortsFor("claude").map((e) => e.id)).toEqual([
      "default",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultracode",
    ]);
    expect(effortsFor("codex").map((e) => e.id)).toEqual([
      "default",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });

  it("validates a stored id against the harness it was stored for", () => {
    expect(isModelFor("claude", "opus")).toBe(true);
    expect(isModelFor("claude", "gpt-5.5")).toBe(false);
    expect(isModelFor("codex", "gpt-5.5")).toBe(true);
    expect(isModelFor("codex", "opus")).toBe(false);
    expect(isEffortFor("claude", "ultracode")).toBe(true);
    expect(isEffortFor("claude", "ultra")).toBe(false);
    expect(isEffortFor("codex", "ultra")).toBe(true);
    expect(isEffortFor("codex", "ultracode")).toBe(false);
  });

  // `default` is the absence of a choice, and it is what every account starts
  // on: nothing is sent and the session keeps whatever it booted with.
  it("treats default as no choice at all", () => {
    expect(DEFAULT_CHOICE).toBe("default");
    for (const h of ["claude", "codex"] as ModelHarness[]) {
      expect(modelsFor(h)[0]!.id).toBe(DEFAULT_CHOICE);
      expect(effortsFor(h)[0]!.id).toBe(DEFAULT_CHOICE);
    }
  });

  // A settings row sits under a heading that says what it sets. The composer's
  // controls have no heading — they are a row of bare values read as one
  // sentence — so the noun travels with the value there and not here.
  it("labels a value for a heading and phrases it for a bare row", () => {
    expect(labelFor("claude", "model", "opus")).toBe("Opus");
    expect(phraseFor("claude", "model", "opus")).toBe("Opus model");
    expect(labelFor("claude", "effort", "xhigh")).toBe("Extra high");
    expect(phraseFor("claude", "effort", "xhigh")).toBe("Extra high effort");
    expect(phraseFor("codex", "model", "default")).toBe("default model");
  });

  it("falls back to the id itself for a value the catalogue has never heard of", () => {
    expect(labelFor("claude", "model", "claude-fable-5")).toBe("claude-fable-5");
  });

  // Which harness a session's tool maps to. A plain shell has no model, and
  // asking for one would open a picker in a bash prompt.
  it("maps a session's tool to a harness, or to none", () => {
    expect(modelHarness("claude")).toBe("claude");
    expect(modelHarness("codex")).toBe("codex");
    expect(modelHarness("shell")).toBeNull();
    expect(modelHarness(undefined)).toBeNull();
  });
});

/**
 * What the chip says. It has room for a few characters beside the permission
 * mode on a 390px screen, so it shows what a person needs to recognise at a
 * glance and nothing else.
 */
describe("the chip's summary", () => {
  it("names the model and the effort together", () => {
    expect(summarise("claude", { model: "claude-opus-5", effort: "max" })).toBe("opus · max");
    expect(summarise("codex", { model: "gpt-5.6-terra", effort: "medium" })).toBe(
      "5.6-terra · medium",
    );
  });

  // The transcript names the model in full — `claude-opus-5` — and a chip is
  // not where a version string belongs.
  it("shortens the wire name to the one a person uses", () => {
    expect(summarise("claude", { model: "claude-sonnet-5" })).toBe("sonnet");
    expect(summarise("claude", { model: "claude-haiku-4-5" })).toBe("haiku");
    expect(summarise("codex", { model: "gpt-5.4-mini" })).toBe("5.4-mini");
  });

  // A session that has not answered yet has said nothing about either, and a
  // chip that invented a value would be showing a guess.
  it("says nothing when the session has not said anything", () => {
    expect(summarise("claude", {})).toBe("");
    expect(summarise("claude", undefined)).toBe("");
  });

  it("shows whichever half it has", () => {
    expect(summarise("claude", { effort: "high" })).toBe("high");
    expect(summarise("claude", { model: "claude-opus-5" })).toBe("opus");
  });
});
