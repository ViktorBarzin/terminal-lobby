/**
 * The composer while Claude's plan-approval dialog is on the pane.
 *
 * The dialog's fourth row, "Tell Claude what to change", is a text field of its
 * own, and a plain prompt typed at the pane then would land in the open menu
 * (measured on CLI 2.1.281, memory #13896). Viktor decided on 2026-09-24 that
 * the composer is the one text box in the dock: while the plan card is up, its
 * placeholder says what it does and Send types the text into that row as
 * feedback. The card's "Approve with this feedback" sends the same text by
 * another route, through the field's `submitVia`.
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import type { ComponentProps } from "solid-js";
import { Composer, type ComposerSinks } from "../src/components/Composer";
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
  let sinks: ComposerSinks | undefined;
  const r = render(() => (
    <Composer
      pending={[]}
      onSend={async () => true}
      onStop={() => {}}
      onResolve={() => {}}
      register={(s) => (sinks = s)}
      {...props}
    />
  ));
  const field = r.container.querySelector<HTMLTextAreaElement>("textarea")!;
  const send = r.container.querySelector<HTMLButtonElement>(".tl-send")!;
  return { ...r, field, send, sinks: () => sinks! };
};

describe("<Composer> while the plan dialog is up", () => {
  it("says the field answers the plan", () => {
    const { field } = mount({ live: WAITING, planOpen: true, onPlanFeedback: async () => true });
    expect(field.getAttribute("placeholder")).toBe("Tell Claude what to change…");
  });

  it("sends the text as feedback on the plan, never as a prompt", async () => {
    const onSend = vi.fn(async () => true);
    const onPlanFeedback = vi.fn(async () => true);
    const { field, send } = mount({ live: WAITING, planOpen: true, onPlanFeedback, onSend });
    fireEvent.input(field, { target: { value: "use the existing helper" } });
    fireEvent.click(send);
    expect(onPlanFeedback).toHaveBeenCalledWith("use the existing helper");
    expect(onSend).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(field.value).toBe("");
  });

  it("puts the text back when the feedback was refused", async () => {
    const onPlanFeedback = vi.fn(async () => false);
    const { field, send } = mount({ live: WAITING, planOpen: true, onPlanFeedback });
    fireEvent.input(field, { target: { value: "keep this" } });
    fireEvent.click(send);
    await Promise.resolve();
    await Promise.resolve();
    expect(field.value).toBe("keep this");
  });

  it("goes back to an ordinary message the moment the dialog is gone", () => {
    const onSend = vi.fn(async () => true);
    const { field, send } = mount({ onSend, onPlanFeedback: async () => true });
    expect(field.getAttribute("placeholder")).toBe("Ask Claude, or run a command…");
    fireEvent.input(field, { target: { value: "carry on" } });
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledWith("carry on", []);
  });

  it("sends an attachment as its path, as a prompt would carry it", async () => {
    const onPlanFeedback = vi.fn(async (_text: string) => true);
    const { field, send, sinks } = mount({ live: WAITING, planOpen: true, onPlanFeedback });
    fireEvent.input(field, { target: { value: "match this screenshot" } });
    field.setSelectionRange(field.value.length, field.value.length);
    sinks().add([
      {
        path: "/var/lib/clipboard-store/wizard/qa/pasted-20260926-101010-a1.png",
        name: "pasted-20260926-101010-a1.png",
        kind: "image",
      },
    ]);
    await waitFor(() => expect(field.value).toContain("[img]"));
    fireEvent.click(send);
    expect(onPlanFeedback).toHaveBeenCalledTimes(1);
    expect(onPlanFeedback.mock.calls[0]![0]).toBe(
      "match this screenshot /var/lib/clipboard-store/wizard/qa/pasted-20260926-101010-a1.png",
    );
  });

  it("hands the card what it needs for Approve with this feedback", async () => {
    const onPlanFeedback = vi.fn(async () => true);
    const { field, sinks } = mount({ live: WAITING, planOpen: true, onPlanFeedback });
    expect(sinks().hasInput()).toBe(false);
    fireEvent.input(field, { target: { value: "approve, and keep the tests" } });
    expect(sinks().hasInput()).toBe(true);
    const approve = vi.fn(async () => true);
    expect(await sinks().submitVia(approve)).toBe(true);
    expect(approve).toHaveBeenCalledWith("approve, and keep the tests");
    expect(onPlanFeedback).not.toHaveBeenCalled();
    expect(field.value).toBe("");
  });
});

describe("<Composer> hints while the plan dialog is up", () => {
  it("does not say the send queues, because this send answers the dialog", () => {
    // The live row can still say working in the moment before the transcript
    // records the plan call; the send answers the plan either way.
    const { field, send } = mount({
      live: WORKING,
      claudeState: "running",
      planOpen: true,
      onPlanFeedback: async () => true,
    });
    fireEvent.input(field, { target: { value: "smaller steps" } });
    expect(send.getAttribute("aria-label")).toBe("Send");
    expect(send.getAttribute("title")).toBe(
      "Send (Enter). Tells Claude what to change in its plan, and it keeps planning",
    );
  });

  it("still says it queues on an ordinary mid-turn send", () => {
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
      planOpen: true,
      onPlanFeedback: async () => true,
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
    expect(container.querySelector(".tl-ms-pop")).toBeNull();
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
    ["with the plan open", { live: WAITING, planOpen: true, onPlanFeedback: async () => true }],
    ["idle", {}],
  ] as [string, Partial<ComponentProps<typeof Composer>>][])("while %s", (_what, props) => {
    const { send, field } = mount(props);
    fireEvent.input(field, { target: { value: "the next thing" } });
    expect(send.disabled).toBe(false);
  });
});
