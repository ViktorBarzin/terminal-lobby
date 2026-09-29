/**
 * A Codex session's model button reads the model off codex's pane, and the
 * lobby keeps no transcript for a Codex session, so no turn ever opens or
 * closes to prompt a second reading. Deployed review round 2 of the T3 pass
 * (2026-09-29): a view opened while codex was still on its start-up dialogs
 * ("Cannot use the background server", "Trust this folder?") read "Model"
 * after codex drew "GPT-6-Astra medium" under its input, and only a reload
 * named it. The view keeps reading while it is looked at and has no model.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import { TextView } from "../src/components/TextView";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const DIALOG = "  Cannot use the background server\n\n› 1. Continue without it\n  2. Quit\n";
const READY = "› \n\n  GPT-6-Astra medium · ~/code\n";

function mount(pane: () => string, onScreen = true) {
  const onPane = vi.fn(async () => ({ pane: pane(), state: "idle" }));
  const r = render(() => (
    <TextView
      events={[]}
      pending={[]}
      onSend={async () => true}
      onStop={() => {}}
      onResolve={() => {}}
      harness="codex"
      onPane={onPane}
      onSetModel={async () => ({ ok: true, state: {} })}
      onScreen={onScreen}
    />
  ));
  const shown = () =>
    r.container.querySelector(".tl-model-btn")?.querySelector(".tl-model-name")?.textContent;
  return { ...r, shown, onPane };
}

describe("<TextView> — a Codex session's model button", () => {
  it("names the model codex draws once it is past its start-up dialogs", async () => {
    vi.useFakeTimers();
    let pane = DIALOG;
    const v = mount(() => pane);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(v.shown()).toBe("Model");
    pane = READY;
    await vi.advanceTimersByTimeAsync(10_000);
    // The slug codex's config and the model sheet name it by.
    expect(v.shown()).toBe("gpt-6-astra");
  });

  it("stops reading the pane once it has a model", async () => {
    vi.useFakeTimers();
    const v = mount(() => READY);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(v.shown()).toBe("gpt-6-astra");
    const reads = v.onPane.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(v.onPane.mock.calls.length).toBe(reads);
  });

  it("does not read the pane while the view is not looked at", async () => {
    vi.useFakeTimers();
    const v = mount(() => DIALOG, false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(v.onPane).not.toHaveBeenCalled();
  });
});
