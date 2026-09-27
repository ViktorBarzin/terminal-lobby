/**
 * A pi session's model button reads what the session STAMPED.
 *
 * Claude's model button reads its model off the transcript and codex's off its pane.
 * Pi has neither: the lobby's pi extension stamps the model, the thinking level
 * and the levels that model supports on the pane (`@tl_pi_model`,
 * `@tl_pi_thinking`, `@tl_pi_levels`), and GET /sessions carries them as
 * `piModel`, `piThinking` and `piLevels`. So that is the reading the button
 * starts from, and after a change it holds the session's own reply until the
 * next stamp says something new, the same way a Claude button holds the reply
 * until the transcript does.
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { TextView } from "../src/components/TextView";
import type { ModelState, PiOffer } from "../src/lib/models";
import type { SetModelResult } from "../src/lib/model-api";

const OPUS = "anthropic/claude-opus-5";
const MINI = "openai/gpt-5.4-mini";

function mount(o: { stamp: ModelState | undefined; offer?: PiOffer; reply?: SetModelResult }) {
  const [stamp, setStamp] = createSignal<ModelState | undefined>(o.stamp);
  const onSetModel = vi.fn(
    async (_choice: { model: string; effort: string }): Promise<SetModelResult> =>
      o.reply ?? { ok: true, state: {} },
  );
  const r = render(() => (
    <TextView
      events={[]}
      pending={[]}
      onSend={async () => true}
      onStop={() => {}}
      onResolve={() => {}}
      harness="pi"
      onSetModel={onSetModel}
      stampedModel={stamp()}
      modelOffer={o.offer ?? { models: [OPUS, MINI] }}
    />
  ));
  const dial = () => r.container.querySelector<HTMLButtonElement>(".tl-model-btn");
  /** What the model button shows: the model's name. */
  const shown = () => dial()?.querySelector(".tl-model-name")?.textContent;
  /** The exact model and level, which the button's title carries. */
  const exact = () => dial()?.getAttribute("title");
  const pick = (name: string) => {
    fireEvent.click(dial()!);
    const b = Array.from(document.querySelectorAll<HTMLButtonElement>(".tl-ms-model")).find(
      (x) => x.querySelector(".tl-ms-name")?.textContent === name,
    );
    fireEvent.click(b!);
  };
  return { ...r, shown, exact, pick, setStamp, onSetModel };
}

describe("<TextView> — a pi session's model button", () => {
  it("starts from what the session stamped, having no transcript to read", () => {
    const v = mount({ stamp: { model: OPUS, effort: "high" } });
    expect(v.shown()).toBe(OPUS);
    expect(v.exact()).toBe(`Model and thinking: ${OPUS} · high`);
  });

  it("says it does not know yet when nothing has been stamped", () => {
    const v = mount({ stamp: undefined });
    expect(v.shown()).toBe("Model");
  });

  it("asks the session for the pick and shows what it answered", async () => {
    const v = mount({
      stamp: { model: OPUS, effort: "high" },
      reply: { ok: true, state: { model: MINI, effort: "high" } },
    });
    v.pick(MINI);
    expect(v.onSetModel).toHaveBeenCalledWith({ model: MINI, effort: "" });
    await waitFor(() => expect(v.shown()).toBe(MINI));
  });

  // The reply is a reading taken right after the change. The stamp is the
  // session's own record, and once it moves it is the newer word.
  it("goes back to the stamp once the session stamps something new", async () => {
    const v = mount({
      stamp: { model: OPUS, effort: "high" },
      reply: { ok: true, state: { model: MINI, effort: "high" } },
    });
    v.pick(MINI);
    await waitFor(() => expect(v.exact()).toBe(`Model and thinking: ${MINI} · high`));
    v.setStamp({ model: MINI, effort: "low" });
    await waitFor(() => expect(v.exact()).toBe(`Model and thinking: ${MINI} · low`));
  });

  // A pick the session did not take is said out loud, as it is for Claude:
  // the button must not show a model the session is not on.
  it("keeps showing what the session is on when a pick did not take", async () => {
    const v = mount({
      stamp: { model: OPUS, effort: "high" },
      reply: { ok: true, state: { model: OPUS, effort: "high" } },
    });
    v.pick(MINI);
    await waitFor(() => expect(v.onSetModel).toHaveBeenCalled());
    // The button reads "Switching…" while the change is driven, so this waits
    // for the reply rather than reading the button mid-switch.
    await waitFor(() => expect(v.shown()).toBe(OPUS));
  });
});
