/**
 * A pi session's model chip reads what the session STAMPED.
 *
 * Claude's chip reads its model off the transcript and codex's off its pane.
 * Pi has neither: the lobby's pi extension stamps the model, the thinking level
 * and the levels that model supports on the pane (`@tl_pi_model`,
 * `@tl_pi_thinking`, `@tl_pi_levels`), and GET /sessions carries them as
 * `piModel`, `piThinking` and `piLevels`. So that is the reading the chip
 * starts from, and after a change it holds the session's own reply until the
 * next stamp says something new, the same way a Claude chip holds the reply
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
      working={false}
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
  const chip = () => r.container.querySelector<HTMLButtonElement>(".tl-model-chip");
  const pick = (name: string) => {
    fireEvent.click(chip()!);
    const b = Array.from(r.container.querySelectorAll<HTMLButtonElement>(".tl-model-item")).find(
      (x) => (x.textContent ?? "").replace("✓", "") === name,
    );
    fireEvent.click(b!);
  };
  return { ...r, chip, pick, setStamp, onSetModel };
}

describe("<TextView> — a pi session's model chip", () => {
  it("starts from what the session stamped, having no transcript to read", () => {
    const v = mount({ stamp: { model: OPUS, effort: "high" } });
    expect(v.chip()?.textContent).toBe(`${OPUS} · high`);
  });

  it("says it does not know yet when nothing has been stamped", () => {
    const v = mount({ stamp: undefined });
    expect(v.chip()?.textContent).toBe("model");
  });

  it("asks the session for the pick and shows what it answered", async () => {
    const v = mount({
      stamp: { model: OPUS, effort: "high" },
      reply: { ok: true, state: { model: MINI, effort: "high" } },
    });
    v.pick(MINI);
    expect(v.onSetModel).toHaveBeenCalledWith({ model: MINI, effort: "" });
    await waitFor(() => expect(v.chip()?.textContent).toBe(`${MINI} · high`));
  });

  // The reply is a reading taken right after the change. The stamp is the
  // session's own record, and once it moves it is the newer word.
  it("goes back to the stamp once the session stamps something new", async () => {
    const v = mount({
      stamp: { model: OPUS, effort: "high" },
      reply: { ok: true, state: { model: MINI, effort: "high" } },
    });
    v.pick(MINI);
    await waitFor(() => expect(v.chip()?.textContent).toBe(`${MINI} · high`));
    v.setStamp({ model: MINI, effort: "low" });
    await waitFor(() => expect(v.chip()?.textContent).toBe(`${MINI} · low`));
  });

  // A pick the session did not take is said out loud, as it is for Claude:
  // the chip must not show a model the session is not on.
  it("keeps showing what the session is on when a pick did not take", async () => {
    const v = mount({
      stamp: { model: OPUS, effort: "high" },
      reply: { ok: true, state: { model: OPUS, effort: "high" } },
    });
    v.pick(MINI);
    await waitFor(() => expect(v.onSetModel).toHaveBeenCalled());
    expect(v.chip()?.textContent).toBe(`${OPUS} · high`);
  });
});
