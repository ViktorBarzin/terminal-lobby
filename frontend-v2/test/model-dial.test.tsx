/**
 * The model dial on a live session's composer.
 *
 * What it shows is the SESSION's own reading, off the transcript for Claude
 * and off the pane for codex, and not the composer's stored preference, which
 * is what the NEXT session will start on. The two are different questions, and
 * a dial answering the second while sitting on a running session would be
 * wrong in the way that matters.
 *
 * It was a chip that showed the slug verbatim until the Quiet line composer
 * (2026-09-24). The dial shows a name, "Opus 5.5 · Medium", and the exact slug
 * moves into its title and into the list behind it, where the rows are named
 * the same way with the slug under each.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { Composer } from "../src/components/Composer";
import type { ModelField, ModelHarness, ModelState, PiOffer } from "../src/lib/models";

afterEach(cleanup);

function mount(o: {
  harness?: ModelHarness;
  model?: ModelState;
  busy?: boolean;
  inertReason?: string;
  onPick?: (field: ModelField, id: string) => void;
  offer?: PiOffer;
}) {
  const { container } = render(() => (
    <Composer
      pending={[]}
      mode="manual"
      onCycleMode={() => {}}
      onSend={async () => true}
      onStop={() => {}}
      onResolve={() => {}}
      {...(o.harness ? { harness: o.harness } : {})}
      {...(o.model ? { model: o.model } : {})}
      modelBusy={o.busy === true}
      {...(o.inertReason ? { inertReason: o.inertReason } : {})}
      onPickModel={o.onPick ?? (() => {})}
      {...(o.offer ? { modelOffer: o.offer } : {})}
    />
  ));
  return container;
}

const dial = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('.tl-dial[data-dial="model"]');
const value = (c: HTMLElement) => dial(c)?.querySelector(".tl-dial-value")?.textContent;
const open = (c: HTMLElement) => fireEvent.click(dial(c)!);
const modelRows = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLButtonElement>(".tl-pick-model"));
const effortRows = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLButtonElement>(".tl-effort-seg button"));
const nameOf = (b: HTMLButtonElement) => b.querySelector(".tl-pick-name")?.textContent ?? "";
const labels = (c: HTMLElement): string[] => [
  ...modelRows(c).map((b) => b.querySelector(".tl-pick-slug")?.textContent || nameOf(b)),
  ...effortRows(c).map((b) => b.textContent ?? ""),
];
const row = (c: HTMLElement, name: string): HTMLButtonElement =>
  modelRows(c).find((b) => nameOf(b) === name)!;

describe("the model dial", () => {
  it("is absent on a session with no model to pick", () => {
    expect(dial(mount({}))).toBeNull();
  });

  it("names the model and the effort the session is on, by name", () => {
    const c = mount({ harness: "claude", model: { model: "claude-opus-5-5", effort: "medium" } });
    expect(value(c)).toBe("Opus 5.5 · Medium");
  });

  // The name drops the rest of the slug, so the title carries the whole of it
  // and never a shortened form.
  it("puts the exact slug in the title, however long it is", () => {
    const c = mount({
      harness: "claude",
      model: { model: "claude-haiku-4-5-20251001", effort: "low" },
    });
    expect(value(c)).toBe("Haiku 4.5 · Low");
    expect(dial(c)!.getAttribute("title")).toBe(
      "Model and effort: claude-haiku-4-5-20251001 · low",
    );
  });

  // A session that has not answered yet has written no record naming either,
  // so there is nothing true to show. The word says what pressing it does.
  it("says what it is rather than inventing a value", () => {
    const c = mount({ harness: "claude" });
    expect(value(c)).toBe("Model");
    expect(dial(c)!.hasAttribute("data-unknown")).toBe(true);
    expect(dial(c)!.getAttribute("title")).toMatch(/has not answered yet/);
  });

  it("offers the running CLI's own lists", () => {
    const c = mount({ harness: "codex", model: { model: "gpt-5.6-terra", effort: "medium" } });
    open(c);
    expect(labels(c)).toContain("gpt-5.6-terra");
    expect(labels(c)).toContain("Ultra");
    // Claude's models and Claude's top step are not codex's.
    expect(labels(c)).not.toContain("claude-opus-5");
    expect(labels(c)).not.toContain("Ultracode");
  });

  it("names each model in the list with its slug under it", () => {
    const c = mount({ harness: "claude", model: { model: "claude-opus-5-5" } });
    open(c);
    const opus = row(c, "Opus 5.5");
    expect(opus.querySelector(".tl-pick-slug")?.textContent).toBe("claude-opus-5-5");
  });

  // "Leave it alone" answers a question only a session that does not exist yet
  // can be asked. This one is already on something.
  it("does not offer the default", () => {
    const c = mount({ harness: "claude" });
    open(c);
    expect(labels(c)).not.toContain("Default model");
    expect(labels(c)).not.toContain("Default effort");
  });

  it("ticks what the session is on, matching the wire name to the picker's", () => {
    const c = mount({ harness: "claude", model: { model: "claude-sonnet-5", effort: "xhigh" } });
    open(c);
    const ticked = [...modelRows(c), ...effortRows(c)]
      .filter((b) => b.getAttribute("aria-checked") === "true")
      .map((b) => (b.classList.contains("tl-pick-model") ? nameOf(b) : b.textContent));
    expect(ticked).toEqual(["Sonnet 5", "Extra high"]);
  });

  it("applies what was picked, by its exact slug", () => {
    const onPick = vi.fn();
    const c = mount({ harness: "claude", model: { model: "claude-opus-5" }, onPick });
    open(c);
    fireEvent.click(row(c, "Haiku 4.5"));
    expect(onPick).toHaveBeenCalledWith("model", "claude-haiku-4-5-20251001");
  });

  // Driving a picker types into somebody's live pane. Doing that to land on the
  // row it is already on would put a `/model` line in the conversation and
  // change nothing.
  it("does nothing when you pick what it is already on", () => {
    const onPick = vi.fn();
    const c = mount({ harness: "claude", model: { model: "claude-opus-5" }, onPick });
    open(c);
    fireEvent.click(row(c, "Opus 5"));
    expect(onPick).not.toHaveBeenCalled();
  });

  it("says it is switching while a change is driven, and opens nothing", () => {
    const c = mount({ harness: "claude", busy: true, model: { model: "claude-opus-5" } });
    expect(value(c)).toBe("Switching…");
    expect(dial(c)!.hasAttribute("data-busy")).toBe(true);
    open(c);
    expect(c.querySelector(".tl-dial-pop")).toBeNull();
  });

  it("is held while watching, with the reason as its title", () => {
    const c = mount({ harness: "claude", inertReason: "You are watching" });
    expect(dial(c)!.getAttribute("aria-disabled")).toBe("true");
    expect(dial(c)!.getAttribute("title")).toBe("You are watching");
    open(c);
    expect(c.querySelector(".tl-dial-pop")).toBeNull();
  });

  // Codex's picker writes its config file and has no "this session only" key,
  // where Claude's `s` does, so the list says so rather than leaving it to be
  // discovered by the next session.
  it("warns that a codex change also moves codex's default", () => {
    const codex = mount({ harness: "codex" });
    open(codex);
    expect(codex.querySelector(".tl-dial-pop .tl-pick-note")?.textContent).toMatch(
      /default for new sessions/,
    );
    cleanup();

    const claude = mount({ harness: "claude" });
    open(claude);
    expect(claude.querySelector(".tl-dial-pop .tl-pick-note")?.textContent).not.toMatch(
      /default for new sessions/,
    );
  });
});

/**
 * A pi session's dial. Pi's models are pi's own list (GET /pi-models) and its
 * levels are the ones the session's model supports (the extension's
 * `piLevels` stamp), so both arrive as an offer rather than from the
 * written-down catalogue. The words are pi's: its setting is "thinking".
 */
describe("the model dial on a pi session", () => {
  const OPUS = "anthropic/claude-opus-5";
  const MINI = "openai/gpt-5.4-mini";
  const headings = (c: HTMLElement) =>
    Array.from(c.querySelectorAll(".tl-pick-head")).map((h) => h.textContent?.trim());

  it("offers pi's models and the levels the session's model supports", () => {
    const c = mount({
      harness: "pi",
      model: { model: OPUS, effort: "high" },
      offer: { models: [OPUS, MINI], levels: ["off", "low", "medium", "high"] },
    });
    open(c);
    expect(labels(c)).toEqual([OPUS, MINI, "Off", "Low", "Medium", "High"]);
    expect(headings(c)).toEqual(["Model", "Thinking"]);
  });

  it("offers all seven levels when the session has stamped none", () => {
    const c = mount({ harness: "pi", offer: { models: [OPUS] } });
    open(c);
    expect(labels(c)).toEqual([
      OPUS,
      "Off",
      "Minimal",
      "Low",
      "Medium",
      "High",
      "Extra high",
      "Max",
    ]);
  });

  // A heading over no rows reads like a broken list, which is what pi's model
  // section is before its list arrives.
  it("leaves the model heading out until pi has listed a model", () => {
    const c = mount({ harness: "pi", model: { model: OPUS, effort: "high" } });
    open(c);
    expect(headings(c)).toEqual(["Thinking"]);
    expect(modelRows(c)).toEqual([]);
  });

  it("calls itself what pi calls it", () => {
    const c = mount({ harness: "pi", model: { model: OPUS, effort: "high" } });
    expect(value(c)).toBe(`${OPUS} · High`);
    expect(dial(c)!.getAttribute("title")).toBe(`Model and thinking: ${OPUS} · high`);
    expect(dial(c)!.getAttribute("aria-label")).toMatch(/^Model and thinking: /);
  });

  it("ticks the model and level the session stamped", () => {
    const c = mount({
      harness: "pi",
      model: { model: OPUS, effort: "high" },
      offer: { models: [MINI, OPUS] },
    });
    open(c);
    const ticked = [...modelRows(c), ...effortRows(c)]
      .filter((b) => b.getAttribute("aria-checked") === "true")
      .map((b) => nameOf(b) || b.textContent);
    expect(ticked).toEqual([OPUS, "High"]);
  });

  it("applies what was picked, as pi's own values", () => {
    const onPick = vi.fn();
    const c = mount({
      harness: "pi",
      model: { model: OPUS, effort: "high" },
      offer: { models: [OPUS, MINI] },
      onPick,
    });
    open(c);
    fireEvent.click(row(c, MINI));
    expect(onPick).toHaveBeenCalledWith("model", MINI);
    open(c);
    fireEvent.click(effortRows(c).find((b) => b.textContent === "Minimal")!);
    expect(onPick).toHaveBeenCalledWith("effort", "minimal");
  });
});
