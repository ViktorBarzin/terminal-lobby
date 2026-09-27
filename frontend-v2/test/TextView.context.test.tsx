/**
 * The model sheet's "Context N% used" line in an ordinary session.
 *
 * Found live on 2026-09-27: after eight turns the pane's status line read 5%
 * and then 9%, and the sheet had no context line at all until someone ran
 * /context. The line now reads the last settled turn's usage over the window
 * measured for the session's model (context.logic.ts).
 */
import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { TextView } from "../src/components/TextView";
import type { Event } from "../src/types/events";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "qa", ...e });

describe("<TextView> — the sheet's context line", () => {
  it("reads the last turn's usage when nobody has run /context", () => {
    const r = render(() => (
      <TextView
        events={[
          ev({ id: 1, kind: "user", body: "hi" }),
          ev({ id: 2, kind: "meta", meta: "model", model: { model: "claude-opus-5-5", effort: "high" } }),
          ev({ id: 3, kind: "text", body: "hello" }),
          ev({
            id: 4,
            kind: "turn_end",
            usage: { input_tokens: 9, cache_creation_input_tokens: 40_012, cache_read_input_tokens: 50_479 },
          }),
        ]}
        pending={[]}
        onSend={async () => true}
        onStop={() => {}}
        onResolve={() => {}}
        harness="claude"
        onSetModel={async () => ({ ok: true as const, state: {} })}
      />
    ));
    fireEvent.click(r.container.querySelector<HTMLButtonElement>(".tl-model-btn")!);
    expect(document.querySelector(".tl-ms-ctx")?.textContent?.trim()).toBe("Context 9% used");
  });
});
