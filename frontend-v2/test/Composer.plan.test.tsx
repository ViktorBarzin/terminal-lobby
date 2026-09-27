/**
 * The composer while Claude's plan-approval dialog is on the pane.
 *
 * Until the T3 pass the composer was the dialog's feedback row: while the plan
 * card was up its placeholder read "Tell Claude what to change…" and Send
 * typed the text into that row (Viktor, 2026-09-24). Since the T3 pass
 * (prototype 6-plan, approved 2026-09-27) the plan card takes the composer's
 * place and has a "Tell Claude what to change" field of its own
 * (PlanCard.test.tsx, TextView.plan.test.tsx). The composer is hidden behind
 * the card and stays an ordinary message field: the text view refuses a send
 * that still reaches it, so nothing typed here lands in the open plan menu.
 *
 * What stays here is what the composer itself does while a dialog is up: the
 * model button is held, and Send is never greyed out once something is
 * written.
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import type { ComponentProps } from "solid-js";
import { Composer } from "../src/components/Composer";
import type { WorkingRow } from "../src/components/timeline.logic";

const WAITING: WorkingRow = { kind: "working", key: "w", turnKey: "t", steps: 4, waiting: true };
const WORKING: WorkingRow = {
  kind: "working",
  key: "w",
  turnKey: "t",
  tool: "Read",
  toolLabel: "a",
  steps: 4,
};

const mount = (props: Partial<ComponentProps<typeof Composer>> = {}) => {
  const r = render(() => (
    <Composer
      pending={[]}
      onSend={async () => true}
      onStop={() => {}}
      onResolve={() => {}}
      {...props}
    />
  ));
  const field = r.container.querySelector<HTMLTextAreaElement>("textarea")!;
  const send = r.container.querySelector<HTMLButtonElement>(".tl-send")!;
  return { ...r, field, send };
};

describe("<Composer> is an ordinary message field whatever the pane shows", () => {
  it("keeps its placeholder and sends to onSend while Claude waits", () => {
    const onSend = vi.fn(async () => true);
    const { field, send } = mount({ live: WAITING, onSend });
    expect(field.getAttribute("placeholder")).toBe("Ask Claude, or run a command…");
    fireEvent.input(field, { target: { value: "carry on" } });
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledWith("carry on", []);
  });

  it("says a mid-turn send queues", () => {
    const { field, send } = mount({ live: WORKING, claudeState: "running" });
    fireEvent.input(field, { target: { value: "and then this" } });
    expect(send.getAttribute("aria-label")).toBe("Send, queues after this turn");
  });
});

describe("<Composer> model button held while a dialog is up", () => {
  const MODE_REASON = "Answer Claude first: a mode change now would type into the open dialog";
  const MODEL_REASON = "Answer Claude first: a model change now would type into the open dialog";
  const button = (c: HTMLElement) => c.querySelector<HTMLButtonElement>(".tl-model-btn")!;

  it("holds the model button, with the reason as its title, and opens nothing", () => {
    const onPickModel = vi.fn();
    const { container } = mount({
      live: WAITING,
      mode: "manual",
      onCycleMode: () => {},
      modeHeld: MODE_REASON,
      harness: "claude",
      model: { model: "claude-opus-5-5", effort: "medium" },
      onPickModel,
      modelHeld: MODEL_REASON,
    });
    const b = button(container);
    expect(b.getAttribute("aria-disabled")).toBe("true");
    expect(b.getAttribute("title")).toBe(MODEL_REASON);
    expect(b.getAttribute("aria-label")).toContain(MODEL_REASON);
    fireEvent.click(b);
    expect(document.querySelector(".tl-ms-pop")).toBeNull();
  });

  it("holds it for the mode's reason alone, too", () => {
    const { container } = mount({ mode: "manual", onCycleMode: () => {}, modeHeld: MODE_REASON });
    expect(button(container).getAttribute("title")).toBe(MODE_REASON);
  });

  it("leaves the model button free when nothing holds it", () => {
    const { container } = mount({
      harness: "claude",
      model: { model: "claude-opus-5-5", effort: "medium" },
      onPickModel: () => {},
    });
    expect(button(container).getAttribute("aria-disabled")).toBeNull();
  });
});

// Since the T3 pass (2026-09-27) the round button greys out while the field is
// empty and nothing runs (Composer.queue.test.tsx). What stays true is that
// nothing a turn or a dialog is doing withholds Send once something is written.
describe("Send is never greyed out once something is written", () => {
  it.each([
    ["working", { live: WORKING, claudeState: "running" }],
    ["working by the transcript alone", { live: WORKING, claudeState: "done" }],
    ["waiting", { live: WAITING }],
    ["idle", {}],
  ] as [string, Partial<ComponentProps<typeof Composer>>][])("while %s", (_what, props) => {
    const { send, field } = mount(props);
    fireEvent.input(field, { target: { value: "the next thing" } });
    expect(send.disabled).toBe(false);
  });
});
