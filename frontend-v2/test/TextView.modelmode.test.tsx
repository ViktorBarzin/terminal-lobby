/**
 * A model switch can move the permission mode, and the button follows it.
 *
 * Deployed review round 4 (2026-09-29): picking Haiku 4.5 from the sheet made
 * Claude Code drop Auto to Manual ("⏸ manual mode on" on the pane), while the
 * model button and the sheet's Mode tick stayed on Auto until a reload. The
 * mode was re-read after Shift+Tab, a mode pick, a turn opening or closing and
 * the view coming on screen, and a model pick is none of those.
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { TextView } from "../src/components/TextView";
import type { SetModeResult } from "../src/lib/mode-api";

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

/**
 * Whether Auto is offered depends on the model, not only on the session's
 * launch flags. Deployed review round 6 (2026-09-30, 0.83.4): Auto refused on
 * Haiku 4.5 stayed greyed out as "Not offered in this session" after the
 * switch back to Opus 5.5, where Claude does offer it, until a reload.
 */
describe("<TextView>: a mode refused on one model is offered again on another", () => {
  const HAIKU = "claude-haiku-4-5-20251001";
  const OPUS = "claude-opus-5-5";
  function mountRefusing() {
    let model = OPUS;
    const notify = vi.fn();
    const onSetMode = vi.fn(async (): Promise<SetModeResult> => {
      if (model === HAIKU) {
        return {
          ok: true,
          reply: { applied: false, reason: "unavailable", mode: "manual", presses: 5 },
        };
      }
      return { ok: true, reply: { applied: true, mode: "auto", presses: 3 } };
    });
    const r = render(() => (
      <TextView
        events={[]}
        pending={[]}
        onSend={async () => true}
        onStop={() => {}}
        onResolve={() => {}}
        harness="claude"
        notify={notify}
        onKeys={async () => true}
        onSetMode={onSetMode}
        onSetModel={async (want) => {
          model = want.model;
          return { ok: true, state: { model: want.model } };
        }}
        onPane={async () => ({ pane: MANUAL, state: "done" })}
      />
    ));
    const btn = () => r.container.querySelector<HTMLElement>(".tl-model-btn")!;
    const row = (sel: string, name: string) =>
      Array.from(document.querySelectorAll<HTMLElement>(sel)).find(
        (b) => b.querySelector(".tl-ms-name")?.textContent === name,
      );
    /** Open the sheet if it is shut, and press a row in it. */
    const press = async (sel: string, name: string) => {
      if (!row(sel, name)) fireEvent.click(btn());
      await waitFor(() => expect(row(sel, name)).toBeDefined());
      fireEvent.click(row(sel, name)!);
    };
    return { ...r, btn, row, press, notify, onSetMode };
  }

  it("greys Auto out on Haiku, names the model, and brings it back on Opus", async () => {
    const v = mountRefusing();
    await waitFor(() => expect(v.btn().getAttribute("data-mode")).toBe("manual"), {
      timeout: 2000,
    });
    await v.press(".tl-ms-model", "Haiku 4.5");
    await waitFor(() => expect(v.btn().textContent).toContain("Haiku 4.5"));
    await v.press(".tl-ms-mode", "Auto");
    await waitFor(() =>
      expect(v.notify).toHaveBeenCalledWith(
        "Auto is not offered on Haiku 4.5, so it stayed on Manual.",
        "warning",
      ),
    );
    if (!v.row(".tl-ms-mode", "Auto")) fireEvent.click(v.btn());
    const auto = () => v.row(".tl-ms-mode", "Auto")!;
    await waitFor(() => expect(auto().getAttribute("aria-disabled")).toBe("true"));
    expect(auto().getAttribute("title")).toBe("Not offered on Haiku 4.5");

    await v.press(".tl-ms-model", "Opus 5.5");
    await waitFor(() => expect(v.btn().textContent).toContain("Opus 5.5"));
    if (!v.row(".tl-ms-mode", "Auto")) fireEvent.click(v.btn());
    await waitFor(() => expect(auto().getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(auto());
    await waitFor(() => expect(v.onSetMode).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(v.btn().getAttribute("data-mode")).toBe("auto"));
  });
});
