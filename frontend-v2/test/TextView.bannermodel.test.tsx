/**
 * A fresh session's model button names the model the pane's banner shows.
 *
 * Found in the T3 pass's live check on 2026-09-28: before Claude's first reply
 * the button read "Model" and its sheet ticked no model and no effort. The
 * transcript is still what counts once it names a model.
 */
import { describe, it, expect } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import { TextView } from "../src/components/TextView";
import type { Event } from "../src/types/events";

const PANE = [
  "▝▜██████▀  claude-opus-5-5 with high effort · Claude API",
  " ▝▝   ▝▝   /var/tmp/proj",
  "─".repeat(40),
  "❯ ",
  "─".repeat(40),
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
].join("\n");

function mount(events: Event[]) {
  let reads = 0;
  const r = render(() => (
    <TextView
      events={events}
      pending={[]}
      onSend={async () => true}
      onStop={() => {}}
      onResolve={() => {}}
      harness="claude"
      onSetModel={async () => ({ ok: true, state: {} })}
      onPane={async () => {
        reads++;
        return { pane: PANE, state: "done" };
      }}
    />
  ));
  const label = () => r.container.querySelector(".tl-model-name")?.textContent ?? "";
  return { ...r, label, reads: () => reads };
}

describe("<TextView>: a fresh session's model", () => {
  it("names the model the banner shows before the transcript does", async () => {
    const { label } = mount([]);
    await waitFor(() => expect(label()).toBe("Opus 5.5"), { timeout: 2000 });
  });

  it("follows the transcript once it names one", async () => {
    const { label, reads } = mount([
      {
        id: 1,
        kind: "meta",
        meta: "model",
        session: "demo",
        model: { model: "claude-sonnet-5", effort: "medium" },
      },
    ]);
    // Past the pane read the view takes as it opens.
    await waitFor(() => expect(reads()).toBeGreaterThanOrEqual(1), { timeout: 2000 });
    await Promise.resolve();
    expect(label()).toBe("Sonnet 5");
  });

  // Deployed review round 2 (2026-09-28): picking an effort on a fresh session
  // put a reading with the effort alone into the transcript, and the button
  // went back to "Model" until Claude's first reply.
  it("keeps the banner's model when the transcript has only an effort", async () => {
    const { label, reads } = mount([
      { id: 1, kind: "meta", meta: "model", session: "demo", model: { effort: "xhigh" } },
    ]);
    await waitFor(() => expect(reads()).toBeGreaterThanOrEqual(1), { timeout: 2000 });
    await waitFor(() => expect(label()).toBe("Opus 5.5"), { timeout: 2000 });
  });
});
