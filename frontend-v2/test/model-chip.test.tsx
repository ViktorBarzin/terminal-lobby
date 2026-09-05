/**
 * The model/effort chip on a live session's composer.
 *
 * What it shows is the SESSION's own reading — off the transcript for Claude,
 * off the pane for codex — and not the composer's stored preference, which is
 * what the NEXT session will start on. The two are different questions, and a
 * chip answering the second while sitting on a running session would be wrong
 * in the way that matters.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { Composer } from "../src/components/Composer";
import type { ModelField, ModelHarness, ModelState } from "../src/lib/models";

afterEach(cleanup);

function mount(o: {
  harness?: ModelHarness;
  model?: ModelState;
  busy?: boolean;
  inertReason?: string;
  onPick?: (field: ModelField, id: string) => void;
}) {
  const { container } = render(() => (
    <Composer
      working={false}
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
    />
  ));
  return container;
}

const chip = (c: HTMLElement) => c.querySelector<HTMLButtonElement>(".tl-model-chip");
const items = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLButtonElement>(".tl-model-item"));
/** A row's own words. The tick shares the button, so it comes off first. */
const label = (b: HTMLButtonElement): string => (b.textContent ?? "").replace("\u2713", "");
const labels = (c: HTMLElement): string[] => items(c).map(label);
const row = (c: HTMLElement, name: string): HTMLButtonElement =>
  items(c).find((b) => label(b) === name)!;

describe("the model chip", () => {
  it("is absent on a session with no model to pick", () => {
    expect(chip(mount({}))).toBeNull();
  });

  it("names the model and the effort the session is on", () => {
    const c = mount({ harness: "claude", model: { model: "claude-opus-5", effort: "max" } });
    expect(chip(c)!.textContent).toBe("opus · max");
  });

  // A session that has not answered yet has written no record naming either, so
  // there is nothing true to show. The word says what tapping does.
  it("says what it is rather than inventing a value", () => {
    const c = mount({ harness: "claude" });
    expect(chip(c)!.textContent).toBe("model");
    expect(chip(c)!.getAttribute("title")).toMatch(/has not answered yet/);
  });

  it("offers the running CLI's own lists", () => {
    const c = mount({ harness: "codex", model: { model: "gpt-5.6-terra", effort: "medium" } });
    fireEvent.click(chip(c)!);
    expect(labels(c)).toContain("GPT-5.6 terra");
    expect(labels(c)).toContain("Ultra");
    // Claude's models and Claude's top step are not codex's.
    expect(labels(c)).not.toContain("Opus");
    expect(labels(c)).not.toContain("Ultracode");
  });

  // "Leave it alone" answers a question only a session that does not exist yet
  // can be asked. This one is already on something.
  it("does not offer the default", () => {
    const c = mount({ harness: "claude" });
    fireEvent.click(chip(c)!);
    expect(labels(c)).not.toContain("Default model");
  });

  it("ticks what the session is on, matching the wire name to the picker's", () => {
    const c = mount({ harness: "claude", model: { model: "claude-sonnet-5", effort: "xhigh" } });
    fireEvent.click(chip(c)!);
    const ticked = items(c)
      .filter((b) => b.getAttribute("aria-checked") === "true")
      .map(label);
    expect(ticked).toEqual(["Sonnet", "Extra high"]);
  });

  it("applies what was picked", () => {
    const onPick = vi.fn();
    const c = mount({ harness: "claude", model: { model: "claude-opus-5" }, onPick });
    fireEvent.click(chip(c)!);
    fireEvent.click(row(c, "Haiku"));
    expect(onPick).toHaveBeenCalledWith("model", "haiku");
  });

  // Driving a picker types into somebody's live pane. Doing that to land on the
  // row it is already on would put a `/model` line in the conversation and
  // change nothing.
  it("does nothing when you pick what it is already on", () => {
    const onPick = vi.fn();
    const c = mount({ harness: "claude", model: { model: "claude-opus-5" }, onPick });
    fireEvent.click(chip(c)!);
    fireEvent.click(row(c, "Opus"));
    expect(onPick).not.toHaveBeenCalled();
  });

  it("is inert while a change is being driven, and while watching", () => {
    expect(chip(mount({ harness: "claude", busy: true }))!.disabled).toBe(true);
    const watching = mount({ harness: "claude", inertReason: "You are watching" });
    expect(chip(watching)!.disabled).toBe(true);
    expect(chip(watching)!.getAttribute("title")).toBe("You are watching");
  });

  // Codex's picker writes its config file — it has no "this session only" key,
  // where Claude's `s` does — so the menu says so rather than leaving it to be
  // discovered by the next session.
  it("warns that a codex change also moves codex's default", () => {
    const codex = mount({ harness: "codex" });
    fireEvent.click(chip(codex)!);
    expect(codex.querySelector(".tl-menu-note")?.textContent).toMatch(/default for new sessions/);

    const claude = mount({ harness: "claude" });
    fireEvent.click(chip(claude)!);
    expect(claude.querySelector(".tl-menu-note")).toBeNull();
  });
});
