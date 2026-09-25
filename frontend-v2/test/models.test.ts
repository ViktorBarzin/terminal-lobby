import { describe, it, expect } from "vitest";
import { currentModel } from "../src/components/timeline.logic";
import type { Event, SessionState } from "../src/types/events";
import {
  adoptModelId,
  chipName,
  DEFAULT_CHOICE,
  effortsFor,
  fieldHeading,
  isEffortFor,
  isCurrentModel,
  isModelFor,
  isPiModelRef,
  labelFor,
  modelFamily,
  modelRequest,
  modelsFor,
  modelHarness,
  optionsFor,
  phraseFor,
  piLevels,
  summarise,
  type ModelHarness,
} from "../src/lib/models";

/**
 * The catalogue behind both pickers: the new-session row, and the chip on a
 * thread.
 *
 * Every Claude id is an EXACT SLUG, measured against `claude --model <slug>` on
 * 2026-09-06 (Claude Code 2.1.263), and every one of them is a row in the CLI's
 * own picker because managed settings declares it (`modelPicker.options`).
 * Codex's ids are what codex-cli 0.153.4 offered, which were already slugs, and
 * each was run through `codex exec -m`. The list gained gpt-6-astra when the
 * box was moved off 0.144.3, where the model did not exist at all.
 */
describe("the model catalogue", () => {
  it("offers each harness its own models", () => {
    expect(modelsFor("claude").map((m) => m.id)).toEqual([
      "default",
      "claude-opus-5-5",
      "claude-opus-5",
      "claude-opus-5[1m]",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-8",
    ]);
    expect(modelsFor("codex").map((m) => m.id)).toEqual([
      "default",
      "gpt-6-astra",
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

  // Both sides are slugs now, so the ordinary answer is the string comparison.
  it("ticks the row whose slug the session reported", () => {
    expect(isCurrentModel("claude", "claude-opus-5", "claude-opus-5")).toBe(true);
    expect(isCurrentModel("claude", "claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001")).toBe(
      true,
    );
    expect(isCurrentModel("claude", "claude-opus-5", "claude-sonnet-5")).toBe(false);
    expect(isCurrentModel("codex", "gpt-5.6-terra", "gpt-5.6-terra")).toBe(true);
    expect(isCurrentModel("codex", "gpt-5.6-terra", "gpt-5.6-luna")).toBe(false);
    expect(isCurrentModel("claude", "claude-opus-5", undefined)).toBe(false);
  });

  // The one window where the two sides cannot agree: between a `/model` change
  // and the session's next turn, the only source is the CLI's own receipt, and
  // on a box whose managed settings have not caught up that receipt still reads
  // "Opus 5" and normalises to `opus` server-side. A word with no version in it
  // means the family's canonical row — never the [1m] variant, never last
  // generation, and never two rows at once.
  it("ticks one row, and the plain one, for a bare family word", () => {
    expect(isCurrentModel("claude", "claude-opus-5-5", "opus")).toBe(true);
    expect(isCurrentModel("claude", "claude-opus-5", "opus")).toBe(false);
    expect(isCurrentModel("claude", "claude-opus-5[1m]", "opus")).toBe(false);
    expect(isCurrentModel("claude", "claude-opus-4-8", "opus")).toBe(false);
    expect(isCurrentModel("claude", "claude-sonnet-5", "sonnet")).toBe(true);
    expect(isCurrentModel("claude", "claude-haiku-4-5-20251001", "haiku")).toBe(true);
    expect(isCurrentModel("claude", "claude-opus-5", "sonnet")).toBe(false);
  });

  // The stored preference gets the same treatment, for the same reason: a doc
  // written before 2026-09-06 says `opus`, and that is a choice somebody made.
  it("carries a stored family word forward to the row it means now", () => {
    expect(adoptModelId("claude", "opus")).toBe("claude-opus-5-5");
    expect(adoptModelId("claude", "haiku")).toBe("claude-haiku-4-5-20251001");
    expect(adoptModelId("claude", "claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(adoptModelId("claude", "default")).toBe("default");
    // A codex id under Claude's key is not a spelling to fix, it is a client
    // that did not know the two lists are different.
    expect(adoptModelId("claude", "gpt-5.5")).toBeUndefined();
    expect(adoptModelId("codex", "gpt-5.5")).toBe("gpt-5.5");
    expect(adoptModelId("codex", "opus")).toBeUndefined();
    expect(adoptModelId("claude", "")).toBeUndefined();
    expect(adoptModelId("claude", 7)).toBeUndefined();
  });

  it("validates a stored id against the harness it was stored for", () => {
    expect(isModelFor("claude", "claude-opus-5")).toBe(true);
    expect(isModelFor("claude", "opus")).toBe(false);
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
    for (const h of ["claude", "codex", "pi"] as ModelHarness[]) {
      expect(modelsFor(h)[0]!.id).toBe(DEFAULT_CHOICE);
      expect(effortsFor(h)[0]!.id).toBe(DEFAULT_CHOICE);
    }
  });

  // A settings row sits under a heading that says what it sets. The composer's
  // controls have no heading — they are a row of bare values read as one
  // sentence — so an EFFORT carries its noun there and not here.
  //
  // A model carries none, in either place. `claude-opus-5` is unmistakably a
  // model, and the word after it was doing no work.
  it("says a slug once and gives an effort its noun", () => {
    expect(labelFor("claude", "model", "claude-opus-5")).toBe("claude-opus-5");
    expect(phraseFor("claude", "model", "claude-opus-5")).toBe("claude-opus-5");
    expect(phraseFor("codex", "model", "gpt-5.6-terra")).toBe("gpt-5.6-terra");
    expect(labelFor("claude", "effort", "xhigh")).toBe("Extra high");
    expect(phraseFor("claude", "effort", "xhigh")).toBe("Extra high effort");
  });

  // The one row that keeps the noun: it has no slug to speak for it, and the
  // two controls sit side by side. A bare "default" beside "default effort"
  // does not say which of the two it is answering.
  it("keeps the noun on the row that has no slug", () => {
    expect(phraseFor("claude", "model", "default")).toBe("default model");
    expect(phraseFor("codex", "model", "default")).toBe("default model");
    expect(phraseFor("claude", "effort", "default")).toBe("default effort");
  });

  // Nothing is offered that the account cannot run. claude-fable-5 sat here for
  // a few hours and starts a Sonnet 5 session instead, so it is out — a row
  // that delivers a different model than it names is worse than no row.
  it("offers no model this account cannot run", () => {
    const ids = modelsFor("claude").map((m) => m.id);
    expect(ids).not.toContain("claude-fable-5");
    expect(ids).not.toContain("claude-sonnet-5[1m]");
  });

  it("falls back to the id itself for a value the catalogue has never heard of", () => {
    expect(labelFor("claude", "model", "claude-mythos-5")).toBe("claude-mythos-5");
  });

  // Which harness a session's tool maps to. A plain shell has no model, and
  // asking for one would open a picker in a bash prompt.
  it("maps a session's tool to a harness, or to none", () => {
    expect(modelHarness("claude")).toBe("claude");
    expect(modelHarness("codex")).toBe("codex");
    expect(modelHarness("pi")).toBe("pi");
    expect(modelHarness("shell")).toBeNull();
    expect(modelHarness(undefined)).toBeNull();
    // A tool a newer server reports and this build has never heard of has no
    // picker here, rather than borrowing one that belongs to somebody else.
    expect(modelHarness("gemini" as never)).toBeNull();
  });
});

/**
 * What the chip says. It has room for a few characters beside the permission
 * mode on a 390px screen, so it shows what a person needs to recognise at a
 * glance and nothing else.
 */
describe("the chip's summary", () => {
  it("names the model and the effort together", () => {
    expect(summarise({ model: "claude-opus-5", effort: "max" })).toBe("claude-opus-5 · max");
    expect(summarise({ model: "gpt-5.6-terra", effort: "medium" })).toBe("gpt-5.6-terra · medium");
  });

  // The EXACT slug, not the family name. `claude-opus-5` and
  // `claude-haiku-4-5-20251001` are different answers to "which model is this",
  // and the version is the half that a shortened `opus` throws away.
  it("shows the slug the session reported, verbatim", () => {
    expect(summarise({ model: "claude-sonnet-5" })).toBe("claude-sonnet-5");
    expect(summarise({ model: "claude-haiku-4-5-20251001" })).toBe("claude-haiku-4-5-20251001");
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
    const got = currentModel(
      [meta(2, "claude-opus-5"), meta(1, "claude-haiku-4-5")],
      seed(5, "claude-sonnet-5"),
    );
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

/**
 * Pi, the third harness. Its models are NOT written down here: pi lists them
 * per OS user from whatever providers that person signed into (ADR-0031), so
 * they reach the pickers from GET /pi-models. Its seven thinking levels are
 * pi's own and the same for everyone, so those are.
 *
 * The rule every case below holds: pi never inherits Claude's saved choice or
 * Claude's rules. A family word that Claude carries forward means nothing to
 * pi, and a reference Claude's catalogue has never heard of is a perfectly
 * good pi model.
 */
describe("pi as a harness", () => {
  const OPUS = "anthropic/claude-opus-5";
  const GPT = "openai/gpt-5.5";

  it("writes down no pi model, only the row that means no choice", () => {
    expect(modelsFor("pi").map((m) => m.id)).toEqual(["default"]);
  });

  it("offers pi's seven thinking levels, in pi's own order", () => {
    expect(effortsFor("pi").map((e) => e.id)).toEqual([
      "default",
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("offers the models pi listed, after the default", () => {
    expect(optionsFor("pi", "model", { models: [OPUS, GPT] }).map((o) => o.id)).toEqual([
      "default",
      OPUS,
      GPT,
    ]);
    // Nothing listed yet, or a user who has not signed in: the default alone,
    // which starts pi on its own choice.
    expect(optionsFor("pi", "model").map((o) => o.id)).toEqual(["default"]);
    expect(optionsFor("pi", "model", { models: [] }).map((o) => o.id)).toEqual(["default"]);
  });

  // The launch argument goes through a shell-side pattern check, so a row the
  // attach would refuse is a row that starts pi on something nobody picked.
  it("leaves out a listed row that is not a model reference, and a repeat", () => {
    const rows = optionsFor("pi", "model", {
      models: [OPUS, "", "has space", "$(reboot)", OPUS, "default", GPT],
    });
    expect(rows.map((o) => o.id)).toEqual(["default", OPUS, GPT]);
  });

  it("names a pi model by its reference, in every place it is written", () => {
    expect(labelFor("pi", "model", OPUS)).toBe(OPUS);
    expect(phraseFor("pi", "model", OPUS)).toBe(OPUS);
    expect(phraseFor("pi", "model", "default")).toBe("default model");
  });

  // Pi's word for it is thinking, and the person reading the composer will
  // meet the same word in pi's own /thinking.
  it("says thinking where the other two say effort", () => {
    expect(labelFor("pi", "effort", "xhigh")).toBe("Extra high");
    expect(phraseFor("pi", "effort", "high")).toBe("High thinking");
    expect(phraseFor("pi", "effort", "off")).toBe("No thinking");
    expect(phraseFor("pi", "effort", "default")).toBe("default thinking");
    expect(fieldHeading("pi", "effort")).toBe("Thinking");
    expect(fieldHeading("claude", "effort")).toBe("Effort");
    expect(fieldHeading("codex", "effort")).toBe("Effort");
    expect(fieldHeading("pi", "model")).toBe("Model");
    expect(chipName("pi")).toBe("Model and thinking");
    expect(chipName("claude")).toBe("Model and effort");
  });

  it("narrows the levels to the ones the session's model supports", () => {
    const rows = optionsFor("pi", "effort", {
      levels: ["off", "minimal", "low", "medium", "high"],
    });
    expect(rows.map((o) => o.id)).toEqual(["default", "off", "minimal", "low", "medium", "high"]);
    // A model with no reasoning stamps `off` and nothing else.
    expect(optionsFor("pi", "effort", { levels: ["off"] }).map((o) => o.id)).toEqual([
      "default",
      "off",
    ]);
  });

  // No stamp yet, or only levels this build has never heard of: offering
  // nothing would leave a picker with no rows, and pi clamps an unsupported
  // level on its own.
  it("offers all seven when the session has said nothing it can use", () => {
    const all = effortsFor("pi").map((o) => o.id);
    expect(optionsFor("pi", "effort").map((o) => o.id)).toEqual(all);
    expect(optionsFor("pi", "effort", { levels: [] }).map((o) => o.id)).toEqual(all);
    expect(optionsFor("pi", "effort", { levels: ["ludicrous"] }).map((o) => o.id)).toEqual(all);
  });

  it("reads the stamped levels off the comma-separated option", () => {
    expect(piLevels("off,minimal,low")).toEqual(["off", "minimal", "low"]);
    expect(piLevels(" low , high ,")).toEqual(["low", "high"]);
    expect(piLevels("")).toEqual([]);
    expect(piLevels(undefined)).toEqual([]);
  });

  // The pattern the attach scripts check the launch argument against
  // (contract item 4), so the two cannot disagree about a reference.
  it("accepts a model reference the attach would pass on, and nothing else", () => {
    for (const ok of [
      OPUS,
      GPT,
      "openrouter/meta-llama/llama-4-maverick:free",
      "ollama/qwen3@q4~k-m",
      "a".repeat(96),
    ]) {
      expect(isPiModelRef(ok), ok).toBe(true);
      expect(isModelFor("pi", ok), ok).toBe(true);
    }
    for (const bad of [
      "",
      "a".repeat(97),
      "/anthropic",
      "-flag",
      "has space",
      "semi;colon",
      "$(reboot)",
      "quote'd",
      "line\nbreak",
      7,
      undefined,
    ]) {
      expect(isPiModelRef(bad), String(bad)).toBe(false);
      expect(isModelFor("pi", bad), String(bad)).toBe(false);
    }
  });

  it("checks a thinking level against pi's own seven", () => {
    for (const ok of ["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(isEffortFor("pi", ok), ok).toBe(true);
    }
    // The other two ladders' top steps are not pi's.
    expect(isEffortFor("pi", "ultracode")).toBe(false);
    expect(isEffortFor("pi", "ultra")).toBe(false);
    // And pi's bottom two are nobody else's.
    expect(isEffortFor("claude", "off")).toBe(false);
    expect(isEffortFor("codex", "minimal")).toBe(false);
  });

  // Claude carries a stored `opus` forward to its canonical slug. To pi that
  // word is either a reference of its own or nothing, never a Claude slug.
  it("keeps a stored reference as it is, with no family word carried forward", () => {
    expect(adoptModelId("pi", OPUS)).toBe(OPUS);
    expect(adoptModelId("pi", "default")).toBe("default");
    expect(adoptModelId("pi", "opus")).toBe("opus");
    expect(adoptModelId("pi", "has space")).toBeUndefined();
    expect(adoptModelId("pi", "")).toBeUndefined();
    expect(adoptModelId("pi", 7)).toBeUndefined();
  });

  it("ticks only the reference the session stamped, never a family match", () => {
    expect(isCurrentModel("pi", OPUS, OPUS)).toBe(true);
    expect(isCurrentModel("pi", OPUS, "Anthropic/Claude-Opus-5")).toBe(true);
    expect(isCurrentModel("pi", OPUS, GPT)).toBe(false);
    // Claude would read a bare family word as its canonical row. Pi does not.
    expect(isCurrentModel("pi", OPUS, "opus")).toBe(false);
    expect(isCurrentModel("pi", OPUS, undefined)).toBe(false);
    expect(modelFamily("pi", OPUS)).toBe(OPUS);
  });

  it("asks for a pi change in pi's name", () => {
    expect(modelRequest("pi", { model: OPUS, effort: "high" })).toEqual({
      tool: "pi",
      model: OPUS,
      effort: "high",
    });
    expect(modelRequest("pi", { model: "default", effort: "default" })).toBeNull();
  });
});
