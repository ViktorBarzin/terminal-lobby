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
import { render, fireEvent } from "@solidjs/testing-library";
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
    expect(field.getAttribute("placeholder")).toBe("Message…");
    fireEvent.input(field, { target: { value: "carry on" } });
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledWith("carry on", []);
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

describe("Send is never greyed out on a live session", () => {
  it.each([
    ["working", { live: WORKING }],
    ["waiting", { live: WAITING }],
    ["asking", { live: WAITING, asking: true }],
    ["with the plan open", { live: WAITING, planOpen: true, onPlanFeedback: async () => true }],
    ["idle and empty", {}],
  ] as [string, Partial<ComponentProps<typeof Composer>>][])("while %s", (_what, props) => {
    const { send } = mount(props);
    expect(send.disabled).toBe(false);
  });
});
