import { describe, it, expect } from "vitest";
import { currentModel } from "../src/components/timeline.logic";
import type { Event, SessionState } from "../src/types/events";
import {
  DEFAULT_CHOICE,
  effortsFor,
  isEffortFor,
  isCurrentModel,
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

  // The MATCHER still normalises, because the menu ticks a catalogue row
  // against whatever spelling the session reported. Only the display stopped
  // shortening.
  it("ticks the catalogue row for a slug, however the session spelled it", () => {
    expect(isCurrentModel("claude", "opus", "claude-opus-5")).toBe(true);
    expect(isCurrentModel("claude", "haiku", "claude-haiku-4-5-20251001")).toBe(true);
    expect(isCurrentModel("claude", "sonnet", "sonnet")).toBe(true);
    expect(isCurrentModel("claude", "opus", "claude-sonnet-5")).toBe(false);
    expect(isCurrentModel("codex", "gpt-5.6-terra", "gpt-5.6-terra")).toBe(true);
    expect(isCurrentModel("codex", "gpt-5.6-terra", "gpt-5.6-luna")).toBe(false);
    expect(isCurrentModel("claude", "opus", undefined)).toBe(false);
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
    expect(summarise({ model: "claude-opus-5", effort: "max" })).toBe(
      "claude-opus-5 · max",
    );
    expect(summarise({ model: "gpt-5.6-terra", effort: "medium" })).toBe(
      "gpt-5.6-terra · medium",
    );
  });

  // The EXACT slug, not the family name. `claude-opus-5` and
  // `claude-haiku-4-5-20251001` are different answers to "which model is this",
  // and the version is the half that a shortened `opus` throws away.
  it("shows the slug the session reported, verbatim", () => {
    expect(summarise({ model: "claude-sonnet-5" })).toBe("claude-sonnet-5");
    expect(summarise({ model: "claude-haiku-4-5-20251001" })).toBe(
      "claude-haiku-4-5-20251001",
    );
    expect(summarise({ model: "gpt-5.4-mini" })).toBe("gpt-5.4-mini");
  });

  // Until the session takes a turn, the only thing that named the model is the
  // CLI's own receipt, which says "Sonnet 5" and normalises to the picker's
  // word. That is what is known, so that is what shows; the slug arrives with
  // the next turn.
  it("shows the picker's word while that is all the session has said", () => {
    expect(summarise({ model: "sonnet", effort: "high" })).toBe("sonnet · high");
  });

  // A session that has not answered yet has said nothing about either, and a
  // chip that invented a value would be showing a guess.
  it("says nothing when the session has not said anything", () => {
    expect(summarise({})).toBe("");
    expect(summarise(undefined)).toBe("");
  });

  it("shows whichever half it has", () => {
    expect(summarise({ effort: "high" })).toBe("high");
    expect(summarise({ model: "claude-opus-5" })).toBe("claude-opus-5");
  });
});

/**
 * What the chip reads. Two sources fold into one answer: the state frame the
 * server computes over the whole log, and the events newer than it.
 */
describe("the model a session is on", () => {
  const meta = (id: number, model: string, effort?: string): Event => ({
    id,
    kind: "meta",
    session: "s",
    meta: "model",
    model: effort ? { model, effort } : { model },
  });
  const seed = (at: number, model?: string, effort?: string): SessionState => ({
    at,
    queue: [],
    prompts: [],
    ...(model ? { model: effort ? { model, effort } : { model } } : {}),
  });

  it("says nothing about a session that has not answered", () => {
    expect(currentModel([], null)).toBeUndefined();
    expect(currentModel([], seed(3))).toBeUndefined();
  });

  it("takes the newest reading in the window", () => {
    const got = currentModel([meta(1, "claude-opus-5", "max"), meta(2, "claude-sonnet-5", "high")]);
    expect(got).toEqual({ model: "claude-sonnet-5", effort: "high" });
  });

  // The state frame is folded over the WHOLE log; the window sits below its
  // cursor, so folding it on top would apply the same readings twice — and on
  // a reverse open the window arrives newest-first, which would land on the
  // OLDEST of them.
  it("prefers the state frame over a window it already accounts for", () => {
    const got = currentModel([meta(2, "claude-opus-5"), meta(1, "claude-haiku-4-5")], seed(5, "claude-sonnet-5"));
    expect(got?.model).toBe("claude-sonnet-5");
  });

  // A change made from the chip is reported by the CLI's own receipt, which
  // the server folds into the state frame — so a reader arriving before the
  // session's next turn sees what it is on, not what it last answered on.
  it("follows a change that has not been answered on yet", () => {
    const got = currentModel([meta(9, "sonnet")], seed(8, "claude-haiku-4-5", "max"));
    expect(got?.model).toBe("sonnet");
  });
});
