/**
 * A model switch can move the permission mode, and the button follows it.
 *
 * Deployed review round 4 (2026-09-29): picking Haiku 4.5 from the sheet made
 * Claude Code drop Auto to Manual ("⏸ manual mode on" on the pane), while the
 * model button and the sheet's Mode tick stayed on Auto until a reload. The
 * mode was re-read after Shift+Tab, a mode pick, a turn opening or closing and
 * the view coming on screen, and a model pick is none of those.
 */
import { describe, it, expect } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { TextView } from "../src/components/TextView";

const pane = (modeLine: string): string =>
  [
    "▝▜██████▀  claude-opus-5-5 with high effort · Claude API",
    "─".repeat(40),
    "❯ ",
    "─".repeat(40),
    modeLine,
  ].join("\n");
const AUTO = pane("  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents");
const MANUAL = pane("  ⏸ manual mode on (shift+tab to cycle) · ← for agents");

function mount() {
  let current = AUTO;
  let reads = 0;
  const r = render(() => (
    <TextView
      events={[]}
      pending={[]}
      onSend={async () => true}
      onStop={() => {}}
      onResolve={() => {}}
      harness="claude"
      onKeys={async () => true}
      onSetModel={async (want) => {
        // Claude answers the switch, and the switch took Auto away.
        current = MANUAL;
        return { ok: true, state: { model: want.model } };
      }}
      onPane={async () => {
        reads++;
        return { pane: current, state: "done" };
      }}
    />
  ));
  const btn = () => r.container.querySelector<HTMLElement>(".tl-model-btn")!;
  return { ...r, btn, reads: () => reads };
}

describe("<TextView>: a model pick re-reads the mode", () => {
  it("shows Manual once Claude drops Auto on a switch to Haiku", async () => {
    const { btn, reads } = mount();
    await waitFor(() => expect(btn().getAttribute("data-mode")).toBe("auto"), { timeout: 2000 });
    const before = reads();
    fireEvent.click(btn());
    const haiku = Array.from(document.querySelectorAll<HTMLElement>(".tl-ms-model")).find(
      (b) => b.querySelector(".tl-ms-name")?.textContent === "Haiku 4.5",
    );
    expect(haiku).toBeDefined();
    fireEvent.click(haiku!);
    await waitFor(() => expect(btn().getAttribute("data-mode")).toBe("manual"), {
      timeout: 3000,
    });
    expect(reads()).toBeGreaterThan(before);
  });
});
